import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { AppConfig, Device, User } from '$/db/types';
import * as userFlow from '$/handlers/user_flow';
import * as adminFlow from '$/handlers/admin_flow';
import settingsFlow, { initSettingsFlow } from '$/handlers/settings_flow';
import { initUserFlow, handleStart } from '$/handlers/user_flow';
import { initAdminFlow } from '$/handlers/admin_flow';
import * as db from '$/db/index';
import { initWgEasyApi } from '$/api/wg_easy_api';
import { initCallbackQueryHandler, handleCallbackQuery } from '$/handlers/callback_query_handler';
import { logActivity } from '$/utils/logger';
import { sendCachedMedia } from '$/utils/images';

process.env.NTBA_FIX_350 = 'true'; // deprecation log fix

/* =================================
 Конфигурация устройств - из файла
================================= */

const devicesPath = path.join(process.cwd(), 'config', 'devices.json');
if (!fs.existsSync(devicesPath)) {
  console.error(`FATAL: Devices file not found at ${devicesPath}`);
  logActivity(`FATAL: Devices file not found at ${devicesPath}`);
  process.exit(1);
}
export const devices: Device[] = JSON.parse(fs.readFileSync(devicesPath, 'utf-8'));
logActivity("Device configuration loaded from config/devices.json.");

/* =============================================
 Загрузка конфигурации из переменных окружения
============================================= */

const telegramBotToken = process.env.BOT_TOKEN;
const adminTelegramIds = process.env.ADMIN_TELEGRAM_ID;
const wgEasyApiUrl = process.env.WG_EASY_API_URL;

if (!telegramBotToken || !adminTelegramIds || !wgEasyApiUrl) {
    const missing = [
        !telegramBotToken && "BOT_TOKEN",
        !adminTelegramIds && "ADMIN_TELEGRAM_ID",
        !wgEasyApiUrl && "WG_EASY_API_URL"
    ].filter(Boolean).join(', ')
    const errorMessage = `FATAL: Missing required environment variables: ${missing}. Please check your .env file.`;
    console.error(errorMessage);
    logActivity(errorMessage);
    process.exit(1);
}

const appConfig: AppConfig = {
    telegramBotToken,
    adminTelegramIds: adminTelegramIds.split(',').map(id => parseInt(id, 10)),
    wgEasyApiUrl
};
logActivity("Application configuration loaded from environment variables.");

/* =============
 Инициализация
============= */

db.loadDb();
initWgEasyApi(appConfig);
let botUsername: string;

const bot = new TelegramBot(appConfig.telegramBotToken, { polling: true });
// TODO fix
// @ts-ignore
bot.sendCachedMedia = sendCachedMedia;

initUserFlow(bot, devices, appConfig);
initAdminFlow(bot, appConfig);
initSettingsFlow(bot);
initCallbackQueryHandler(bot, appConfig);

bot.getMe().then(me => {
    botUsername = me.username!;
    logActivity(`Bot username: @${botUsername}`);
});
logActivity("Bot started successfully. Polling for updates...");
//console.log("Telegram Bot успешно запущен и готов к работе!");
console.log(`Admin IDs: ${appConfig.adminTelegramIds.join(', ')}`);
console.log(`wg-easy API URL: ${appConfig.wgEasyApiUrl}`);


/* ============
 Общие команды
============ */

bot.onText(/\/start/, async (msg) => {
    const payload = msg.text?.split(' ')[1];
    if (payload) {
        logActivity(`Received /start command with payload ${payload} from ${msg.from?.id} (${msg.from?.username || 'N/A'})`);
        const tokenConsumed = await userFlow.handleStartWithToken(msg, payload);
        if (tokenConsumed) return; // Если токен обработан, не показываем главное меню сразу
    }
    else {
        logActivity(`Received /start command from ${msg.from?.id} (${msg.from?.username || 'N/A'})`);
    }
    await userFlow.handleStart(msg);
});

bot.onText(/✍️ Обратная связь/, async (msg) => {
    const user = db.getUser(msg.from!.id);
    if (user) {
        logActivity(`User ${msg.from!.id} selected '✍️ Обратная связь'`);
        await userFlow.handleRequestFeedback(msg.chat.id, msg.from!.id);
    }
});

bot.onText(/⚡ Открыть главное меню/, async (msg) => {
    const userId = msg.from!.id;
    const user = db.getUser(userId);
    if (user) {
        const hasSharedConfigs = db.getAllConfigs().some(c => c.sharedWith === userId);
        if (user.hasAccess || user.configs.length || hasSharedConfigs) {
            logActivity(`User ${userId} selected '⬅️ Главное меню'`);
            await userFlow.showMainMenu(msg.chat.id, userId);
        }
    }
});

bot.onText(/\/cancel/, async (msg) => {
    const userId = msg.from!.id;
    const user = db.getUser(userId);
    
    logActivity(`User ${userId} sent /cancel`);
    
    if (user?.state?.messageId) {
        await bot.editMessageText("❌ Действие отменено", { chat_id: msg.chat.id, message_id: user.state.messageId })
    }
    else await bot.sendMessage(msg.chat.id, "Действие отменено.");
    db.updateUser(userId, { state: undefined });
    
    if (db.getUser(userId)?.hasAccess) {
        await userFlow.showMainMenu(msg.chat.id, userId);
    }
});

/* ==============================
 Обработчик текстовых сообщений 
============================== */

bot.on('message', async (msg) => {
    const userId = msg.from!.id;
    if (!userId) return;

    const knownTextCommands = [
        "⚡ Открыть главное меню",
        "✍️ Обратная связь",
    ];

    if (msg.text && (msg.text.startsWith('/') || knownTextCommands.includes(msg.text))) {
        return;
    }

    const user = db.getUser(userId);
    
    if (user && user.state && user.state.action === 'awaiting_config_name') {
        logActivity(`Received text message from ${userId} potentially for config name: "${msg.text}"`);
        await userFlow.handleConfigNameInput(msg);
    } 
    else if (user && user.state && user.state.action === 'awaiting_feedback') {
        logActivity(`Received text message from ${userId} for feedback: "${msg.text}"`);
        await userFlow.handleFeedbackInput(msg);
    } 
    else if (user && user.state && user.state.action === 'set_timezone' && msg.text) {
        logActivity(`Received text message from ${userId} for setting timezone: "${msg.text}"`);
        await settingsFlow.handleSetTimezone(userId, msg.text);
    } 
    else if (user && user.state && user.state.action === 'admin_subnet_creation' && msg.text) {
        logActivity(`Received text message from ${userId} for subnet creation: "${msg.text}"`);
        await adminFlow.handleSubnetCreationText(userId, msg.text);
    } 
    else if (user && user.state && user.state.action === 'admin_subnet_deletion' && msg.text) {
        logActivity(`Received text message from ${userId} for subnet deletion: "${msg.text}"`);
        await adminFlow.handleSubnetDeletionText(userId, msg.text);
    }
    else if (msg.text) {
        logActivity(`Received unhandled text message from ${userId}: "${msg.text}"`);
        await bot.sendMessage(msg.chat.id, "Неизвестная команда.\nПожалуйста, используйте кнопки или команды из меню.");
    }
});


/* *** Обработчик нажатий на inline-кнопки *** */
bot.on('callback_query', async (query) => {
    await handleCallbackQuery(query);
});


/* *** Обработка ошибок *** */
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
    logActivity(`Polling error: ${error.name} - ${error.message}`);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message);
    logActivity(`Webhook error: ${error.name} - ${error.message}`);
});

export function getBotUsername() {
    return botUsername;
}

const exit = (reason: string) => {
    logActivity('Bot shutting down (SIGTERM)...');
    db.saveDb();
    console.log('Database saved. Exiting.');
    process.exit(0);
}

process.on('SIGINT', () => exit('SIGINT'));
process.on('SIGTERM', () => exit('SIGTERM'));
