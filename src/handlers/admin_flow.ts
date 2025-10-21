import TelegramBot from 'node-telegram-bot-api';
import { User, AppConfig, UserConfig } from '../types';
import * as db from '../db';
import { logActivity } from '../logger';
import { devices } from '../bot';
import { getUsageText } from '../utils'

let botInstance: TelegramBot;
let appConfigInstance: AppConfig;

export function initAdminFlow(bot: TelegramBot, appCfg: AppConfig) {
    botInstance = bot;
    appConfigInstance = appCfg;
}

export async function handleAdminCommand(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;

    if (userId !== appConfigInstance.adminTelegramId) {
        await botInstance.sendMessage(chatId, "Эта команда доступна только администратору.");
        return;
    }
    await showAdminMainMenu(chatId);
}

export async function showAdminMainMenu(chatId: number) {
    const keyboard: TelegramBot.KeyboardButton[][] = [
        [{ text: "👥 Пользователи" }, { text: "⚙️ Все конфиги" }],
        [{ text: "📝 Просмотр логов" }],
        [{ text: "⬅️ Главное меню" }]
    ];
    await botInstance.sendMessage(chatId, "👑 Меню Администратора:", {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
}

export async function handleApproveAccess(adminChatId: number, userIdToApprove: number, originalMsgId?: number) {
    const user = db.ensureUser(userIdToApprove);
    user.hasAccess = true;
    user.accessGrantedAt = new Date().toISOString();
    db.updateUser(userIdToApprove, { hasAccess: true, accessGrantedAt: user.accessGrantedAt });

    const request = db.getAccessRequest(userIdToApprove);
    const userIdentifier = user.username ? `@${user.username}` : `ID ${userIdToApprove}`;

    db.removeAccessRequest(userIdToApprove);

    await botInstance.sendMessage(userIdToApprove, "✅ Ваш запрос на доступ одобрен! Теперь вы можете пользоваться ботом. Введите /start, чтобы начать.");
    logActivity(`Admin approved access for user ${userIdToApprove}.`);

    const approvalText = `✅ Доступ для пользователя ${userIdentifier} (ID: ${userIdToApprove}) одобрен.`;
    if (originalMsgId && request?.adminMessageId === originalMsgId) {
        try {
            await botInstance.editMessageText(
                `Пользователь ${userIdentifier} (ID: ${userIdToApprove}) запрашивает доступ к боту.\n\n${approvalText}`,
                {
                    chat_id: adminChatId,
                    message_id: originalMsgId,
                    reply_markup: { inline_keyboard: [] }
                }
            );
        } catch (e) {
            console.error("Failed to edit admin message for approval:", e);
            await botInstance.sendMessage(adminChatId, approvalText);
        }
    } else {
        await botInstance.sendMessage(adminChatId, approvalText);
    }
}

export async function handleDenyAccess(adminChatId: number, userIdToDeny: number, originalMsgId?: number) {
    const user = db.getUser(userIdToDeny);
    const request = db.getAccessRequest(userIdToDeny);
    const userIdentifier = user?.username || request?.username || `ID ${userIdToDeny}`;

    db.removeAccessRequest(userIdToDeny);

    await botInstance.sendMessage(userIdToDeny, "❌ Ваш запрос на доступ отклонен администратором. Вы можете попробовать запросить доступ позже.");
    logActivity(`Admin denied access for user ${userIdToDeny}.`);

    const denialText = `❌ Доступ для пользователя ${userIdentifier} (ID: ${userIdToDeny}) отклонен.`;
    if (originalMsgId && request?.adminMessageId === originalMsgId) {
        try {
            await botInstance.editMessageText(
                `Пользователь ${userIdentifier} (ID: ${userIdToDeny}) запрашивает доступ к боту.\n\n${denialText}`,
                {
                    chat_id: adminChatId,
                    message_id: originalMsgId,
                    reply_markup: { inline_keyboard: [] }
                }
            );
        } catch (e) {
            console.error("Failed to edit admin message for denial:", e);
            await botInstance.sendMessage(adminChatId, denialText);
        }
    } else {
        await botInstance.sendMessage(adminChatId, denialText);
    }
}

export async function handleAdminListUsers(chatId: number, page: number) {
    const usersWithAccess = db.getAllUsersWithAccess().filter(u => u.id !== appConfigInstance.adminTelegramId);
    const ITEMS_PER_PAGE = 10;

    if (usersWithAccess.length === 0) {
        await botInstance.sendMessage(chatId, "Нет пользователей с доступом (кроме вас).", {
            reply_markup: {
                inline_keyboard: [[{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]]
            }
        });
        return;
    }

    const totalPages = Math.ceil(usersWithAccess.length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));

    const startIndex = currentPage * ITEMS_PER_PAGE;
    const pageUsers = usersWithAccess.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let messageText = `👥 Пользователи с доступом (Страница ${currentPage + 1}/${totalPages}):\n`;
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [];

    if (pageUsers.length === 0 && currentPage > 0) {
        messageText = "На этой странице нет пользователей. Возможно, список изменился.";
    } else {
        pageUsers.forEach(user => {
            const userIdentifier = user.username ? `@${user.username}` : `ID: ${user.id}`;
            inline_keyboard.push([{ text: userIdentifier, callback_data: `admin_view_user_${user.id}` }]);
        });
    }

    const paginationButtons: TelegramBot.InlineKeyboardButton[] = [];
    if (currentPage > 0) {
        paginationButtons.push({ text: "⬅️", callback_data: `admin_list_users_page_${currentPage - 1}` });
    }
    if (totalPages > 1) {
        paginationButtons.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: "noop" });
    }
    if (currentPage < totalPages - 1) {
        paginationButtons.push({ text: "➡️", callback_data: `admin_list_users_page_${currentPage + 1}` });
    }

    if (paginationButtons.length > 0) {
        inline_keyboard.push(paginationButtons);
    }
    inline_keyboard.push([{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]);

    const adminState = db.getUser(chatId)?.state;
    if (adminState && adminState.action === 'admin_viewing_users' && adminState.data?.messageId) {
        try {
            await botInstance.editMessageText(messageText, {
                chat_id: chatId,
                message_id: adminState.data.messageId,
                reply_markup: { inline_keyboard }
            });
        } catch (e) {
            const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard } });
            db.updateUser(chatId, { state: { action: 'admin_viewing_users', data: { messageId: sentMessage.message_id } } });
        }
    } else {
        const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard } });
        db.updateUser(chatId, { state: { action: 'admin_viewing_users', data: { messageId: sentMessage.message_id } } });
    }
    logActivity(`Admin ${chatId} requested user list (page ${page}) - WIP`);
}

export async function handleAdminListAllConfigs(chatId: number, page: number) {
    const allConfigsWithOwners = db.getAllConfigs();
    const ITEMS_PER_PAGE = 10;

    if (allConfigsWithOwners.length === 0) {
        await botInstance.sendMessage(chatId, "Нет созданных конфигураций.", {
            reply_markup: {
                inline_keyboard: [[{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]]
            }
        });
        return;
    }
    const totalPages = Math.ceil(allConfigsWithOwners.length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));

    const startIndex = currentPage * ITEMS_PER_PAGE;
    const pageConfigs = allConfigsWithOwners.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let messageText = `⚙️ Все конфигурации (Страница ${currentPage + 1}/${totalPages}):\n`;
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [];

    pageConfigs.forEach((config, indexOnPage) => {
        const globalIndex = startIndex + indexOnPage;
        const ownerIdentifier = config.ownerUsername ? `@${config.ownerUsername}` : `ID: ${config.ownerId}`;
        const totalTraffic = (config.totalTx || 0) + (config.totalRx || 0);
        const statusIcon = config.isEnabled ? '✅' : '❌';

        messageText += `\n${statusIcon} <b>"${config.userGivenName}"</b> (от ${ownerIdentifier}, трафик: ${getUsageText(totalTraffic)})`;
        inline_keyboard.push([{ text: `"${config.userGivenName}" от ${ownerIdentifier}`, callback_data: `admin_view_cfg_idx_${globalIndex}` }]);
    });

    const paginationButtons: TelegramBot.InlineKeyboardButton[] = [];
    if (currentPage > 0) {
        paginationButtons.push({ text: "⬅️", callback_data: `admin_list_all_configs_page_${currentPage - 1}` });
    }
    if (totalPages > 1) {
        paginationButtons.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: "noop" });
    }
    if (currentPage < totalPages - 1) {
        paginationButtons.push({ text: "➡️", callback_data: `admin_list_all_configs_page_${currentPage + 1}` });
    }

    if (paginationButtons.length > 0) {
        inline_keyboard.push(paginationButtons);
    }
    inline_keyboard.push([{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]);

    const adminState = db.getUser(chatId)?.state;
    if (adminState && adminState.action === 'admin_viewing_all_configs' && adminState.data?.messageId) {
        try {
            await botInstance.editMessageText(messageText, {
                chat_id: chatId,
                parse_mode: 'HTML',
                message_id: adminState.data.messageId,
                reply_markup: { inline_keyboard }
            });
        } catch (e) {
            const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard }, parse_mode: 'HTML' });
            db.updateUser(chatId, { state: { action: 'admin_viewing_all_configs', data: { messageId: sentMessage.message_id } } });
        }
    } else {
        const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard }, parse_mode: 'HTML' });
        db.updateUser(chatId, { state: { action: 'admin_viewing_all_configs', data: { messageId: sentMessage.message_id } } });
    }

    logActivity(`Admin ${chatId} requested all configs list (page ${page}) - WIP`);
}

export async function handleAdminViewLogs(chatId: number) {
    try {
        const logContent = await Bun.file('data/activity.log').text();
        const lines = logContent.split('\n').filter(line => line.trim() !== '');
        const lastNLines = lines.slice(-20).join('\n');
        if (lastNLines) {
            await botInstance.sendMessage(chatId, `Последние логи:\n\`\`\`\n${lastNLines}\n\`\`\``, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]] }
            });
        } else {
            await botInstance.sendMessage(chatId, "Файл логов пуст.", {
                reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]] }
            });
        }
    } catch (error) {
        await botInstance.sendMessage(chatId, "Не удалось прочитать файл логов.");
        logActivity(`Admin ${chatId} failed to read logs: ${error}`);
    }
    logActivity(`Admin ${chatId} requested logs view - WIP`);
}

export async function handleAdminViewUser(chatId: number, userIdToView: number) {
    const user = db.getUser(userIdToView);

    if (!user) {
        await botInstance.sendMessage(chatId, "Пользователь не найден.", {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ К списку пользователей", callback_data: "admin_list_users_page_0" }]] }
        });
        return;
    }

    let messageText = `ℹ️ Информация о пользователе:\n`;
    messageText += `ID: ${user.id}\n`;
    messageText += `Username: ${user.username || "Не указан"}\n`;
    messageText += `Доступ получен: ${user.accessGrantedAt ? new Date(user.accessGrantedAt).toLocaleString('ru-RU') : "Неизвестно"}\n`;
    messageText += `Конфигурации (${user.configs.length} шт.):\n`;

    if (user.configs.length > 0) {
        user.configs.forEach(config => {
            const totalTx = config.totalTx || 0;
            const totalRx = config.totalRx || 0;
            const statusIcon = config.isEnabled ? '✅' : '❌';
            messageText += `  ${statusIcon} "${config.userGivenName}" (скачано: ${getUsageText(totalTx)}, отправлено: ${getUsageText(totalRx)})\n`;
        });
    } else {
        messageText += `  У пользователя нет конфигураций.\n`;
    }

    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: "🚫 Отозвать доступ", callback_data: `admin_revoke_access_ask_${user.id}` }],
        [{ text: "⬅️ К списку пользователей", callback_data: "admin_list_users_page_0" }],
        [{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]
    ];

    await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard } });
    logActivity(`Admin ${chatId} viewed details for user ${userIdToView}`);
}

export async function handleAdminRevokeAccessAsk(chatId: number, userIdToRevoke: number) {
    const user = db.getUser(userIdToRevoke);
    if (!user) {
        await botInstance.sendMessage(chatId, "Пользователь не найден.");
        return;
    }
    const userIdentifier = user.username ? `@${user.username}` : `ID ${user.id}`;
    await botInstance.sendMessage(chatId, `Вы уверены, что хотите отозвать доступ у пользователя ${userIdentifier}? Пользователь потеряет возможность создавать и управлять конфигурациями. Существующие конфигурации останутся, но он не сможет ими управлять через бота.`, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚫 Да, отозвать", callback_data: `admin_revoke_access_confirm_${userIdToRevoke}` }],
                [{ text: "⬅️ Нет, отмена", callback_data: `admin_view_user_${userIdToRevoke}` }]
            ]
        }
    });
}

export async function handleAdminRevokeAccessConfirm(adminChatId: number, userIdToRevoke: number) {
    const user = db.getUser(userIdToRevoke);
    if (!user) {
        await botInstance.sendMessage(adminChatId, "Пользователь не найден.");
        return;
    }

    db.updateUser(userIdToRevoke, { hasAccess: false });
    const userIdentifier = user.username ? `@${user.username}` : `ID ${user.id}`;
    logActivity(`Admin ${adminChatId} revoked access for user ${userIdToRevoke} (${userIdentifier})`);

    await botInstance.sendMessage(adminChatId, `Доступ для пользователя ${userIdentifier} отозван.`);
    try {
        await botInstance.sendMessage(userIdToRevoke, "Администратор отозвал ваш доступ к боту. Вы больше не можете создавать новые конфигурации или управлять существующими через бота. Для повторного получения доступа обратитесь к администратору или используйте команду /start для запроса.");
    } catch (e) {
        logActivity(`Failed to notify user ${userIdToRevoke} about access revocation: ${e.message}`);
    }
    await handleAdminListUsers(adminChatId, 0);
}


export async function handleAdminViewConfig(adminChatId: number, ownerId: number, wgEasyClientId: string) {
    const owner = db.getUser(ownerId);
    if (!owner) {
        await botInstance.sendMessage(adminChatId, "Владелец конфигурации не найден.");
        return;
    }
    const config = owner.configs.find(c => c.wgEasyClientId === wgEasyClientId);
    if (!config) {
        await botInstance.sendMessage(adminChatId, "Конфигурация не найдена у указанного владельца.");
        return;
    }

    const deviceName = devices.find(d => d.id === config.deviceId)?.name || 'Неизвестное устройство';
    const creationDate = new Date(config.createdAt).toLocaleString('ru-RU');
    const ownerIdentifier = owner.username ? `@${owner.username}` : `ID ${owner.id}`;

    let text = `👑 Админ: Детали конфигурации\n\n`;
    text += `Имя: "${config.userGivenName}"\n`;
    text += `Владелец: ${ownerIdentifier} (ID: ${ownerId})\n`;
    text += `Устройство: ${deviceName} (ID: ${config.deviceId})\n`;
    text += `Создан: ${creationDate}\n`;
    text += `Статус: ${config.isEnabled ? "✅ Активен" : "❌ Отключен"}\n`;

    const totalTx = config.totalTx || 0;
    const totalRx = config.totalRx || 0;
    const bandwidth = `${getUsageText(totalTx)} скачано, ${getUsageText(totalRx)} отправлено`;
    text += `Трафик: ${bandwidth}\n`;

    text += `Клиент ID (wg-easy): ${config.wgEasyClientId}`;

    const allConfigs = db.getAllConfigs();
    const globalConfigIndex = allConfigs.findIndex(c => c.ownerId === ownerId && c.wgEasyClientId === wgEasyClientId);
    if (globalConfigIndex === -1) {
        await botInstance.sendMessage(adminChatId, "Ошибка: не удалось найти глобальный индекс конфигурации.");
        return;
    }
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
        [
            { text: "📥 Скачать (.conf)", callback_data: `admin_dl_config_${ownerId}_${wgEasyClientId}` },
            { text: "📱 QR-код", callback_data: `admin_qr_config_${ownerId}_${wgEasyClientId}` }
        ],
        [
            config.isEnabled
                ? { text: "🚫 Отключить", callback_data: `admin_disable_cfg_idx_${globalConfigIndex}` }
                : { text: "▶️ Включить", callback_data: `admin_enable_cfg_idx_${globalConfigIndex}` }
        ],
        [
            { text: "🗑 Удалить (Админ)", callback_data: `admin_delete_cfg_ask_idx_${globalConfigIndex}` }
        ],
        [
            { text: "⬅️ К списку всех конфигов", callback_data: `admin_list_all_configs_page_0` }
        ]
    ];

    await botInstance.sendMessage(adminChatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard } });
}

// Действия с конфигурациями от имени администратора (скачивание, QR, вкл/выкл, удаление)
// Эти функции будут очень похожи на userFlow.handleConfigAction, но с префиксом 'admin_'
// и будут принимать ownerId.
// userFlow.handleConfigAction, вызывая соответствующие wgAPI функции
// и обновляя состояние конфига в db.updateUser(ownerId, ...).

import * as userFlow from './user_flow';
import * as wgAPI from '../wg_easy_api';

export async function handleAdminConfigAction(adminChatId: number, actionWithPrefix: string, configIdentifier: string) {
    const allConfigs = db.getAllConfigs();
    let ownerId: number;
    let wgEasyClientId: string;
    let configIndexInDb: number;
    let owner: User | undefined;
    let config: UserConfig | undefined;

    const action = actionWithPrefix.replace('admin_', '').replace(/_cfg_idx$/, ''); // e.g. dl_config, disable, delete_ask

    if (actionWithPrefix.includes('_cfg_idx_')) {
        const globalIndex = parseInt(configIdentifier);
        if (isNaN(globalIndex) || globalIndex < 0 || globalIndex >= allConfigs.length) {
            await botInstance.sendMessage(adminChatId, "Ошибка: неверный индекс конфигурации.");
            return;
        }
        const targetFullConfig = allConfigs[globalIndex];
        ownerId = targetFullConfig.ownerId;
        wgEasyClientId = targetFullConfig.wgEasyClientId;
        owner = db.getUser(ownerId);
        if (!owner) { await botInstance.sendMessage(adminChatId, "Владелец конфигурации не найден."); return; }
        configIndexInDb = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
        if (configIndexInDb === -1) { await botInstance.sendMessage(adminChatId, "Конфигурация не найдена у владельца."); return; }
        config = owner.configs[configIndexInDb];
    } else {
        const parts = configIdentifier.split('_');
        ownerId = parseInt(parts[0]);
        wgEasyClientId = parts[1];
        owner = db.getUser(ownerId);
        if (!owner) { await botInstance.sendMessage(adminChatId, "Владелец конфигурации не найден."); return; }
        configIndexInDb = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
        if (configIndexInDb === -1) { await botInstance.sendMessage(adminChatId, "Конфигурация не найдена у владельца."); return; }
        config = owner.configs[configIndexInDb];
    }

    if (!owner || !config) return;

    logActivity(`Admin ${adminChatId} performing action '${action}' on config ${wgEasyClientId} of user ${ownerId}`);

    // Пример для disable:
    if (action === 'disable') {
        if (await wgAPI.disableWgClient(wgEasyClientId)) {
            owner.configs[configIndexInDb].isEnabled = false;
            db.updateUser(ownerId, { configs: owner.configs });
            logActivity(`Admin ${adminChatId} disabled config ${wgEasyClientId} for user ${ownerId}`);
            await handleAdminViewConfig(adminChatId, ownerId, wgEasyClientId);
        } else {
            await botInstance.sendMessage(adminChatId, "Не удалось отключить конфигурацию через API.");
        }
        return;
    }

    // TODO: Реализовать остальные действия: enable, delete_ask, delete_confirm, dl_config, qr_config
    // dl_config и qr_config будут похожи на userFlow, просто отправляя файлы админу.
    // delete_ask должен показать подтверждение с callback_data `admin_delete_cfg_confirm_idx_${globalIndex}`
    // delete_confirm должен удалить из wgAPI и из db, затем показать список всех конфигов.

    await botInstance.sendMessage(adminChatId, `Действие '${action}' для конфига ${wgEasyClientId} (владелец ${ownerId}) в разработке.`);
}
