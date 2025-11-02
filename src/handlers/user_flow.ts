import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { getWgConnectionInfo, getTotalBandwidthUsage, lastHourUsage, hourlyUsageHistory, getMonthlyUsage } from '$/api/connections';
import { getBotUsername } from '$/bot';
import { handleAdminViewConfig, handleAdminListAllConfigs } from '$/handlers/admin_flow'
import { User, Device, UserConfig, DailyUsage, AppConfig, Subnet } from '$/db/types';
import { getUsageText, escapeConfigName } from '$/utils/text'
import { generateUsageChart, generateMonthlyUsageChart } from '$/utils/chart';
import { logActivity } from '$/utils/logger';
import * as wgAPI from '$/api/wg_easy_api';
import { isMediaCached } from '$/utils/images';
import { getAllowedIPs, sourceEval } from '$/utils/ips';
import * as db from '$/db/index';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'node:fs';


let botInstance: TelegramBot;
let devices: Device[];
let appConfigInstance: AppConfig;

export function initUserFlow(bot: TelegramBot, loadedDevices: Device[], appCfg: AppConfig) {
    botInstance = bot;
    devices = loadedDevices;
    appConfigInstance = appCfg;
}

export async function handleStart(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const username = msg.from?.username || `${msg.from?.first_name} ${msg.from?.last_name || ''}`.trim();

    const user = db.ensureUser(userId, username);

    if (appConfigInstance.adminTelegramIds.includes(userId)) {
        if (!user.hasAccess) {
            user.hasAccess = true;
            user.accessGrantedAt = new Date().toISOString();
            db.updateUser(userId, { hasAccess: true, accessGrantedAt: user.accessGrantedAt });
            logActivity(`Admin ${userId} (${username}) started the bot. Access granted/confirmed.`);
        }
    }
    
    const hasSharedConfigs = db.getAllConfigs().some(c => c.sharedWith === userId);

    if (user.hasAccess || user.configs?.length || hasSharedConfigs) {
        await showMainMenu(chatId, userId);
    } else {
        const request = db.getAccessRequest(userId);
        if (request) {
            await botInstance.sendMessage(chatId, "Ваш запрос на доступ уже отправлен и ожидает рассмотрения администратором.");
        } else {
            await botInstance.sendMessage(chatId, "Для использования бота необходимо получить доступ. Хотите отправить запрос администратору?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Запросить доступ", callback_data: `request_access` }]
                    ]
                }
            });
        }
    }
}

export async function handleStartWithToken(msg: TelegramBot.Message, token: string): Promise<boolean> {
    const ownershipToken = db.getOwnershipToken(token);
    if (ownershipToken) {
        const newOwnerId = msg.from!.id;
        const newOwnerUsername = msg.from!.username || msg.from!.first_name;
        
        if (newOwnerId === ownershipToken.creatorId) {
            await botInstance.sendMessage(newOwnerId, "Вы не можете использовать собственную пригласительную ссылку.");
            return true;
        }

        const creator = db.getUser(ownershipToken.creatorId);
        if (!creator) {
            await botInstance.sendMessage(msg.chat.id, "⚠️ Владелец конфигурации не найден. Ссылка больше не действительна.");
            db.removeOwnershipToken(token);
            return true;
        }
        
        const config = creator.configs.find(c => c.userGivenName === ownershipToken.configName && c.deviceId === ownershipToken.deviceId);
        if (!config) {
            await botInstance.sendMessage(msg.chat.id, "⚠️ Конфигурация, связанная с этой ссылкой, не найдена. Возможно, она была удалена.");
            db.removeOwnershipToken(token);
            return true;
        }

        config.sharedWith = newOwnerId;
        db.updateUser(creator.id, { configs: creator.configs });

        await botInstance.sendMessage(newOwnerId, `✅ Вы получили доступ к конфигурации "${config.userGivenName}".`);
        await botInstance.sendMessage(ownershipToken.creatorId, `Пользователь @${newOwnerUsername} (ID: ${newOwnerId}) активировал вашу ссылку и получил доступ к конфигурации "${config.userGivenName}".`);
        db.removeOwnershipToken(token);
        await showMainMenu(newOwnerId, newOwnerId);
        return true;
    }
    await botInstance.sendMessage(msg.chat.id, "⚠️ Ссылка для получения конфигурации недействительна или уже была использована.");
    return false;
}


function getMainKeyboard(canCreateConfigs: boolean, isAdmin: boolean): InlineKeyboardButton[][] {
    const merge = canCreateConfigs || isAdmin;
    const keyboard: InlineKeyboardButton[][] = [];

    if (merge) {
        keyboard.push([
            { text: "➕ Wireguard", callback_data: "create_wg_config_start" },
            { text: "📄 Мои конфиги", callback_data: "list_my_configs_page_0" },
        ]);
    } else {
        keyboard.push([{ text: "📄 Мои конфиги", callback_data: "list_my_configs_page_0" }]);
    }

    keyboard.push([{ text: "⚙️ Настройки", callback_data: "personal_settings" }]);

    if (isAdmin) {
        keyboard.push([{ text: "👑 Админ-панель", callback_data: "admin_main_menu" }]);
    }

    return keyboard;
}

export async function showMainMenu(chatId: number, userId: number, messageId?: number) {
    const user = db.getUser(userId);
    if (!user) {
        await botInstance.sendMessage(chatId, "Ошибка отправки меню.")
        return;
    }
    
    db.updateUser(userId, { state: undefined });
    const isAdmin = appConfigInstance.adminTelegramIds.includes(userId);

    const bottomKeyboard: TelegramBot.KeyboardButton[][] = [
        [{ text: "⚡ Открыть главное меню" }],
        [{ text: "✍️ Обратная связь" }],
    ];
    
    const inline_keyboard: InlineKeyboardButton[][] = getMainKeyboard(user.hasAccess, isAdmin);
    
    const hourlyStats = `📊 <b>Статистика за час</b>`
                      + `\nСкачано ${getUsageText(lastHourUsage.tx)}, загружено ${getUsageText(lastHourUsage.rx)}`;
    const top = `🌟 <b>Главное меню</b>`;
    const caption = `${top}\n\n${hourlyStats}`;
    
    const mediaCached = isMediaCached("start");
    
    let placeholderMessage;
    
    if (!messageId) {
        placeholderMessage = await botInstance.sendMessage(chatId, "🔄 Загрузка статистики...", { 
            reply_markup: { keyboard: bottomKeyboard, resize_keyboard: true, one_time_keyboard: false },
        });
    }
    
    try {
        async function getMediaFunction() {
            if (user === undefined) return "empty.png";
            const currentHour = new Date().getUTCHours() + user.settings.utc;
            
            const hourlyUsageWithHours = hourlyUsageHistory
                .slice(0, user.settings.chart?.fullDay ? 24 : (currentHour % 24 + 1))
                .map((usage, idx) => ({ ...usage, hour: currentHour - idx }))
                .reverse();
            
            return await generateUsageChart(hourlyUsageWithHours, user.settings)
        }
        
        // TODO fix
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            uniqueKey: 'start-' + user.settings.utc, // TODO full settings hash instead of just only utc
            media: getMediaFunction,
            expiresIn: 60 * 1000,
            caption,
            keyboard: inline_keyboard,
        })
    } catch (error) {
        console.error("Failed to generate or send usage chart:", error);
        logActivity(`Failed to generate or send usage chart for user ${userId}: ${error}`);
		await botInstance.sendMessage(chatId, `${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
			parse_mode: 'HTML',
			reply_markup: { inline_keyboard, resize_keyboard: true, one_time_keyboard: false },
		});
    }
}

export async function handleRequestAccess(chatId: number, userId: number, username?: string) {
    const adminIds = appConfigInstance.adminTelegramIds;
    const userIdentifier = username ? `@${username}` : `ID ${userId}`;
    
    try {
        // TODO send all admins
        const adminMessage = await botInstance.sendMessage(adminIds[0],
            `Пользователь ${userIdentifier} (ID: ${userId}) запрашивает доступ к боту.`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ Одобрить", callback_data: `approve_access_${userId}` },
                            { text: "❌ Отказать", callback_data: `deny_access_${userId}` }
                        ]
                    ]
                }
            }
        );
        db.addAccessRequest(userId, username, adminMessage.message_id);
        await botInstance.sendMessage(chatId, "Ваш запрос на доступ отправлен администратору. Ожидайте решения.");
        logActivity(`Access request sent to admin for user ${userId} (${username}). Admin msg ID: ${adminMessage.message_id}`);
    } catch (error: any) {
        console.error("Error sending access request to admin:", error);
        logActivity(`Error sending access request to admin for ${userId}: ${error}`);
        await botInstance.sendMessage(chatId, "Не удалось отправить запрос администратору. Пожалуйста, попробуйте позже.");
        if (error.response && error.response.body && error.response.body.description) {
            await botInstance.sendMessage(chatId, `Ошибка Telegram: ${error.response.body.description}`);
        }
    }
}

export async function handleCreateWgConfigStart(chatId: number, userId: number, messageId: number) {
    const user = db.ensureUser(userId);
    if (!user.hasAccess) {
        await botInstance.sendMessage(chatId, "У вас нет доступа для создания конфигураций.");
        return;
    }

    const inline_keyboard = [
		...devices.map(device => ([{ text: device.name, callback_data: `select_device_${device.id}` }])),
		[{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]
	];
    
    // @ts-ignore
	await botInstance.sendCachedMedia(chatId, messageId, {
		media: "empty.png",
		uniqueKey: 'empty',
		expiresIn: 999999999,
		caption: "Выберите тип устройства для конфигурации:",
		keyboard: inline_keyboard
	})
}

export async function handleDeviceSelection(chatId: number, userId: number, messageId: number, deviceId: string) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        await botInstance.sendMessage(chatId, "Неверный тип устройства.");
        return;
    }
    
    const reply = await botInstance.editMessageCaption(
            `Вы выбрали: <b>${device.name}</b>.\nТеперь введите имя для этой конфигурации (например, "Мой ноутбук" или "Телефон Мамы").\n\nДля отмены нажмите кнопку ниже или введите /start.`,
            {
                parse_mode: 'HTML',
                chat_id: chatId, message_id: messageId,
                reply_markup: {
                inline_keyboard: [[{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]]
            }
    });
    
    // @ts-ignore
    db.updateUser(userId, { state: { action: 'awaiting_config_name', data: { deviceId: device.id }, messageId: reply.message_id } });
}

export async function handleConfigNameInput(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const configName = msg.text;

    if (!configName || configName.trim().length === 0) {
        await botInstance.sendMessage(chatId, "Имя конфигурации не может быть пустым. Пожалуйста, введите имя.");
        return;
    }
    if (configName.length > 50) {
        await botInstance.sendMessage(chatId, "Имя конфигурации слишком длинное (максимум 50 символов). Пожалуйста, введите более короткое имя.");
        return;
    }
    
    const user = db.getUser(userId);
    if (!user || !user.state || user.state.action !== 'awaiting_config_name' || !user.state.data || !user.state.data.deviceId) {
        await botInstance.sendMessage(chatId, "Произошла ошибка или вы не завершили предыдущее действие. Пожалуйста, начните заново с /start.");
        db.updateUser(userId, { state: undefined });
        return;
    }
    
    const deviceToShow = devices.find(d => d.id === user.state?.data?.deviceId);
    
    if (deviceToShow) {
        try {
            await botInstance.editMessageReplyMarkup({ inline_keyboard: [[{ text: "✅ Завершено", callback_data: "noop" }]] }, {
                chat_id: chatId,
                // @ts-ignore
                message_id: user.state?.messageId
            });
        } catch (e) {
            console.log("Ошибка необязательного редактирования (user_flow.ts->handleConfigNameInput)")
        }
    }
    
    const reply = await botInstance.sendMessage(chatId, 
      `✅ Имя конфигурации: "<b>${configName}</b>".\n\nТеперь выберите, кому будет принадлежать эта конфигурация.`, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: "👤 Это для меня", callback_data: "config_owner_self" }],
                [{ text: "🔗 Сгенерировать ссылку для другого", callback_data: "config_owner_link" }],
                [{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]
            ]
        },
    });
    
    db.updateUser(userId, { state: { action: 'selecting_owner', 
                 data: { ...user.state.data, configName }, messageId: reply.message_id } });
}

export async function handleAssignConfigToSelf(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    if (!user || !user.state || user.state.action !== 'selecting_owner' || !user.state.data) {
        await botInstance.sendMessage(chatId, "Произошла ошибка. Пожалуйста, начните заново.");
        db.updateUser(userId, { state: undefined });
        return;
    }
    const { configName, deviceId } = user.state.data;
    await createConfig(userId, userId, configName, deviceId, userId, true);
    await botInstance.editMessageText(`✅ Конфигурация "<b>${configName}</b>" создана и добавлена в ваш список.`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Главное меню", callback_data: "user_main_menu" }]] }
    });
    db.updateUser(userId, { state: undefined });
}

export async function handleGenerateOwnershipLink(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    if (!user || !user.state || user.state.action !== 'selecting_owner' || !user.state.data) {
        await botInstance.sendMessage(chatId, "Произошла ошибка. Пожалуйста, начните заново.");
        db.updateUser(userId, { state: undefined });
        return;
    }
    const { configName, deviceId } = user.state.data;
    const token = randomBytes(16).toString('hex');

    const botUsername = getBotUsername();
    const link = `https://t.me/${botUsername}?start=${token}`;

    await botInstance.editMessageText(`✅ <b>Ссылка для передачи конфигурации создана.</b>\n\nОтправьте эту ссылку человеку, которому предназначен конфиг. Ссылка одноразовая.\n\n<code>${link}</code>`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Главное меню", callback_data: "user_main_menu" }]] }
    });
    
    // Создаем конфиг сразу, чтобы ссылка была на уже существующий
    await createConfig(userId, userId, configName, deviceId, userId, true);
    
    db.addOwnershipToken({
        token,
        creatorId: userId,
        configName,
        deviceId, // Используем для поиска конфига
        createdAt: new Date().toISOString()
    });
    db.updateUser(userId, { state: undefined });
}

async function createConfig(creatorId: number, chatId: number, configName: string, deviceId: string, ownerId: number, silent: boolean = false) {
    const wgClientName = `user${ownerId}_${deviceId}_${Date.now()}`;
    
    const { message_id: savedMessageId } = await botInstance.sendMessage(chatId, `🔄 Создаю конфигурацию "${configName}" для устройства... Пожалуйста, подождите!`);
    
    try {
        
        const newClient = await wgAPI.createWgClient(wgClientName);
        if (!newClient || !newClient.id) {
            await botInstance.editMessageText(`❌ Не удалось создать конфигурацию wg-easy "${configName}"\nПопробуйте позже`, {
                chat_id: chatId,
                message_id: savedMessageId
            });
            logActivity(`Failed to create wg-easy client for user ${ownerId}, name ${wgClientName}`);
            return;
        }
        
        const owner: User = db.ensureUser(ownerId);
        
        const userConfig: UserConfig = {
            creator: creatorId,
            userGivenName: configName,
            wgEasyClientId: newClient.id,
            deviceId: deviceId,
            createdAt: new Date().toISOString(),
            isEnabled: true,
        };
        
        owner.configs.push(userConfig);
        db.updateUser(ownerId, { configs: owner.configs, state: undefined });
        
        if (!silent) {
            logActivity(`User ${creatorId} created config for ${ownerId}: ${configName} (wgID: ${newClient.id})`);
            await botInstance.editMessageText(`✅ Конфигурация "${configName}" успешно создана!`, {
                chat_id: chatId,
                message_id: savedMessageId
            });
        } else await botInstance.deleteMessage(chatId, savedMessageId);

        // const configFileContent = await wgAPI.getClientConfiguration(newClient.id);
        // if (typeof configFileContent === 'string' && configFileContent.length > 0) {
        //     await botInstance.sendDocument(chatId, Buffer.from(configFileContent), {
        //         caption: `📦 Файл конфигурации для "${configName}"`,
        //     }, {
        //         filename: `${escapeConfigName(configName)}.conf`,
        //         contentType: 'text/plain',
        //     });
        // } else {
        //     logActivity(`Failed to get config file content for ${newClient.id} in handleConfigNameInput. Content: ${configFileContent}`);
        //     await botInstance.sendMessage(chatId, "📦 Не удалось получить файл конфигурации.");
        // }
        // 
        // // Отправка QR-кода
        // const qrCodeBuffer = await wgAPI.getClientQrCodeSvg(newClient.id);
        // if (qrCodeBuffer instanceof Buffer && qrCodeBuffer.length > 0) {
        //     logActivity(`Attempting to send QR code photo (PNG) for ${newClient.id}. Buffer length: ${qrCodeBuffer.length}`);
        //     await botInstance.sendPhoto(chatId, qrCodeBuffer, {
        //         caption: `📸 QR-код для "${configName}"`
        //     }, {});
        // } else {
        //     logActivity(`Failed to get QR code buffer for ${newClient.id} in handleConfigNameInput. Buffer: ${qrCodeBuffer}`);
        //     await botInstance.sendMessage(chatId, "📸 Не удалось получить QR-код.");
        // }
        
        if (chatId === creatorId && !silent) await showMainMenu(chatId, creatorId, undefined);
    } catch (error : any) {
        console.error("Error in config creation flow:", error);
        logActivity(`Error creating config for user ${ownerId}: ${error}`);
        await botInstance.sendMessage(chatId, "Произошла критическая ошибка при создании конфигурации. Пожалуйста, попробуйте позже.");
        db.updateUser(creatorId, { state: undefined });
    }
}


export async function handleListMyConfigs(chatId: number, userId: number, messageId: number, page: number) {
    let user = db.getUser(userId);
    const hasSharedConfigs = db.getAllConfigs().some(c => c.sharedWith === userId);

    if (!user || (!user.hasAccess && !user.configs.length && !hasSharedConfigs)) {
        await botInstance.sendMessage(chatId, "У вас нет доступа или конфигураций.");
        return;
    }
    
    // Собираем все конфиги: и свои, и расшаренные
    const ownedConfigs = user.configs.map(c => ({ ...c, ownerId: user!.id, isOwner: true }));
    const sharedConfigs = db.getAllConfigs()
        .filter(c => c.sharedWith === userId)
        .map(c => ({ ...c, isOwner: false }));

    const allVisibleConfigs = [...ownedConfigs, ...sharedConfigs];

    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "⬅️ Назад в меню", callback_data: "user_main_menu" }]
    ];
    
    if (user.hasAccess) inline_keyboard.unshift([{ text: "➕ Создать новую", callback_data: "create_wg_config_start" }])
    
    // Проверяем общее количество видимых конфигов
    if (allVisibleConfigs.length === 0) {
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            media: "config_list.png",
            uniqueKey: 'configs',
            expiresIn: 999999999,
            caption: "У вас пока нет созданных конфигураций.",
            keyboard: inline_keyboard
        })
        return;
    }
    
    const insert = (row: InlineKeyboardButton[]) => {
		const len = inline_keyboard.length;
		inline_keyboard.splice(user.hasAccess ? (len - 2) : (len - 1), 0, row)
	}

    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(allVisibleConfigs.length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageConfigs = allVisibleConfigs.slice(startIndex, endIndex);
    
    let caption = `📄 <b>Ваши конфигурации</b> (Страница ${currentPage + 1}/${totalPages}):\n\n`;
    
    let itemsInCurrentRow = 0;
    let currentRowSymbolsLength = 0;
    let currentRow: InlineKeyboardButton[] = [];
    let insertedButtons = [];
    
    pageConfigs.forEach((config, index) => {
        const globalIndex = startIndex + index;
        const deviceName = devices.find(d => d.id === config.deviceId)?.name || '...';
        
        const connectionInfo = getWgConnectionInfo(config.wgEasyClientId);
        
        let usedLastDay = false;
        const latestHandshakeAt = connectionInfo?.latestHandshakeAt || config.latestHandshakeAt;
        
        if(latestHandshakeAt) {
            const usedAt = new Date(latestHandshakeAt);
            usedLastDay = Date.now() - usedAt.getTime() < 24 * 60 * 60 * 1000;
        }
        const symbol = !config.isEnabled ? '❌' : usedLastDay ? '✅' : '💤';
        
        const totalTraffic = (config.totalTx || 0) + (config.totalRx || 0);
        const ownerPrefix = config.isOwner ? '' : '🤝 ';
        caption += `<b>${globalIndex + 1}.</b> ${symbol} ${ownerPrefix}${config.userGivenName} (${deviceName}, трафик: ${getUsageText(totalTraffic)})\n`;
        
        const button = { text: `${ownerPrefix}${config.userGivenName}`, callback_data: `view_config_${config.ownerId}_${config.wgEasyClientId}` }
        const userGivenLength = config.userGivenName.length
        
        /* Группируем кнопки в одну строчку */
        if(itemsInCurrentRow === 3 || (currentRowSymbolsLength + userGivenLength) >= 25) {
            if(currentRow.length > 0) insert(currentRow);
            
            itemsInCurrentRow = 1
            currentRowSymbolsLength = userGivenLength
            currentRow = [ button ]
        }
        else {
            itemsInCurrentRow++
            currentRowSymbolsLength += userGivenLength
            currentRow.push(button)
        }
    });
    
    /* Завершаем клавиатуру */
    insert(currentRow);
    
    /* Немного статистики */
    const [ totalRx, totalTx ] = getTotalBandwidthUsage(allVisibleConfigs)
    caption += `\n📊 Всего скачано ${getUsageText(totalTx)}, отправлено ${getUsageText(totalRx)}`
    
    const paginationButtons: InlineKeyboardButton[] = [];
    if (currentPage > 0) {
        paginationButtons.push({ text: "⬅️", callback_data: `list_my_configs_page_${currentPage - 1}` });
    }
	
    paginationButtons.push({ text: `${currentPage + 1} / ${totalPages}`, callback_data: "noop" }); // noop - ничего не делать
    if (currentPage < totalPages - 1) {
        paginationButtons.push({ text: "➡️", callback_data: `list_my_configs_page_${currentPage + 1}` });
    }

    if (paginationButtons.length > 0) {
        insert(paginationButtons);
    }
    
    try {
        // TODO fix
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            media: "config_list.png",
            uniqueKey: 'configs',
            expiresIn: 999999999,
            caption,
            keyboard: inline_keyboard
        })
        
        db.updateUser(userId, { state: { action: 'viewing_config_list', data: { messageId } } });
    } catch (e: any) {
        console.log("Ошибка", e)
        
        const sentMessage = await botInstance.sendMessage(chatId, caption, { reply_markup: { inline_keyboard }, parse_mode: 'HTML' });
        db.updateUser(userId, { state: { action: 'viewing_config_list', data: { messageId: sentMessage.message_id } } });
    }
}

export async function handleViewConfig(chatId: number, currentUserId: number, messageId: number, ownerId: number, wgEasyClientId: string) {
    const owner = db.getUser(ownerId);
    if (!owner) { await botInstance.sendMessage(chatId, "Владелец конфигурации не найден."); return; }

    const config = owner.configs.find(c => c.wgEasyClientId === wgEasyClientId);
    if (!config) {
        await botInstance.sendMessage(chatId, "Конфигурация не найдена.");
        await handleListMyConfigs(chatId, currentUserId, messageId, 0);
        return;
    }

    try {
        const deviceName = devices.find(d => d.id === config.deviceId)?.name || 'Неизвестное устройство';
        const creationDate = new Date(config.createdAt).toLocaleString('ru-RU');
        
        const conInfo = getWgConnectionInfo(wgEasyClientId);
        const totalTx = config.totalTx || 0;
        const totalRx = config.totalRx || 0;
        const bandwidth = `${getUsageText(totalTx)} скачано, ${getUsageText(totalRx)} отправлено`;
        
        let usedLastDay = false;
        const latestHandshakeAt = conInfo?.latestHandshakeAt || config.latestHandshakeAt;
        
        if(latestHandshakeAt) {
            const usedAt = new Date(latestHandshakeAt);
            usedLastDay = Date.now() - usedAt.getTime() < 24 * 60 * 60 * 1000;
        }
        const status = !config.isEnabled ? '❌ Отключен' : usedLastDay ? '✅ Активен' : `💤 Не использовался 24 часа`;
        
        const isOwner = owner.id === currentUserId;
        const ownerIdentifier = isOwner ? "Вы" : (owner.username ? `@${owner.username}` : `ID ${owner.id}`);

        let text = `ℹ️ <b>Детали конфигурации:</b>\n\n`;
        text += `<b>Имя:</b> ${config.userGivenName}\n`;
        text += `<b>Устройство:</b> ${deviceName}\n`;
        text += `<b>Владелец:</b> ${ownerIdentifier}\n`;
        text += `<b>Создан:</b> ${creationDate}\n`;
        text += `<b>Статус:</b> ${status}\n`;
        text += `<b>Трафик:</b> ${bandwidth}\n`
        text += `<b>ID (wg-easy):</b> ${config.wgEasyClientId}`;

        const callbackPrefix = `ca_${ownerId}_${wgEasyClientId}`;

        const inline_keyboard: InlineKeyboardButton[][] = [
            [
                { text: "📥 Скачать (.conf)", callback_data: `cf_${ownerId}_${wgEasyClientId} open 0` },
                { text: "📱 QR-код", callback_data: `${callbackPrefix}_qr` }
            ],
            [
                config.isEnabled
                    ? { text: "🚫 Отключить", callback_data: `${callbackPrefix}_d` }
                    : { text: "▶️ Включить", callback_data: `${callbackPrefix}_e` } // eslint-disable-line
            ],
        ];

        if (isOwner) {
            if (config.sharedWith) {
                const sharedUser = db.getUser(config.sharedWith);
                const sharedUserIdentifier = sharedUser?.username ? `@${sharedUser.username}` : `ID ${config.sharedWith}`;
                inline_keyboard.push([{ text: `🚫 Забрать у ${sharedUserIdentifier}`, callback_data: `${callbackPrefix}_r` }]);
            } else {
                inline_keyboard.push([{ text: "🔗 Поделиться", callback_data: `${callbackPrefix}_s` }]);
            }
            
            inline_keyboard.push([{ text: "🗑 Удалить", callback_data: `${callbackPrefix}_da` }]);
        }
        inline_keyboard.push([{ text: "⬅️ К списку конфигов", callback_data: `list_my_configs_page_0` }]);
        inline_keyboard.push([{ text: "⬅️ Главное меню", callback_data: "user_main_menu" }]);
        
        async function getMediaFunction() {
            if (config === undefined) return "empty.png";
            return await generateMonthlyUsageChart(config.dailyUsage || []);
        }
        
        // TODO fix
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            uniqueKey: 'config-' + config.wgEasyClientId,
            media: getMediaFunction,
            expiresIn: 60 * 1000,
            caption: text,
            keyboard: inline_keyboard,
        })
    } catch (error) {
        console.error(`Failed to show config details with chart for ${wgEasyClientId}:`, error);
        logActivity(`Failed to show config details with chart for ${wgEasyClientId}: ${error}`);
        await botInstance.editMessageText(`⚠️ Не удалось загрузить детали конфигурации с графиком.`, {
            chat_id: chatId,
            message_id: messageId,
        });
    }
}

export async function handleConfigFile(chatId: number, currentUserId: number, messageId: number, ownerId: number, wgEasyClientId: string, action: string, currentPage: number) {
    const owner = db.getUser(ownerId);
    if (!owner) { await botInstance.sendMessage(chatId, "Владелец не найден."); return; }
    
    const configIndex = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
    
    if (configIndex === -1) {
        await botInstance.sendMessage(chatId, "❓ Конфигурация не найдена.");
        return;
    }
    
    const config = owner.configs[configIndex];
    const userForSubnets = db.getUser(currentUserId)!; // Используем текущего юзера для его настроек сабнетов
    
    const allSubnets: Record<string, Subnet> = db.getSubnets();
    const allExistingKeys = Object.keys(allSubnets);
    Object.keys(userForSubnets.subnets).forEach(subnetId => {
        if (!allExistingKeys.includes(subnetId)) delete userForSubnets.subnets[subnetId];
    })
    // TODO do updateUser
    
    async function show(user: User, ownerId: number) {
        let caption = `📥 <b>Настройка AllowedIPs</b>`
                   + `\nЗдесь вы можете указать, какой трафик будет проходить через VPN.`
                   + `\n\nРежим «Только плюсы» (➕): через VPN пойдёт только трафик к выбранным сервисам. Остальной — напрямую.`
                   + `\nРежим «Только минусы» (➖): весь трафик пойдёт через VPN, кроме трафика к выбранным сервисам.`
                   + `\n\n<b>Обозначения:</b>\n✖ — не используется\n➕ — трафик к сервису идёт через VPN\n➖ — трафик к сервису идёт в обход VPN`;
        
        const inline_keyboard: InlineKeyboardButton[][] = [];
        const subButtons: InlineKeyboardButton[] = [];
        
		const subnetEntries = Object.entries(allSubnets);
		//const subnetKeys = Object.keys TODO optimize (don't use Object.entries)
		
        subnetEntries.slice(currentPage * 6, currentPage * 6 + 6)
			.forEach(([ subnetId, subnet ]) => {
				const status = user.subnets[subnetId]; // undefined, true, false
				const emoji = status === undefined ? '✖' : status ? '➕' : '➖';
				
				subButtons.unshift({ text: `${emoji} ${subnet.name}`, callback_data: `cf_${ownerId}_${wgEasyClientId} swap-${subnetId} ${currentPage}` });
			});
        
        for (let i = 0; i < subButtons.length; i += 2) {
            inline_keyboard.push([ subButtons[i] ])
            if (subButtons[i + 1])
                inline_keyboard[Math.floor(i / 2)].push(subButtons[i + 1]);
        }
		
		const totalPages = Math.ceil(subnetEntries.length / 6);
        
		const paginationButtons: InlineKeyboardButton[] = [];
        if (currentPage > 0)
			paginationButtons.push({ text: "⬅️", callback_data: `cf_${ownerId}_${wgEasyClientId} open ${currentPage - 1}` });
		if (totalPages > 1)
			paginationButtons.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: `noop ${Math.random()}` }); // UPD: изредка бывают ошибки "markup wasn't changed", здесь фикс
		if (currentPage < totalPages - 1)
			paginationButtons.push({ text: "➡️", callback_data: `cf_${ownerId}_${wgEasyClientId} open ${currentPage + 1}` });
		
        inline_keyboard.push(paginationButtons);
        inline_keyboard.push([{ text: "✅ Получить конфиг", callback_data: `cf_${ownerId}_${wgEasyClientId} get` }]);
        inline_keyboard.push([{ text: "⬅️ Вернуться", callback_data: `view_config_${ownerId}_${wgEasyClientId}` }]);
		
        // @ts-ignore
		await botInstance.sendCachedMedia(chatId, messageId, {
            uniqueKey: 'empty',
            media: 'empty.png',
            expiresIn: Math.pow(2, 32),
            caption,
            keyboard: inline_keyboard,
        })
    }
    
    try {
        if (action === 'get') {
            let fileContent = await wgAPI.getClientConfiguration(wgEasyClientId);
            if (typeof fileContent === 'string' && fileContent.length > 0) {
                const subnetKeys = Object.keys(userForSubnets.subnets);
                
                let prefix = "";
                
                if (subnetKeys.length !== 0) {
                    const subnets: [string, boolean][] = Object.entries(userForSubnets.subnets);
                    
                    let allowed: string[] = [];
                    let blocked: string[] = [];
                    
                    // TODO if source, then do caching (each X minutes)
                    
                    for (const [ id ] of subnets.filter(e => e[1] === true)) {
                        const subnet = allSubnets[id];
                        if (subnet.ips?.length) allowed = [ ...allowed, ...subnet.ips ];
                        if (subnet.source) allowed = [ ...allowed, ...await sourceEval(subnet.source) ];
                    }
                    
                    for (const [ id ] of subnets.filter(e => e[1] === false)) {
                        const subnet = allSubnets[id];
                        if (subnet.ips?.length) blocked = [ ...blocked, ...subnet.ips ];
                        if (subnet.source) blocked = [ ...blocked, ...await sourceEval(subnet.source) ];
                    }
                    
                    if (!allowed.length) allowed = [ "0.0.0.0/0" ];
                    
                    const allowedIPs = getAllowedIPs(allowed, blocked).join(','); // вычисление
                    
                    const lines = fileContent.split('\n');
                    
                    const aiLine = lines.findIndex(l => l.startsWith('AllowedIPs'));
                    if (aiLine === -1) throw new Error("No AllowedIPs line found");
                    
                    lines[aiLine] = 'AllowedIPs = ' + allowedIPs;
                    fileContent = lines.join('\n');
                    
                    try {
                        prefix = '-' + new Bun.CryptoHasher("sha1")
                                              .update(allowedIPs).digest('hex').slice(0, 4);
                    } catch (e) {
                        console.log('Prefix error!')
                    }
                }
                
                await handleViewConfig(chatId, currentUserId, messageId, ownerId, wgEasyClientId);
                await botInstance.sendDocument(chatId, Buffer.from(fileContent), {}, {
                    filename: `${escapeConfigName(config.userGivenName)}${prefix}.conf`,
                    contentType: 'text/plain'
                });
                logActivity(`User ${currentUserId} downloaded config ${config.userGivenName} (ID: ${wgEasyClientId})`);
            } else {
                logActivity(`Failed to get config file content for ${wgEasyClientId} in handleConfigAction (dl_config). Content: ${fileContent}`);
                await botInstance.sendMessage(chatId, "Не удалось получить файл конфигурации.");
            }
        }
        else if (action?.startsWith('swap')) {
            const subnet: number = +action.split('-')[1];
            
            const entry: boolean = userForSubnets.subnets[subnet];
            
            if (entry === undefined) userForSubnets.subnets[subnet] = true;
            else if (entry === true) userForSubnets.subnets[subnet] = false;
            else delete userForSubnets.subnets[subnet];
            
            db.updateUser(currentUserId, { subnets: userForSubnets.subnets });
            
            await show(userForSubnets, ownerId);
        }
        else if (action === 'open') {
            await show(userForSubnets, ownerId);
        }
    } catch (e: any) {
        console.log('Ошибка', e);
        await botInstance.sendMessage(chatId, "Произошла неизвестная ошибка.");
    }
}

export async function handleConfigAction(chatId: number, currentUserId: number, messageId: number, action: string, ownerId: number, wgEasyClientId: string, callbackQueryId: string, isAdminAction: boolean = false) {
    const owner = db.getUser(ownerId);
    if (!owner) { await botInstance.sendMessage(chatId, "Владелец конфигурации не найден."); return; }

    const configIndex = owner.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
    
    if (configIndex === -1) {
        await botInstance.sendMessage(chatId, "❓ Конфигурация не найдена.");
        return;
    }
    const config = owner.configs[configIndex];

    try {
        const refreshView = async () => {
            if (isAdminAction) {
                await handleAdminViewConfig(chatId, ownerId, messageId, wgEasyClientId);
            } else {
                await handleViewConfig(chatId, currentUserId, messageId, ownerId, wgEasyClientId);
            }
        };
        switch (action) {
            case 'qr':
                const qrBuffer = await wgAPI.getClientQrCodeSvg(wgEasyClientId);
                if (qrBuffer instanceof Buffer && qrBuffer.length > 0) {
                    logActivity(`Attempting to send QR code photo (PNG) for config ${wgEasyClientId}. Buffer length: ${qrBuffer.length}`);
                    await botInstance.sendPhoto(chatId, qrBuffer, {
                        caption: `QR-код для ${config.userGivenName}`
                    }, {});
                    logActivity(`User ${currentUserId} requested QR photo (PNG) for config ${config.userGivenName} (ID: ${wgEasyClientId})`);
                } else {
                    logActivity(`Failed to get QR code buffer for ${wgEasyClientId} in handleConfigAction (qr_config). Buffer: ${qrBuffer}`);
                    await botInstance.sendMessage(chatId, "Не удалось получить QR-код.");
                }
                break;
            case 'd':
                if (await wgAPI.disableWgClient(wgEasyClientId)) {
                    owner.configs[configIndex].isEnabled = false;
                    db.updateUser(ownerId, { configs: owner.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" отключена.` }); // callback_query_handler
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} disabled config ${config.userGivenName} (ID: ${wgEasyClientId}) for user ${ownerId}`);
                    await refreshView();
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось отключить конфигурацию.");
                }
                break;
            case 'e':
                if (await wgAPI.enableWgClient(wgEasyClientId)) {
                    owner.configs[configIndex].isEnabled = true;
                    db.updateUser(ownerId, { configs: owner.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" включена.` }); // callback_query_handler
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} enabled config ${config.userGivenName} (ID: ${wgEasyClientId}) for user ${ownerId}`);
                    await refreshView();
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось включить конфигурацию.");
                }
                break;
            case 'da':
                await botInstance.sendMessage(chatId, `Вы уверены, что хотите удалить конфигурацию "${config.userGivenName}"? Это действие необратимо.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🗑 Да, удалить", callback_data: `ca_${ownerId}_${wgEasyClientId}_dc` }],
                            [{ text: "⬅️ Нет, отмена", callback_data: `view_config_${ownerId}_${wgEasyClientId}` }]
                        ]
                    }
                });
                break;
            case 'dc':
                if (await wgAPI.deleteWgClient(wgEasyClientId)) {
                    const sharedWithId = config.sharedWith;
                    const newConfigs = owner.configs.filter(c => c.wgEasyClientId !== wgEasyClientId);
                    db.updateUser(ownerId, { configs: newConfigs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" удалена.` }); // callback_query_handler
                    await botInstance.sendMessage(chatId, `➖ Конфигурация "${config.userGivenName}" удалена.`); // TODO: edit message instead of sending new one
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} deleted config ${config.userGivenName} (ID: ${wgEasyClientId}) of user ${ownerId}`);
                    if (isAdminAction) await handleAdminListAllConfigs(chatId, 0, messageId);
                    else await handleListMyConfigs(chatId, currentUserId, messageId, 0);

                    if (sharedWithId) {
                        const sharedUser = db.getUser(sharedWithId);
                        if (sharedUser) {
                            const hasOtherConfigs = sharedUser.configs.length > 0 || db.getAllConfigs().some(c => c.sharedWith === sharedWithId);
                            if (!sharedUser.hasAccess && !hasOtherConfigs) {
                                await botInstance.sendMessage(sharedWithId, `Владелец отозвал у вас доступ к конфигурации "${config.userGivenName}".\n\nТак как у вас не осталось других конфигураций, доступ к боту ограничен. Для повторного использования отправьте /start.`, {
                                    reply_markup: { remove_keyboard: true }
                                });
                            } else {
                                await botInstance.sendMessage(sharedWithId, `Владелец отозвал у вас доступ к конфигурации "${config.userGivenName}".`);
                            }
                        }
                    }
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось удалить конфигурацию.");
                }
                break;
            case 's': // Share
                if (config.sharedWith) {
                    await botInstance.answerCallbackQuery(callbackQueryId, { text: "Эта конфигурация уже используется другим пользователем." });
                    return;
                }

                const existingToken = db.findOwnershipTokenByConfig(ownerId, config.deviceId, config.userGivenName);
                let token: string;

                if (existingToken) {
                    token = existingToken.token;
                } else {
                    token = randomBytes(16).toString('hex');
                    db.addOwnershipToken({
                        token,
                        creatorId: ownerId,
                        configName: config.userGivenName,
                        deviceId: config.deviceId,
                        createdAt: new Date().toISOString()
                    });
                }

                const botUsername = getBotUsername();
                const link = `https://t.me/${botUsername}?start=${token}`;
                await botInstance.editMessageCaption(`✅ <b>Ссылка для передачи конфигурации "${config.userGivenName}" создана.</b>\n\nОтправьте эту ссылку человеку, которому предназначен конфиг. Ссылка одноразовая.\n\n<code>${link}</code>`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "⬅️ Вернуться к конфигу", callback_data: `view_config_${ownerId}_${wgEasyClientId}` }]] }
                });
                break;
            case 'r': // Revoke
                const sharedWithId = config.sharedWith;
                if (!sharedWithId) {
                    await botInstance.answerCallbackQuery(callbackQueryId, { text: "Конфигурация ни с кем не используется." });
                    return;
                }
                owner.configs[configIndex].sharedWith = undefined;
                db.updateUser(ownerId, { configs: owner.configs });
                logActivity(`User ${currentUserId} revoked access to config ${config.userGivenName} from user ${sharedWithId}`);
                
                const existingTokenForRevoked = db.findOwnershipTokenByConfig(ownerId, config.deviceId, config.userGivenName);
                if (existingTokenForRevoked) {
                    db.removeOwnershipToken(existingTokenForRevoked.token);
                }

                await botInstance.answerCallbackQuery(callbackQueryId, { text: "Доступ отозван." });
                const sharedUser = db.getUser(sharedWithId);
                if (sharedUser) {
                    const hasOtherConfigs = sharedUser.configs.length > 0 || db.getAllConfigs().some(c => c.sharedWith === sharedWithId);
                    if (!sharedUser.hasAccess && !hasOtherConfigs) {
                        await botInstance.sendMessage(sharedWithId, `Владелец отозвал у вас доступ к конфигурации "${config.userGivenName}".\n\nТак как у вас не осталось других конфигураций, доступ к боту ограничен. Для повторного использования отправьте /start.`, {
                            reply_markup: { remove_keyboard: true }
                        });
                    } else {
                        await botInstance.sendMessage(sharedWithId, `Владелец отозвал у вас доступ к конфигурации "${config.userGivenName}".`);
                    }
                }
                await refreshView();
                break;
        }
    } catch (error : any) {
        console.error(`Error processing config action ${action} for ${wgEasyClientId}:`, error);
        logActivity(`Error in config action ${action} for ${wgEasyClientId} by user ${currentUserId}: ${error}`);
        await botInstance.sendMessage(chatId, "Произошла ошибка при выполнении действия.");
    }
}

export async function handleRequestFeedback(chatId: number, userId: number) {
    db.updateUser(userId, { state: { action: 'awaiting_feedback' } });
    await botInstance.sendMessage(chatId, "Пожалуйста, опишите вашу проблему или оставьте отзыв. Администратор получит ваше сообщение.\n\nДля отмены введите /cancel.");
}

export async function handleFeedbackInput(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userId = msg.from!.id;
    const feedbackText = msg.text;
    const user = db.getUser(userId);

    if (!user || !user.state || user.state.action !== 'awaiting_feedback') return;

    const userContact = msg.from?.username ? `@${msg.from.username}` : `User ID: ${userId} (Имя: ${msg.from?.first_name || ''} ${msg.from?.last_name || ''})`.trim();
    const messageToAdmin = `🔔 Новое сообщение обратной связи от пользователя ${userContact}:\n\n"${feedbackText}"`;

    try {
        for (const id of appConfigInstance.adminTelegramIds) {
            await botInstance.sendMessage(id, messageToAdmin)
        };
        await botInstance.sendMessage(chatId, "Спасибо! Ваше сообщение отправлено администратору.");
        logActivity(`User ${userId} sent feedback: "${feedbackText}"`);
    } catch (error : any) {
        logActivity(`Failed to send feedback from ${userId} to admin: ${error}`);
        await botInstance.sendMessage(chatId, "Не удалось отправить сообщение администратору. Пожалуйста, попробуйте позже.");
    } finally {
        db.updateUser(userId, { state: undefined });
    }
}
