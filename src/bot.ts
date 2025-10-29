import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { AppConfig, Device, User } from '$/db/types';
import * as userFlow from '$/handlers/user_flow';
import * as adminFlow from '$/handlers/admin_flow';
import { initUserFlow, handleStart } from '$/handlers/user_flow';
import { initAdminFlow } from '$/handlers/admin_flow';
import * as db from '$/db';
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

const bot = new TelegramBot(appConfig.telegramBotToken, { polling: true });
// TODO fix
// @ts-ignore
bot.sendCachedMedia = sendCachedMedia;

initUserFlow(bot, devices, appConfig);
initAdminFlow(bot, appConfig);
initCallbackQueryHandler(bot, appConfig);

logActivity("Bot started successfully. Polling for updates...");
console.log("Telegram Bot успешно запущен и готов к работе!");
console.log(`Admin IDs: ${appConfig.adminTelegramIds.join(', ')}`);
console.log(`wg-easy API URL: ${appConfig.wgEasyApiUrl}`);


/* ============
 Общие команды
============ */

bot.onText(/\/start/, async (msg) => {
    logActivity(`Received /start command from ${msg.from?.id} (${msg.from?.username || 'N/A'})`);
    await handleStart(msg);
});

bot.onText(/❓ Плохо работает VPN/, async (msg) => {
    const user = db.getUser(msg.from!.id);
    if (user) {
        logActivity(`User ${msg.from!.id} selected '❓ Плохо работает VPN'`);
        await userFlow.handleVpnHelp(msg.chat.id);
    }
});

// TODO убрать
bot.onText(/🛡 Wireguard/, async (msg) => {
    const user = db.getUser(msg.from!.id);
    if (user && user.hasAccess) {
        logActivity(`User ${msg.from!.id} selected '🛡 Wireguard'`);
        await userFlow.handleCreateWgConfigStart(msg.chat.id, msg.from!.id, NaN);
    }
});

// TODO убрать
bot.onText(/📄 Мои конфиги/, async (msg) => {
    const user = db.getUser(msg.from!.id);
    if (user && user.hasAccess) {
        logActivity(`User ${msg.from!.id} selected '📄 Мои конфиги'`);
        await userFlow.handleListMyConfigs(msg.chat.id, msg.from!.id, NaN, 0);
    }
});

// TODO убрать
/*bot.onText(/👑 Админ-панель/, async (msg) => {
    if (msg.from?.id === appConfig.adminTelegramId) {
        logActivity(`Admin ${msg.from!.id} selected '👑 Админ-панель'`);
        await adminFlow.showAdminMainMenu(msg.chat.id);
    }
});*/

/* ==============
 Команды админа
============== */

/* TODO убрать
bot.onText(/👥 Пользователи/, async (msg) => {
    if (msg.from?.id === appConfig.adminTelegramId) {
        logActivity(`Admin ${msg.from!.id} selected '👥 Пользователи'`);
        await adminFlow.handleAdminListUsers(msg.chat.id, null, 0);
    }
});*/

/* TODO убрать
bot.onText(/⚙️ Все конфиги/, async (msg) => {
    if (msg.from?.id === appConfig.adminTelegramId) {
        logActivity(`Admin ${msg.from!.id} selected '⚙️ Все конфиги'`);
        await adminFlow.handleAdminListAllConfigs(msg.chat.id, null, 0);
    }
});*/

/* TODO убрать
bot.onText(/📊 Статистика/, async (msg) => {
    if (msg.from?.id === appConfig.adminTelegramId) {
        logActivity(`Admin ${msg.from!.id} selected '📊 Статистика'`);
        await adminFlow.handleAdminShowUsageStats(msg.chat.id);
    }
});*/

/* TODO убрать
bot.onText(/📝 Просмотр логов/, async (msg) => {
    if (msg.from?.id === appConfig.adminTelegramId) {
        logActivity(`Admin ${msg.from!.id} selected '📝 Просмотр логов'`);
        await adminFlow.handleAdminViewLogs(msg.chat.id);
    }
});*/

bot.onText(/⚡ Открыть главное меню/, async (msg) => {
    const user = db.getUser(msg.from!.id);
    if (user && user.hasAccess) {
        logActivity(`User ${msg.from!.id} selected '⬅️ Главное меню'`);
        await userFlow.showMainMenu(msg.chat.id, msg.from!.id);
    }
});


/*bot.onText(/\/admin/, async (msg) => {
    logActivity(`Received /admin command from ${msg.from?.id} (${msg.from?.username || 'N/A'})`);
    if (msg.from?.id === appConfig.adminTelegramId) {
        await adminFlow.handleAdminCommand(msg);
    } else {
        await bot.sendMessage(msg.chat.id, "У вас нет прав для этой команды.");
    }
});*/

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
       (для ввода имени конфига)
============================== */

bot.on('message', async (msg) => {
    const userId = msg.from!.id;
    if (!userId) return;

    const knownTextCommands = [
        "⚡ Открыть главное меню",
        "❓ Плохо работает VPN",
    ];

    if (msg.text && (msg.text.startsWith('/') || knownTextCommands.includes(msg.text))) {
        return;
    }

    const user = db.getUser(userId);
    
    if (user && user.state && user.state.action === 'awaiting_config_name') {
        logActivity(`Received text message from ${userId} potentially for config name: "${msg.text}"`);
        await userFlow.handleConfigNameInput(msg);
    } 
    else if (user && user.state && user.state.action === 'awaiting_owner') {
        logActivity(`Received text message from ${userId} potentially for owner name: "${msg.text}"`);
        await userFlow.handleConfigOwnerInput(msg, false);
	}
    else if (user && user.state && user.state.action === 'awaiting_feedback') {
        logActivity(`Received text message from ${userId} for feedback: "${msg.text}"`);
        await userFlow.handleFeedbackInput(msg);
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

const exit = (reason: string) => {
    logActivity('Bot shutting down (SIGTERM)...');
    db.saveDb();
    console.log('Database saved. Exiting.');
    process.exit(0);
}

process.on('SIGINT', () => exit('SIGINT'));
process.on('SIGTERM', () => exit('SIGTERM'));
