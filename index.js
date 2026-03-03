const { TelegramClient } = require('telegram');
const { StoreSession, StringSession } = require('telegram/sessions'); // <-- добавили StringSession

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

const STRING_SESSION = process.env.STRING_SESSION; // <-- новое

const session = STRING_SESSION
    ? new StringSession(STRING_SESSION)
    : new StoreSession("saved_session");

const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    catchUp: true,
});

const { Telegraf } = require('telegraf');
const readline = require('readline'); // Built-in Node.js module

const { fuzzyMatchRussian } = require('./keyphrase-matcher');

// Configuration

const BOT_TOKEN = process.env.BOT_TOKEN;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const KEYPHRASES = process.env.KEYPHRASES.split(',').map(keyword => keyword.trim());
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;



console.log(`using KEYPHRASES: ${KEYPHRASES}`);

//const storeSession = new StoreSession("saved_session");
const bot = new Telegraf(BOT_TOKEN);




// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Utility function to get user input
const getUserInput = (question) => {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
};

(async () => {
    await client.connect();

    if (!(await client.isUserAuthorized())) {
        await client.start({
            phoneNumber: PHONE_NUMBER,
            password: async () => await getUserInput('Password: '),
            phoneCode: async () => await getUserInput('Code: '),
            onError: (err) => console.error(err),
        });
    }


    // Close readline interface after authentication
    rl.close();

    client.session.save();





    // === CONFIG ===
    const POLL_INTERVAL_MS = 30_000;     // как часто делать 1 запрос (общий цикл)
    const DIALOG_REFRESH_MS = 10 * 60_000; // как часто обновлять список чатов
    const MESSAGES_LIMIT = 50;           // сколько последних сообщений читать
    const CHATS_PER_TICK = 2;            // сколько чатов проверять за 1 тик (чтобы не спамить API)

// исключим мониторинг-чат
    const MONITOR_CHAT_ID = process.env.TARGET_CHAT_ID?.toString?.();

// Храним состояние по чатам
    const state = new Map(); // chatId -> { lastSeenId, title }

// Список чатов для обхода
    let chatQueue = [];
    let queueIndex = 0;

    function isUsefulDialog(d) {
        // d может быть разного типа, но обычно есть id/title/isUser/isChannel/isGroup
        const id = d?.id?.toString?.();
        if (!id) return false;

        // не мониторим чат, куда отправляем уведомления
        if (MONITOR_CHAT_ID && id === MONITOR_CHAT_ID) return false;

        // можно отключить лички (если хочешь мониторить только группы/каналы)
        // if (d.isUser) return false;

        // можно отключить ботов/служебные
        // if (d.entity?.bot) return false;

        return true;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function parseFloodWaitSeconds(err) {
        const msg = (err?.message || String(err) || "").toUpperCase();

        // Частый формат в GramJS: "FLOOD_WAIT_17"
        let m = /FLOOD_WAIT_(\d+)/.exec(msg);
        if (m) return parseInt(m[1], 10);

        // Иногда бывает: "A wait of 17 seconds is required"
        m = /WAIT OF (\d+) SECONDS/.exec(msg);
        if (m) return parseInt(m[1], 10);

        // Иногда: "retry after 17"
        m = /RETRY AFTER (\d+)/.exec(msg);
        if (m) return parseInt(m[1], 10);

        return 0;
    }

    async function refreshDialogs(client) {
        let dialogs;
        try {
            dialogs = await client.getDialogs({ limit: 500 });
        } catch (e) {
            const wait = parseFloodWaitSeconds(e);
            if (wait) {
               // console.log(`FLOOD_WAIT ${wait}s on getDialogs`);
                await sleep((wait + 1) * 1000);
                return;
            }
            throw e;
        }
        const filtered = dialogs.filter(isUsefulDialog);

        // обновляем очередь
        chatQueue = filtered.map(d => ({
            id: d.id,                       // важно: именно d.id (peer id)
            idStr: d.id?.toString?.(),
            title: d.title || d.name || "Untitled",
        }));

        // добавим в state те, которых не было
        for (const c of chatQueue) {
            if (!state.has(c.idStr)) {
                state.set(c.idStr, { lastSeenId: 0, title: c.title });
            } else {
                // обновим title (на случай переименований)
                state.get(c.idStr).title = c.title;
            }
        }

        // удалим из state те, из которых вышла
        const ids = new Set(chatQueue.map(c => c.idStr));
        for (const k of Array.from(state.keys())) {
            if (!ids.has(k)) state.delete(k);
        }

    }

    function buildChatAndMessageLinks(chatId, chatUsername, messageId) {
        // Если у чата есть username — можно сделать публичные ссылки
        if (chatUsername) {
            return {
                chatLink: `https://t.me/${chatUsername}`,
                messageLink: `https://t.me/${chatUsername}/${messageId}`,
            };
        }

        // Иначе делаем внутренний формат /c/ (работает для супергрупп/каналов)
        // chatId обычно вида -1001687600120 -> нужно 1687600120
        const idStr = String(chatId);
        const internalId = idStr.startsWith("-100") ? idStr.slice(4) : String(Math.abs(Number(chatId)));

        return {
            chatLink: `https://t.me/c/${internalId}`,
            messageLink: `https://t.me/c/${internalId}/${messageId}`,
        };
    }

    function escapeHtml(s) {
        return String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
    }

    async function pollOneChat(client, chat, KEYPHRASES, bot, TARGET_CHAT_ID) {
        const s = state.get(chat.idStr) || { lastSeenId: 0, title: chat.title };

        const MAX_TO_PROCESS_PER_CHAT = 200; // защита от "шумных" чатов
        const PAGE_LIMIT = MESSAGES_LIMIT;   // например 30-50 лучше чем 10

        // первый проход: ставим lastSeenId на последнее сообщение и не шлём историю
        if (s.lastSeenId === 0) {
            const initMsgs = await client.getMessages(chat.id, { limit: PAGE_LIMIT, offsetId: 0 });
            if (!initMsgs?.length) return;

            // возьмём самый старый из этой пачки как стартовую точку,
            // чтобы на первом проходе не пропустить недавние сообщения
            const oldest = initMsgs[initMsgs.length - 1].id;
            s.lastSeenId = oldest - 1;
            state.set(chat.idStr, s);

           // console.log(`INIT (with backlog) ${chat.title}: startFrom=${s.lastSeenId}`);
            // НЕ return — пусть дальше обработает fresh из этой же пачки
        }

        let processed = 0;
        let offsetId = 0; // 0 = начать с самых новых

        // собираем новые сообщения, пока не дойдём до lastSeenId или лимита
        while (processed < MAX_TO_PROCESS_PER_CHAT) {
            let msgs;
            try {
                msgs = await client.getMessages(chat.id, { limit: PAGE_LIMIT, offsetId  });

                } catch (e) {
                const wait = parseFloodWaitSeconds(e);
                if (wait) {
                   // console.log(`FLOOD_WAIT ${wait}s on getMessages (${chat.title})`);
                    await sleep((wait + 1) * 1000);
                    return; // этот чат пропускаем до следующего тика
                }
                throw e; // не FloodWait — пусть ловится выше
            }
            if (!msgs || msgs.length === 0) break;

            // msgs идут от новых к старым
            const newestId = msgs[0].id;
            const oldestId = msgs[msgs.length - 1].id;

            // берём только те, что новее lastSeenId
            const fresh = msgs.filter(m => m.id > s.lastSeenId);
            // обработаем от старых к новым
            fresh.sort((a, b) => a.id - b.id);

            for (const m of fresh) {
                const text = typeof m?.message === "string" ? m.message.toLowerCase() : "";
                if (!text) continue;               // пропускаем не-текст (стикеры/фото/сервисные)
                if (!Array.isArray(KEYPHRASES) || KEYPHRASES.length === 0) continue;

                let matched = [];
                try {
                    matched = fuzzyMatchRussian(text, KEYPHRASES);
                } catch (e) {
                  //  console.log("WARN fuzzyMatch failed:", e?.message || e, {
                  //      chat: chat?.title,
                  //      chatId: chat?.idStr,
                  //      msgId: m?.id,
                  //      textType: typeof m?.message,
                  //  });
                    continue; // не валим весь polling из-за одного сообщения
                }

                if (!matched.length) continue;

                const short = (m.message || "").slice(0, 300);

                try {
                    // === sender ===
                    let username = "not available";
                    let fullName = "Unknown";

                    try {
                        const sender = await m.getSender().catch(() => null);

                        if (sender) {
                            username = sender.username || "not available";
                            fullName =
                                [sender.firstName, sender.lastName].filter(Boolean).join(" ") || "Unknown";
                        }
                    } catch (_) {}

// === chat ===
                    let chatTitle = s.title || "Unknown chat";
                    let chatUsername = null;
                    let chatId = chat.idStr; // строка вида "-100...."

                    try {
                        const chatEntity = await client.getEntity(chat.id).catch(() => null);
                        // у каналов/групп может быть username
                        chatUsername = chatEntity?.username || null;
                        // на всякий случай уточним заголовок
                        chatTitle = chatEntity?.title || chatTitle;
                    } catch (_) {}

// === links ===
                    const { chatLink, messageLink } = buildChatAndMessageLinks(chatId, chatUsername, m.id);

// === matched pretty ===
                    const matchedText = matched
                        .map(x => `${escapeHtml(x.phrase)} (${Number(x.score).toFixed(3)})`)
                        .join(", ");

// === message preview ===
                    const shortSafe = escapeHtml(short);

// === HTML message ===
                    const textMsg =
                        `<b>Keyword found:</b> ${matchedText}\n` +
                        `<b>Username:</b> @${escapeHtml(username)}\n` +
                        `<b>Full user name:</b> ${escapeHtml(fullName)}\n` +
                        `<b>Message link:</b> <a href="${messageLink}">Find message</a>\n` +
                        `<b>Channel/Group title:</b> ${escapeHtml(chatTitle)}\n` +
                        `<b>Channel/Group link:</b> <a href="${chatLink}">${escapeHtml(chatLink)}</a>\n` +
                        `<b>Text:</b> ${shortSafe}`;

                    await client.sendMessage(TARGET_CHAT_ID, {
                        message: textMsg,
                        parseMode: "html",
                        linkPreview: false,
                    });
                } catch (e) {
                    const wait = parseFloodWaitSeconds(e);
                    if (wait) {
                       // console.log(`FLOOD_WAIT ${wait}s on sendMessage`);
                        await sleep((wait + 1) * 1000);
                        return;
                    }
                  //  console.log("sendMessage error:", e?.message || e);
                }
            }

            if (fresh.length) {
                s.lastSeenId = Math.max(s.lastSeenId, fresh[fresh.length - 1].id);
                processed += fresh.length;
                state.set(chat.idStr, s);
            }

            // если самый старый из полученных всё ещё новее lastSeenId,
            // значит новых сообщений больше, чем PAGE_LIMIT — двигаем offsetId дальше (в прошлое)
            if (oldestId > s.lastSeenId) {
                offsetId = oldestId;
                continue;
            }

            // мы дошли до зоны <= lastSeenId, дальше не надо
            break;
        }

        if (processed >= MAX_TO_PROCESS_PER_CHAT) {
       //     console.log(`poll warn: chat "${s.title}" too many new msgs, capped at ${MAX_TO_PROCESS_PER_CHAT}`);
        }
    }

    async function startPollingAllChats({ client, KEYPHRASES, bot, TARGET_CHAT_ID }) {
        await refreshDialogs(client);
       // console.log("Starting first poll tick...");
        for (let i = 0; i < CHATS_PER_TICK && chatQueue.length; i++) {
            const chat = chatQueue[queueIndex % chatQueue.length];
            queueIndex++;
           // console.log(`TICK: polling ${chat.title} (${chat.idStr}) lastSeen=${state.get(chat.idStr)?.lastSeenId || 0}`);
            await pollOneChat(client, chat, KEYPHRASES, bot, TARGET_CHAT_ID);
        }
        setInterval(() => refreshDialogs(client).catch(console.error), DIALOG_REFRESH_MS);

        setInterval(async () => {
            if (!chatQueue.length) return;

            // проверяем CHATS_PER_TICK чатов за один тик
            for (let i = 0; i < CHATS_PER_TICK; i++) {
                const chat = chatQueue[queueIndex % chatQueue.length];
                queueIndex++;

                try {
                 //   console.log(`TICK: polling ${chat.title} (${chat.idStr}) lastSeen=${state.get(chat.idStr)?.lastSeenId || 0}`);
                    await pollOneChat(client, chat, KEYPHRASES, bot, TARGET_CHAT_ID);
                } catch (e) {
                    const msg = e?.message || String(e);

                    // Если Telegram вернул FloodWait (иногда в тексте “FLOOD_WAIT_X”)
                    // можно сделать паузу/уменьшить частоту.
                }
            }
        }, POLL_INTERVAL_MS);
    }






    process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
    process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

    (async () => {
        try {
            await client.connect();

            if (!(await client.isUserAuthorized())) {
                await client.start({
                    phoneNumber: PHONE_NUMBER,
                    password: async () => await getUserInput("Password: "),
                    phoneCode: async () => await getUserInput("Code: "),
                    onError: (err) => console.error(err),
                });
            }

            rl.close();
            client.session.save();

            console.log("Userbot started and polling init...");

            // ✅ СНАЧАЛА запускаем polling (без await)
            startPollingAllChats({ client, KEYPHRASES, bot, TARGET_CHAT_ID })
                .catch((e) => console.error("startPollingAllChats failed:", e));

            // ✅ проверка Bot API (если используешь telegraf)
            try {
                const me = await bot.telegram.getMe();
                console.log("BOT API OK, bot:", me.username);
            } catch (e) {
                console.error("BOT API FAIL:", e?.message || e);
            }

            // ✅ запуск telegraf (тоже без await)
            bot.launch()
                .then(() => console.log("Telegraf bot launched"))
                .catch((e) => console.error("Telegraf launch failed:", e));

        } catch (e) {
           // console.error("FATAL in main:", e);
            process.exit(1);
        }
    })();

})();
