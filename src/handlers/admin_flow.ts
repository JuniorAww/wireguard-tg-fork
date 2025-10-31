import TelegramBot, { Message, InlineKeyboardButton } from 'node-telegram-bot-api';
import { User, AppConfig, UserConfig, Subnet } from '$/db/types';
import { logActivity } from '$/utils/logger';
import { generateMonthlyUsageChart, generateTopUsersChart } from '$/utils/chart';
import { getUsageText } from '$/utils/text';
import { sourceEval } from '$/utils/ips';
import { devices } from '$/bot';
import * as db from '$/db/index';

import * as userFlow from '$/handlers/user_flow';
import * as wgAPI from '$/api/wg_easy_api';


let botInstance: TelegramBot;
let appConfigInstance: AppConfig;

export function initAdminFlow(bot: TelegramBot, appCfg: AppConfig) {
    botInstance = bot;
    appConfigInstance = appCfg;
}

export async function showAdminMainMenu(chatId: number, messageId: number) {
    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "👥 Пользователи", callback_data: "admin_list_users_page_0" },
        { text: "⚙️ Все конфиги", callback_data: "admin_list_all_configs_page_0" }],
        [{ text: "📝 Просмотр логов", callback_data: "admin_view_logs" },
        { text: "📊 Статистика", callback_data: "admin_show_stats" }],
        [{ text: "📌 Списки IP", callback_data: "admin_subnets_0" }],
        [{ text: "⬅️ Главное меню", callback_data: "user_main_menu" }],
    ];
    
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: Math.pow(2, 32),
        caption: "👑 <b>Меню администратора</b>\nОтсюда вы можете управлять ботом!",
        keyboard: inline_keyboard
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

export async function handleAdminListUsers(chatId: number, page: number, messageId: number | undefined) {
    const usersWithAccess = db.getAllUsersWithAccess();//.filter(u => !appConfigInstance.adminTelegramIds.includes(u.id));
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
    const inline_keyboard: InlineKeyboardButton[][] = [];

    if (pageUsers.length === 0 && currentPage > 0) {
        messageText = "На этой странице нет пользователей. Возможно, список изменился.";
    } else {
        pageUsers.forEach(user => {
            const userIdentifier = user.username ? `@${user.username}` : `ID: ${user.id}`;
            inline_keyboard.push([{ text: userIdentifier, callback_data: `admin_view_user_${user.id}` }]);
        });
    }

    const paginationButtons: InlineKeyboardButton[] = [];
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
    
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: Math.pow(2, 32),
        caption: messageText,
        keyboard: inline_keyboard
    });
    logActivity(`Admin ${chatId} requested user list (page ${page}) - WIP`);
}

export async function handleSubnetList(chatId: number, messageId: number, page: number) {
    const subnets = db.getSubnets();
    const ITEMS_PER_PAGE = 10;

    const totalPages = Math.ceil(Object.keys(subnets).length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const pageIps = Object.entries(subnets).slice(startIndex, startIndex + ITEMS_PER_PAGE);
    
    let messageText = `📌 Списки IP (Страница ${currentPage + 1}/${totalPages}):\n`;
    const inline_keyboard: InlineKeyboardButton[][] = [];

    if (pageIps.length === 0 && currentPage > 0) {
        messageText = "На этой странице нет данных. Похоже, список изменился.";
    } else {
        pageIps.forEach(([ subnetId, subnet ]) => {
            const text = `${subnetId}. ${subnet.name} (${subnet.ips ? (subnet.ips.length + " IP") : "источник"})`
            inline_keyboard.push([{ text, callback_data: `admin_subnet_${subnetId}` }]);
        });
    }

    const paginationButtons: InlineKeyboardButton[] = [];
    if (currentPage > 0) {
        paginationButtons.push({ text: "⬅️", callback_data: `admin_subnets_${currentPage - 1}` });
    }
    if (totalPages > 1) {
        paginationButtons.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: "noop" });
    }
    if (currentPage < totalPages - 1) {
        paginationButtons.push({ text: "➡️", callback_data: `admin_subnets_${currentPage + 1}` });
    }

    if (paginationButtons.length > 0) {
        inline_keyboard.push(paginationButtons);
    }
    
    inline_keyboard.push([
        { text: "➕ Добавить", callback_data: "admin_create_subnet" },
        { text: "➖ Удалить", callback_data: "admin_delete_subnet" },
    ]);
    inline_keyboard.push([{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]);
    
    try {
        await botInstance.editMessageCaption(messageText, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard }
        });
    } catch (e) {
        await botInstance.editMessageText(messageText + 
        "\n\n⚠ Чтобы использовать кнопки, перейдите в главное меню, и затем обратно сюда! (временный баг)", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard }
        });
    }
    
    logActivity(`Admin ${chatId} requested ip subnets list (page ${page})`);
}

export async function handleSubnetCreation(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    
    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]
    ];
    
    const text = `📌 Напишите список IP в виде:\nName: название\nList: список IP через запятую\n<b>ИЛИ</b>\nSource: функция источника`
    
    const reply = await botInstance.editMessageCaption(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
    });
    
    db.updateUser(chatId, { state: { action: 'admin_subnet_creation', messageId: (reply as Message).message_id }})
    
    logActivity(`Admin ${chatId} started config creation`);
}

export async function handleSubnetCreationText(userId: number, input: string) {
    const user = db.getUser(userId);
    
    const args = input.split('\n');
    
    const name   = args.find(x => x.startsWith('Name: '))?.slice('Name: '.length);
    const ips    = args.find(x => x.startsWith('List: '))?.slice('List: '.length)?.split(',')?.map(x => x.trim());
    const source = args.find(x => x.startsWith('Source: '))?.slice('Source: '.length);
    
    if (!name) { await botInstance.sendMessage(userId, "Вы не указали имя списка (Name: )"); return }
    else if (name.length < 4 || name.length > 20)
               { await botInstance.sendMessage(userId, "Имя списка не вписывается в диапазон 4 - 20 символов."); return }
    if (!ips && !source) { await botInstance.sendMessage(userId, "Вы не указали список или источник."); return }
    
    const subnets = db.getSubnets();
    const keys = Object.keys(subnets);
    const latestIdx: number = +keys[keys.length - 1];
    subnets[latestIdx + 1] = {
        name,
        creator: userId,
        createdAt: Date.now(),
        ...(ips ? { ips } : {}),
        ...(source ? { source } : {}),
    }
    
    if (user?.state?.messageId)
        botInstance.deleteMessage(userId, user.state.messageId);
    await botInstance.sendMessage(userId, `Список IP успешно создан.`);
    
    db.updateUser(userId, { state: undefined });
    
    logActivity(`Admin ${userId} finished config creation`);
}

export async function handleSubnetDeletion(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    
    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]
    ];
    
    const text = `📌 Напишите идентификатор списка IP для удаления`
    const reply = await botInstance.editMessageCaption(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
    });
    
    db.updateUser(chatId, { state: { action: 'admin_subnet_deletion', messageId: (reply as Message).message_id }})
    
    logActivity(`Admin ${chatId} started config deletion`);
}

export async function handleSubnetDeletionText(userId: number, input: string) {
    const user = db.getUser(userId);
    
    const subnets: Record<string, Subnet> = db.getSubnets();
    
    const subnet = subnets[input];
    if (!subnet) { await botInstance.sendMessage(userId, "Список IP с данным ID не найден."); return }
    
    delete subnets[input];
    
    if (user?.state?.messageId)
        botInstance.deleteMessage(userId, user.state.messageId);
    await botInstance.sendMessage(userId, `Список IP успешно удален.`);
    
    db.updateUser(userId, { state: undefined });
    
    logActivity(`Admin ${userId} finished config deletion`);
}

export async function handleSubnetInfo(userId: number, id: number) {
    //const user = db.getUser(userId);
    
    const subnets: Record<string, Subnet> = db.getSubnets();
    
    const subnet = subnets[id];
    if (!subnet) { await botInstance.sendMessage(userId, "Список IP с данным ID не найден."); return }
    
    try {
        let ips = [];
        if (subnet.ips?.length) ips = subnet.ips;
        else if (subnet.source) {
            ips = await sourceEval(subnet.source);
        }
        
        const output = ips.slice(0, 20).join(', ') + (ips.length > 20 ? ( ' и ещё ' + (ips.length - 20) ) : '');
        await botInstance.sendMessage(userId, `Список IP: ${output}` + (subnet.source ? `\n\nФункция: ${subnet.source}` : ''));
        
        logActivity(`Admin ${userId} finished config deletion`);
    } catch (e) {
        logActivity(`Couldn't get subnet #${id} info for admin ${userId}`);
        await botInstance.sendMessage(userId, `Не удалось получить список IP!`);
    }
}

export async function handleAdminListAllConfigs(chatId: number, page: number, messageId: number) {
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
    const inline_keyboard: InlineKeyboardButton[][] = [];

    pageConfigs.forEach((config, indexOnPage) => {
        const globalIndex = startIndex + indexOnPage;
        const ownerIdentifier = config.ownerUsername ? `@${config.ownerUsername}` : `ID: ${config.ownerId}`;
        const totalTraffic = (config.totalTx || 0) + (config.totalRx || 0);
        const statusIcon = config.isEnabled ? '✅' : '❌';

        messageText += `\n${statusIcon} <b>"${config.userGivenName}"</b> (от ${ownerIdentifier}, трафик: ${getUsageText(totalTraffic)})`;
        inline_keyboard.push([{ text: `"${config.userGivenName}" от ${ownerIdentifier}`, callback_data: `admin_view_cfg_idx_${globalIndex}` }]);
    });

    const paginationButtons: InlineKeyboardButton[] = [];
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
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: Math.pow(2, 32),
        caption: messageText,
        keyboard: inline_keyboard
    });

    logActivity(`Admin ${chatId} requested all configs list (page ${page}) - WIP`);
}

const logs_keyboard = [[{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]];

export async function handleAdminViewLogs(chatId: number, messageId: number) {
    try {
        const logContent = await Bun.file('data/activity.log').text();
        const lines = logContent.split('\n').filter((line: string) => line.trim() !== '');
        const lastNLines = lines.slice(-20).join('\n');
        if (lastNLines) {
            const caption = `Последние логи:\n<i>${lastNLines.slice(0, 900)}</i>`;
            // @ts-ignore
            await botInstance.sendCachedMedia(chatId, messageId, {
                media: "empty.png",
                uniqueKey: 'empty',
                expiresIn: Math.pow(2, 32),
                caption,
                keyboard: logs_keyboard
            });
            if (lastNLines.length > 900) 
                await botInstance.sendMessage(chatId, '<i>' + lastNLines.slice(900, 1900) + '</i>', {
                    parse_mode: 'HTML',
                });
        } else {
            // @ts-ignore
            await botInstance.sendCachedMedia(chatId, messageId, {
                media: "empty.png",
                uniqueKey: 'empty',
                expiresIn: Math.pow(2, 32),
                caption: "Файл логов пуст.",
                keyboard: logs_keyboard
            });
        }
    } catch (error) {
        await botInstance.sendMessage(chatId, "Не удалось прочитать файл логов.");
        logActivity(`Admin ${chatId} failed to read logs: ${error}`);
    }
    logActivity(`Admin ${chatId} requested logs view - WIP`);
}

export async function handleAdminShowUsageStats(chatId: number, messageId: number) {
    try {
        const allConfigs = db.getAllConfigs();

        if (allConfigs.length === 0) {
            await botInstance.sendMessage(chatId, "Нет созданных конфигураций для отображения статистики.", {
                reply_markup: { inline_keyboard: logs_keyboard }
            });
            return;
        }

        const configUsage = allConfigs.map(config => {
            const totalUsage = (config.totalRx || 0) + (config.totalTx || 0);
            const ownerIdentifier = config.ownerUsername ? `@${config.ownerUsername}` : `ID ${config.ownerId}`;
            return {
                name: `"${config.userGivenName}" от ${ownerIdentifier}`,
                usage: totalUsage,
            };
        }).sort((a, b) => b.usage - a.usage);
        
        const keyboard = [
            [{ text: "🔄 Обновить", callback_data: "admin_show_usage_stats" }],
            [{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]
        ];
        
        function getImage() {
            return generateTopUsersChart(configUsage);
        }
        
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            media: getImage,
            uniqueKey: 'top-configs',
            expiresIn: 60 * 1000,
            caption: '📊 <b>Топ конфигураций по общему потреблению трафика</b>',
            keyboard,
        });
        
        logActivity(`Admin ${chatId} viewed config usage stats chart.`);
    } catch (error) {
        console.error("Failed to generate or send config usage chart:", error);
        logActivity(`Failed to generate or send config usage chart for admin ${chatId}: ${error}`);
        await botInstance.sendMessage(chatId, "⚠️ Не удалось создать график статистики.");
    }
}

export async function handleAdminViewUser(chatId: number, userIdToView: number, messageId: number) {
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

    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "🚫 Отозвать доступ", callback_data: `admin_revoke_access_ask_${user.id}` }],
        [{ text: "⬅️ К списку пользователей", callback_data: "admin_list_users_page_0" }],
        [{ text: "⬅️ Назад в админ-меню", callback_data: "admin_main_menu" }]
    ];
    
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: Math.pow(2, 32),
        caption: messageText.slice(0, 1024),
        keyboard: inline_keyboard
    });
    
    if (messageText.length >= 1024) await botInstance.sendMessage(chatId, messageText.slice(1024), { parse_mode: 'HTML' })
    
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
    } catch (e: any) {
        logActivity(`Failed to notify user ${userIdToRevoke} about access revocation: ${e.message}`);
    }
    await handleAdminListUsers(adminChatId, 0, undefined);
}


export async function handleAdminViewConfig(chatId: number, ownerId: number, messageId: number, wgEasyClientId: string) {
    try {
        const owner = db.getUser(ownerId);
        if (!owner) {
            await botInstance.sendMessage(chatId, "Владелец конфигурации не найден.");
            return;
        }
        const config = owner.configs.find(c => c.wgEasyClientId === wgEasyClientId);
        if (!config) {
            await botInstance.sendMessage(chatId, "Конфигурация не найдена у указанного владельца.");
            return;
        }

        const deviceName = devices.find(d => d.id === config.deviceId)?.name || 'Неизвестное устройство';
        const creationDate = new Date(config.createdAt).toLocaleString('ru-RU');
        const ownerIdentifier = owner.username ? `@${owner.username}` : `ID ${owner.id}`;

        let text = `👑 <b>Админ: Детали конфигурации</b>\n\n`;
        text += `<b>Имя:</b> "${config.userGivenName}"\n`;
        text += `<b>Владелец:</b> ${ownerIdentifier} (ID: ${ownerId})\n`;
        text += `<b>Устройство:</b> ${deviceName} (ID: ${config.deviceId})\n`;
        text += `<b>Создан:</b> ${creationDate}\n`;
        text += `<b>Статус:</b> ${config.isEnabled ? "✅ Активен" : "❌ Отключен"}\n`;

        const totalTx = config.totalTx || 0;
        const totalRx = config.totalRx || 0;
        const bandwidth = `${getUsageText(totalTx)} скачано, ${getUsageText(totalRx)} отправлено`;
        text += `<b>Трафик:</b> ${bandwidth}\n\n`;

        text += `<b>Клиент ID (wg-easy):</b> ${config.wgEasyClientId}`;

        const allConfigs = db.getAllConfigs();
        const globalConfigIndex = allConfigs.findIndex(c => c.ownerId === ownerId && c.wgEasyClientId === wgEasyClientId);
        if (globalConfigIndex === -1) {
            await botInstance.sendMessage(chatId, "Ошибка: не удалось найти глобальный индекс конфигурации.");
            return;
        }

        const inline_keyboard: InlineKeyboardButton[][] = [
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
        
        function getImage() {
            if (!config?.dailyUsage) return 'empty.png'; 
            return generateMonthlyUsageChart(config.dailyUsage);
        }
        
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            media: getImage,
            uniqueKey: 'empty',
            expiresIn: Math.pow(2, 32),
            caption: text,
            keyboard: inline_keyboard
        });
    } catch (error) {
        console.error(`Admin failed to show config details with chart for ${wgEasyClientId}:`, error);
        logActivity(`Admin failed to show config details with chart for ${wgEasyClientId}: ${error}`);
        await botInstance.sendMessage(chatId, `⚠️ Не удалось загрузить детали конфигурации с графиком.`);
    }
}

// Действия с конфигурациями от имени администратора (скачивание, QR, вкл/выкл, удаление)
// Эти функции будут очень похожи на userFlow.handleConfigAction, но с префиксом 'admin_'
// и будут принимать ownerId.
// userFlow.handleConfigAction, вызывая соответствующие wgAPI функции
// и обновляя состояние конфига в db.updateUser(ownerId, ...).

export async function handleAdminConfigAction(chatId: number, actionWithPrefix: string, configIdentifier: string, messageId: number) {
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
            await botInstance.sendMessage(chatId, "Ошибка: неверный индекс конфигурации.");
            return;
        }
        const targetFullConfig = allConfigs[globalIndex];
        ownerId = targetFullConfig.ownerId;
        wgEasyClientId = targetFullConfig.wgEasyClientId;
        owner = db.getUser(ownerId);
        if (!owner) { await botInstance.sendMessage(chatId, "Владелец конфигурации не найден."); return; }
        configIndexInDb = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
        if (configIndexInDb === -1) { await botInstance.sendMessage(chatId, "Конфигурация не найдена у владельца."); return; }
        config = owner.configs[configIndexInDb];
    } else {
        const parts = configIdentifier.split('_');
        ownerId = parseInt(parts[0]);
        wgEasyClientId = parts[1];
        owner = db.getUser(ownerId);
        if (!owner) { await botInstance.sendMessage(chatId, "Владелец конфигурации не найден."); return; }
        configIndexInDb = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
        if (configIndexInDb === -1) { await botInstance.sendMessage(chatId, "Конфигурация не найдена у владельца."); return; }
        config = owner.configs[configIndexInDb];
    }

    if (!owner || !config) return;

    logActivity(`Admin ${chatId} performing action '${action}' on config ${wgEasyClientId} of user ${ownerId}`);

    // Пример для disable:
    if (action === 'disable') {
        if (await wgAPI.disableWgClient(wgEasyClientId)) {
            owner.configs[configIndexInDb].isEnabled = false;
            db.updateUser(ownerId, { configs: owner.configs });
            logActivity(`Admin ${chatId} disabled config ${wgEasyClientId} for user ${ownerId}`);
            await handleAdminViewConfig(chatId, ownerId, messageId, wgEasyClientId);
        } else {
            await botInstance.sendMessage(chatId, "Не удалось отключить конфигурацию через API.");
        }
        return;
    }

    // TODO: Реализовать остальные действия: enable, delete_ask, delete_confirm, dl_config, qr_config
    // dl_config и qr_config будут похожи на userFlow, просто отправляя файлы админу.
    // delete_ask должен показать подтверждение с callback_data `admin_delete_cfg_confirm_idx_${globalIndex}`
    // delete_confirm должен удалить из wgAPI и из db, затем показать список всех конфигов.

    await botInstance.sendMessage(chatId, `Действие '${action}' для конфига ${wgEasyClientId} (владелец ${ownerId}) в разработке.`);
}
