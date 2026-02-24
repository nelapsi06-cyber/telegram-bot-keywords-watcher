const { TelegramClient } = require('telegram');
const { StoreSession, StringSession } = require('telegram/sessions'); // <-- добавили StringSession

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;

const STRING_SESSION = process.env.STRING_SESSION; // <-- новое

const session = STRING_SESSION
    ? new StringSession(STRING_SESSION)
    : new StoreSession("saved_session");

const client = new TelegramClient(session, API_ID, API_HASH);

const { Telegraf } = require('telegraf');
const readline = require('readline'); // Built-in Node.js module
const { NewMessage } = require("telegram/events");
const { fuzzyMatchRussian } = require('./keyphrase-matcher');

// Configuration

const BOT_TOKEN = process.env.BOT_TOKEN;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const KEYPHRASES = process.env.KEYPHRASES.split(',').map(keyword => keyword.trim());
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

console.log(`using KEYPHRASES: ${KEYPHRASES}`);

//const storeSession = new StoreSession("saved_session");
const bot = new Telegraf(BOT_TOKEN);

async function messageHandler(event) {
    if (!event.message) return;
    try {
        const message = event.message;
        const text = message.message?.toLowerCase();
        
        if (!text) return;

        const sender = await message.getSender();

        // Prepare user info
        let username = 'Unknown sender';
        let fullName = 'Unknown';

        if (sender) {
            username = sender.username || 'not available';
            fullName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || 'Unknown';
            if (sender.bot) {
                // console.log("sender is a bot; ignoring message");
                return;
            }
        }


        const matchedKEYPHRASES = fuzzyMatchRussian(text, KEYPHRASES);
        if (matchedKEYPHRASES.length === 0) return;

        console.log("found matched KEYPHRASES: ", JSON.stringify(matchedKEYPHRASES, null, 2));
        const matchedKeywordText = matchedKEYPHRASES.map(keyword => {
            return `${keyword.phrase} (${keyword.score.toFixed(3)})`;
        }).join(', ');

        // Prepare chat info
        const chat = await message.getChat();
        let chatId = message.chatId;
        let chatTitle = 'Unknown chat';
        let channelLink = 'Link not available';
        
        if (chat) {
            chatTitle = chat.title || 'Unknown chat';
            channelLink = chat.username ? `https://t.me/${chat.username}` : 'Link not available';
            chatId = chat.id?.toString() || 'Unknown chat';
        }
        
        // Create message link
        let messageLink = 'Message link not available';
        if (chat && chat.username) {
            messageLink = `https://t.me/${chat.username}/${message.id}`;
        } else if (chatId) {
            const parsedChatId = Math.abs(chatId).toString().replace('100', '');
            channelLink = `https://t.me/c/${parsedChatId}`;
            messageLink = `https://t.me/c/${parsedChatId}/${message.id}`;
        }

        // Format notification message
        const textMsg = `<b>Keyword found:</b> ${matchedKeywordText}\n` +
            `<b>Username:</b> @${username}\n` +
            `<b>Full user name:</b> ${fullName}\n` +
            `<b>Message link:</b> <a href="${messageLink}">Find message</a>\n` +
            `<b>Channel/Group title:</b> ${chatTitle}\n` +
            `<b>Channel/Group link:</b> ${channelLink}`;

        // Send notification via bot
        await bot.telegram.sendMessage(
            TARGET_CHAT_ID,
            textMsg,
            { parse_mode: 'HTML' }
        );
        
    } catch (error) {
        console.error('Error handling message:', error);
    }
}

client.addEventHandler(messageHandler, new NewMessage({}));

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
    await client.start({
        phoneNumber: PHONE_NUMBER,
        password: async () => await getUserInput('Password: '),
        phoneCode: async () => await getUserInput('Code: '),
        onError: (err) => console.error(err),
    });
    
    // Close readline interface after authentication
    rl.close();

    client.session.save();
    
    console.log('Userbot started and listening...');
    await bot.launch();
    console.log('Bot started');
})();
