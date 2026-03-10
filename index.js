const { TelegramClient } = require("telegram");
const { StoreSession, StringSession } = require("telegram/sessions");
const readline = require("readline");
const { fuzzyMatchRussian } = require("./keyphrase-matcher");
const fs = require("fs");
const path = require("path");

const STATE_FILE = process.env.STATE_FILE || "/data/state.json";



// =========================
// Config
// =========================
const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const STRING_SESSION = process.env.STRING_SESSION;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

// Безопасная подготовка ключевых фраз
const KEYPHRASES = (process.env.KEYPHRASES || "")
    .split(",")
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

console.log(`KEYPHRASES count: ${KEYPHRASES.length}`);

const session = STRING_SESSION
    ? new StringSession(STRING_SESSION)
    : new StoreSession("saved_session");

const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    catchUp: true,
});

// =========================
// Runtime settings
// =========================
const POLL_INTERVAL_MS = 30_000;          // общий цикл polling
const DIALOG_REFRESH_MS = 10 * 60_000;    // обновление списка чатов
const MESSAGES_LIMIT = 50;                // сколько последних сообщений читать за страницу
const CHATS_PER_TICK = 2;                 // сколько чатов проверять за тик
const MAX_TO_PROCESS_PER_CHAT = 200;      // защита от очень шумных чатов
const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;
const STATE_SAVE_INTERVAL_MS = 10 * 60 * 1000; // раз в 10 минут

// =========================
// Helpers
// =========================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function getUserInput(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer));
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFloodWaitSeconds(err) {
    const msg = (err?.message || String(err) || "").toUpperCase();

    let m = /FLOOD_WAIT_(\d+)/.exec(msg);
    if (m) return parseInt(m[1], 10);

    m = /WAIT OF (\d+) SECONDS/.exec(msg);
    if (m) return parseInt(m[1], 10);

    m = /RETRY AFTER (\d+)/.exec(msg);
    if (m) return parseInt(m[1], 10);

    return 0;
}

function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function buildChatAndMessageLinks(chatId, chatUsername, messageId) {
    if (chatUsername) {
        return {
            chatLink: `https://t.me/${chatUsername}`,
            messageLink: `https://t.me/${chatUsername}/${messageId}`,
        };
    }

    const idStr = String(chatId);
    const internalId = idStr.startsWith("-100")
        ? idStr.slice(4)
        : String(Math.abs(Number(chatId)));

    return {
        chatLink: `https://t.me/c/${internalId}`,
        messageLink: `https://t.me/c/${internalId}/${messageId}`,
    };
}

function logMemory() {
    const m = process.memoryUsage();
    console.log("MEMORY", {
        rssMB: Math.round(m.rss / 1024 / 1024),
        heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(m.heapTotal / 1024 / 1024),
        externalMB: Math.round(m.external / 1024 / 1024),
    });
}

function ensureStateDirExists() {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadStateFromFile() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            console.log(`STATE: file not found, starting fresh -> ${STATE_FILE}`);
            return new Map();
        }

        const raw = fs.readFileSync(STATE_FILE, "utf8");
        if (!raw.trim()) {
            console.log(`STATE: file empty, starting fresh -> ${STATE_FILE}`);
            return new Map();
        }

        const obj = JSON.parse(raw);

        // obj ожидается как { [chatId]: { lastSeenId, title, username } }
        const map = new Map();
        for (const [chatId, value] of Object.entries(obj)) {
            map.set(chatId, value);
        }

        console.log(`STATE: loaded ${map.size} chats from ${STATE_FILE}`);
        return map;
    } catch (e) {
        console.error("STATE: load failed:", e);
        return new Map();
    }
}

function saveStateToFile(stateMap) {
    try {
        ensureStateDirExists();

        const obj = Object.fromEntries(stateMap.entries());
        fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");

        console.log(`STATE: saved ${stateMap.size} chats to ${STATE_FILE}`);
    } catch (e) {
        console.error("STATE: save failed:", e);
    }
}

// =========================
// State
// =========================
const MONITOR_CHAT_ID = String(TARGET_CHAT_ID ?? "");
const state = loadStateFromFile();
let chatQueue = [];
let queueIndex = 0;

let isPolling = false;
let isRefreshingDialogs = false;

// =========================
// Dialog filters
// =========================
function isUsefulDialog(d) {
    const id = d?.id?.toString?.();
    if (!id) return false;

    // не мониторим чат, куда отправляем уведомления
    if (MONITOR_CHAT_ID && id === MONITOR_CHAT_ID) return false;

    // при желании можно отключить лички:
    // if (d.isUser) return false;

    return true;
}

// =========================
// Core functions
// =========================
async function refreshDialogs() {
    let dialogs;
    try {
        dialogs = await client.getDialogs({ limit: 500 });
    } catch (e) {
        const wait = parseFloodWaitSeconds(e);
        if (wait) {
            console.log(`FLOOD_WAIT ${wait}s on getDialogs`);
            await sleep((wait + 1) * 1000);
            return;
        }
        throw e;
    }

    const filtered = dialogs.filter(isUsefulDialog);

    // Стараемся не тащить тяжёлые сущности в очередь — только простые поля
    chatQueue = filtered.map((d) => ({
        id: d.id,
        idStr: d.id?.toString?.(),
        title: d.title || d.name || "Untitled",
        username: d.entity?.username || null, // кэшируем username один раз здесь
    }));

    for (const c of chatQueue) {
        if (!state.has(c.idStr)) {
            state.set(c.idStr, {
                lastSeenId: 0,
                title: c.title,
                username: c.username,
            });
        } else {
            const prev = state.get(c.idStr);
            prev.title = c.title;
            prev.username = c.username;
            state.set(c.idStr, prev);
        }
    }

    const ids = new Set(chatQueue.map((c) => c.idStr));
    for (const k of Array.from(state.keys())) {
        if (!ids.has(k)) state.delete(k);
    }

    console.log(`Dialogs refreshed: ${chatQueue.length}`);
    saveStateToFile(state);
}

async function sendMatchNotification(chat, matched, msgObj, shortText) {
    const st = state.get(chat.idStr) || {};
    const chatTitle = st.title || chat.title || "Unknown chat";
    const chatUsername = st.username || null;
    const chatId = chat.idStr;

    // sender
    let username = "not available";
    let fullName = "Unknown";

    try {
        const sender = await msgObj.getSender().catch(() => null);
        if (sender) {
            username = sender.username || "not available";
            fullName =
                [sender.firstName, sender.lastName].filter(Boolean).join(" ") || "Unknown";
        }
    } catch (_) {}

    const { chatLink, messageLink } = buildChatAndMessageLinks(
        chatId,
        chatUsername,
        msgObj.id
    );

    const matchedText = matched
        .map((x) => `${escapeHtml(x.phrase)} (${Number(x.score).toFixed(3)})`)
        .join(", ");

    const shortSafe = escapeHtml(shortText);

    const textMsg =
        `<b>Keyword found:</b> ${matchedText}\n` +
        `<b>Username:</b> @${escapeHtml(username)}\n` +
        `<b>Full user name:</b> ${escapeHtml(fullName)}\n` +
        `<b>Message link:</b> <a href="${messageLink}">Find message</a>\n` +
        `<b>Channel/Group title:</b> ${escapeHtml(chatTitle)}\n` +
        `<b>Channel/Group link:</b> <a href="${chatLink}">${escapeHtml(chatLink)}</a>\n` +
        `<b>Text:</b> ${shortSafe}`;

    try {
        await client.sendMessage(TARGET_CHAT_ID, {
            message: textMsg,
            parseMode: "html",
            linkPreview: false,
        });
    } catch (e) {
        const wait = parseFloodWaitSeconds(e);
        if (wait) {
            console.log(`FLOOD_WAIT ${wait}s on sendMessage`);
            await sleep((wait + 1) * 1000);
            return;
        }
        console.log("sendMessage error:", e?.message || e);
    }
}

async function pollOneChat(chat) {
    const s = state.get(chat.idStr) || {
        lastSeenId: 0,
        title: chat.title,
        username: chat.username || null,
    };

    const PAGE_LIMIT = MESSAGES_LIMIT;

    // Первичная инициализация: запоминаем стартовую точку с небольшим backlog
    if (s.lastSeenId === 0) {
        try {
            const initMsgs = await client.getMessages(chat.id, {
                limit: PAGE_LIMIT,
                offsetId: 0,
            });
            if (!initMsgs?.length) return;

            const oldest = initMsgs[initMsgs.length - 1].id;
            s.lastSeenId = oldest - 1;
            state.set(chat.idStr, s);

            console.log(`INIT ${chat.title}: startFrom=${s.lastSeenId}`);
        } catch (e) {
            const wait = parseFloodWaitSeconds(e);
            if (wait) {
                console.log(`FLOOD_WAIT ${wait}s on init getMessages (${chat.title})`);
                await sleep((wait + 1) * 1000);
                return;
            }
            throw e;
        }
    }

    let processed = 0;
    let offsetId = 0;

    while (processed < MAX_TO_PROCESS_PER_CHAT) {
        let msgs;
        try {
            msgs = await client.getMessages(chat.id, {
                limit: PAGE_LIMIT,
                offsetId,
            });
        } catch (e) {
            const wait = parseFloodWaitSeconds(e);
            if (wait) {
                console.log(`FLOOD_WAIT ${wait}s on getMessages (${chat.title})`);
                await sleep((wait + 1) * 1000);
                return;
            }
            throw e;
        }

        if (!msgs || msgs.length === 0) break;

        const oldestId = msgs[msgs.length - 1].id;

        const fresh = msgs
            .filter((m) => m.id > s.lastSeenId)
            .sort((a, b) => a.id - b.id);

        for (const m of fresh) {
            const text =
                typeof m?.message === "string" ? m.message.toLowerCase().trim() : "";
            if (!text) continue;
            if (!Array.isArray(KEYPHRASES) || KEYPHRASES.length === 0) continue;

            let matched = [];
            try {
                matched = fuzzyMatchRussian(text, KEYPHRASES);
            } catch (e) {
                console.log("WARN fuzzyMatch failed:", e?.message || e, {
                    chat: chat?.title,
                    chatId: chat?.idStr,
                    msgId: m?.id,
                    textType: typeof m?.message,
                });
                continue;
            }

            if (!matched.length) continue;

            const short = String(m.message || "").slice(0, 300);
            await sendMatchNotification(chat, matched, m, short);
        }

        if (fresh.length) {
            s.lastSeenId = Math.max(s.lastSeenId, fresh[fresh.length - 1].id);
            processed += fresh.length;
            state.set(chat.idStr, s);
        }

        if (oldestId > s.lastSeenId) {
            // двигаемся глубже в историю
            if (offsetId && oldestId >= offsetId) break; // защита от зацикливания
            offsetId = oldestId;
            continue;
        }

        break;
    }

    if (processed >= MAX_TO_PROCESS_PER_CHAT) {
        console.log(`poll warn: "${s.title}" capped at ${MAX_TO_PROCESS_PER_CHAT}`);
    }
}

async function startPollingAllChats() {
    await refreshDialogs();

    console.log("Starting first poll tick...");
    for (let i = 0; i < CHATS_PER_TICK && chatQueue.length; i++) {
        const chat = chatQueue[queueIndex % chatQueue.length];
        queueIndex++;
        console.log(`TICK(init): ${chat.title} (${chat.idStr})`);
        await pollOneChat(chat);
    }

    setInterval(async () => {
        if (isRefreshingDialogs) return;
        isRefreshingDialogs = true;
        try {
            await refreshDialogs();
        } catch (e) {
            console.log("refreshDialogs error:", e?.message || e);
        } finally {
            isRefreshingDialogs = false;
        }
    }, DIALOG_REFRESH_MS);

    setInterval(async () => {
        if (isPolling) return;
        isPolling = true;

        try {
            if (!chatQueue.length) return;

            for (let i = 0; i < CHATS_PER_TICK; i++) {
                const chat = chatQueue[queueIndex % chatQueue.length];
                queueIndex++;

                try {
                    await pollOneChat(chat);
                } catch (e) {
                    console.log("poll error:", chat?.title, e?.message || e);
                }
            }
        } finally {
            isPolling = false;
        }
    }, POLL_INTERVAL_MS);

    setInterval(logMemory, MEMORY_LOG_INTERVAL_MS);

    setInterval(() => {
        saveStateToFile(state);
    }, STATE_SAVE_INTERVAL_MS);


}

// =========================
// Main
// =========================
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));


process.on("SIGINT", () => {
    console.log("SIGINT received, saving state...");
    saveStateToFile(state);
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("SIGTERM received, saving state...");
    saveStateToFile(state);
    process.exit(0);
});

process.on("beforeExit", () => {
    console.log("beforeExit, saving state...");
    saveStateToFile(state);
});

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
        await startPollingAllChats();
    } catch (e) {
        console.error("FATAL in main:", e);
        process.exit(1);
    }
})();