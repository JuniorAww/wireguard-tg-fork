import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { getWgConnectionInfo, getTotalBandwidthUsage, lastHourUsage, hourlyUsageHistory, getMonthlyUsage } from '$/api/connections';
import { handleAdminViewConfig, handleAdminListAllConfigs } from '$/handlers/admin_flow'
import { User, Device, UserConfig, DailyUsage, AppConfig, CallbackButton, Subnet } from '$/db/types';
import { getUsageText, escapeConfigName } from '$/utils/text'
import { generateUsageChart, generateMonthlyUsageChart } from '$/utils/chart';
import { logActivity } from '$/utils/logger';
import * as wgAPI from '$/api/wg_easy_api';
import { isMediaCached } from '$/utils/images';
import { getAllowedIPs, sourceEval } from '$/utils/ips';
import * as db from '$/db';
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
    
    if (user.hasAccess || user.configs?.length) {
        await showMainMenu(chatId, userId);
    }
    else {
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

export async function showMainMenu(chatId: number, userId: number, messageId?: number) {
    const user = db.getUser(userId);
    if (!user) {
        console.log('No user');
        await botInstance.sendMessage(chatId, "Ошибка отправки меню.")
        return;
    }
    
    db.updateUser(userId, { state: undefined });
    const isAdmin = appConfigInstance.adminTelegramIds.includes(userId);

    const bottomKeyboard: TelegramBot.KeyboardButton[][] = [
        [{ text: "⚡ Открыть главное меню" }],
        [{ text: "❓ Плохо работает VPN" }],
    ];
    
    const inline_keyboard: CallbackButton[][] = [
        [{ text: "📄 Мои конфиги", callback_data: "list_my_configs_page_0" }],
        [{ text: "⚙️ Настройки (WIP)", callback_data: "personal_settings" }],
    ];
    
    if (user.hasAccess) {
        inline_keyboard[0].unshift({ text: "➕ Wireguard", callback_data: "create_wg_config_start" })
    }
    
    if (isAdmin) {
        inline_keyboard.push([{ text: "👑 Админ-панель", callback_data: "admin_main_menu" }]);
    }
    
    const hourlyStats = `📊 <b>Статистика за час</b>`
                      + `\nСкачано ${getUsageText(lastHourUsage.tx)}, загружено ${getUsageText(lastHourUsage.rx)}`;
    const top = `🌟 <b>Главное меню</b>`;
    const caption = `${top}\n\n${hourlyStats}`;
    
    const mediaCached = isMediaCached("start");
    
    let placeholderMessage;
    
    if (!mediaCached) {
        placeholderMessage = await botInstance.sendMessage(chatId, "🔄 Загрузка статистики...", { 
            reply_markup: { keyboard: bottomKeyboard, resize_keyboard: true, one_time_keyboard: false },
        });
    }
    
    try {
        async function getMediaFunction() {
            const currentHour = new Date().getUTCHours();
            
            const hourlyUsageWithHours = hourlyUsageHistory
                .map((usage, hour) => ({ ...usage, hour }))
                .slice(0, currentHour + 1);
            
            return await generateUsageChart(hourlyUsageWithHours)
        }
        
        // TODO fix
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            uniqueKey: 'start',
            media: getMediaFunction,
            expiresIn: 60 * 1000,
            caption,
            keyboard: inline_keyboard,
        })
        
        if (messageId && placeholderMessage)
			await botInstance.deleteMessage(chatId, placeholderMessage.message_id);
    } catch (error) {
        console.error("Failed to generate or send usage chart:", error);
        logActivity(`Failed to generate or send usage chart for user ${userId}: ${error}`);
        try {
            if (!placeholderMessage)
                await botInstance.sendMessage(chatId, `${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard, resize_keyboard: true, one_time_keyboard: false },
                });
            else
                await botInstance.editMessageText(`${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
                    chat_id: chatId,
                    message_id: placeholderMessage.message_id,
                    parse_mode: 'HTML',
                });
        } catch (editError) {
            console.error("Failed to edit caption on error, sending new message:", editError);
            await botInstance.sendMessage(chatId, `${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard, resize_keyboard: true, one_time_keyboard: false },
            });
        }
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

    const deviceButtons = devices.map(device => ([{ text: device.name, callback_data: `select_device_${device.id}` }]));

    deviceButtons.push([{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]);
    
    botInstance.deleteMessage(chatId, messageId);
    
    await botInstance.sendMessage(chatId, "Выберите тип устройства для конфигурации:", {
        reply_markup: {
            inline_keyboard: deviceButtons,
        }
    });
}

export async function handleDeviceSelection(chatId: number, userId: number, messageId: number, deviceId: string) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        await botInstance.sendMessage(chatId, "Неверный тип устройства.");
        return;
    }
    
    const reply = await botInstance.editMessageText(
            `Вы выбрали: <b>${device.name}</b>.\nТеперь введите имя для этой конфигурации (например, "Мой ноутбук" или "Телефон Мамы").\n\nДля отмены нажмите кнопку ниже или введите /cancel.`,
            {
                parse_mode: 'HTML',
                chat_id: chatId, message_id: messageId,
                reply_markup: {
                inline_keyboard: [[{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]]
            }
    });
    
    // @ts-ignore
    db.updateUser(userId, { state: { action: 'awaiting_config_name', data: { deviceId }, messageId: reply.message_id } });
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
        botInstance.editMessageText(`<b>Выбранное устройство:</b> ${deviceToShow.name}\n<b>Имя конфига:</b> ${configName}`, {
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Завершено", callback_data: "noop" }]]
            },
            parse_mode: 'HTML',
            chat_id: chatId,
            message_id: user.state?.messageId, 
        })
    }
    
    const reply = await botInstance.sendMessage(chatId, 
      "Теперь вы можете выбрать владельца конфига (если конфиг предназначен другому человеку)"
    + "\nЧтобы указать - перешлите любое сообщение от владельца в этот диалог (аккаунт не должен быть приватным!)", {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: "➖ Пропустить шаг", callback_data: "config_owner_skip" }],
                [{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]
            ]
        },
    });
    
    db.updateUser(userId, { state: { action: 'awaiting_owner', 
                 data: { ...user.state.data, configName }, messageId: reply.message_id } });
}

export async function handleConfigOwnerInput(msg: TelegramBot.Message, skip: boolean, inline: boolean = false) {
    const chatId = msg.chat.id;
    const userId = inline ? chatId : msg.from!.id;
    
    let ownerId: number;
    let ownerDisplay: string;
    
    if (skip) {
        ownerId = +userId;
        ownerDisplay = msg.chat.first_name + ' (вы)';
    }
    else {
        if (!msg.forward_from?.id) {
            await botInstance.sendMessage(chatId, "Пожалуйста, перешлите сообщение от пользователя, на которого хотите повесить конфиг!");
            return;
        }
        
        ownerId = msg.forward_from.id;
        ownerDisplay = msg.forward_from.first_name;
    }
    
    const user = db.getUser(userId);
    if (!user) return;
    
    const { configName, deviceId } = user.state?.data || {};
    
    if (!user || !user.state || user.state.action !== 'awaiting_owner'
     || !configName || !deviceId) {
        await botInstance.sendMessage(chatId, "Произошла ошибка или вы не завершили предыдущее действие. Пожалуйста, начните заново с /start.");
        db.updateUser(userId, { state: undefined });
        return;
    }
    
    const deviceToShow = devices.find(d => d.id === deviceId);
    if (deviceToShow) {
        botInstance.editMessageText(`<b>Выбранное устройство:</b> ${deviceToShow.name}`
                                  + `\n<b>Имя конфига:</b> ${configName}`
                                  + `\n<b>Владелец:</b> ID ${ownerDisplay}`, {
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Завершено", callback_data: "noop" }]]
            },
            parse_mode: 'HTML',
            chat_id: chatId,
            message_id: user.state?.messageId, 
        });
    }
    
    await createConfig(user, ownerId, chatId, configName, deviceId, ownerId);
}

async function createConfig(user: User, userId: number, chatId: number, configName: string, deviceId: string, ownerId: number) {
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
            creator: userId,
            userGivenName: configName,
            wgEasyClientId: newClient.id,
            deviceId: deviceId,
            createdAt: new Date().toISOString(),
            isEnabled: true,
        };
        
        owner.configs.push(userConfig);
        db.updateUser(ownerId, { configs: owner.configs, state: undefined });
        
        logActivity(`User ${userId} created config for ${ownerId}: ${configName} (wgID: ${newClient.id})`);
        await botInstance.editMessageText(`✅ Конфигурация "${configName}" успешно создана!`, {
            chat_id: chatId,
            message_id: savedMessageId
        });

        const configFileContent = await wgAPI.getClientConfiguration(newClient.id);
        if (typeof configFileContent === 'string' && configFileContent.length > 0) {
            await botInstance.sendDocument(chatId, Buffer.from(configFileContent), {
                caption: `📦 Файл конфигурации для "${configName}"`,
                // @ts-ignore
                contentType: 'text/plain',
            }, {
                filename: `${escapeConfigName(configName)}.conf`,
                contentType: 'text/plain',
            });
        } else {
            logActivity(`Failed to get config file content for ${newClient.id} in handleConfigNameInput. Content: ${configFileContent}`);
            await botInstance.sendMessage(chatId, "📦 Не удалось получить файл конфигурации.");
        }

        // Отправка QR-кода
        const qrCodeBuffer = await wgAPI.getClientQrCodeSvg(newClient.id);
        if (qrCodeBuffer instanceof Buffer && qrCodeBuffer.length > 0) {
            logActivity(`Attempting to send QR code photo (PNG) for ${newClient.id}. Buffer length: ${qrCodeBuffer.length}`);
            await botInstance.sendPhoto(chatId, qrCodeBuffer, {
                caption: `📸 QR-код для "${configName}"`
            }, {});
        } else {
            logActivity(`Failed to get QR code buffer for ${newClient.id} in handleConfigNameInput. Buffer: ${qrCodeBuffer}`);
            await botInstance.sendMessage(chatId, "📸 Не удалось получить QR-код.");
        }
        
        await showMainMenu(chatId, userId, undefined);
    } catch (error : any) {
        console.error("Error in config creation flow:", error);
        logActivity(`Error creating config for user ${ownerId}: ${error}`);
        await botInstance.sendMessage(chatId, "Произошла ошибка при создании конфигурации. Пожалуйста, попробуйте позже.");
        db.updateUser(userId, { state: undefined });
    }
}


export async function handleListMyConfigs(chatId: number, userId: number, messageId: number, page: number) {
    const user = db.getUser(userId);
    if (!user || !user.hasAccess && !user.configs.length) {
        await botInstance.sendMessage(chatId, "У вас нет доступа или конфигураций.");
        return;
    }
    
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
		[{ text: "⬅️ Назад в меню", callback_data: "user_main_menu" }]
    ];
    
    if (user.hasAccess) inline_keyboard.unshift([{ text: "➕ Создать новую", callback_data: "create_wg_config_start" }])
    
    const configs = user.configs;
    if (configs.length === 0) {
        /*await botInstance.sendMessage(chatId, "У вас пока нет созданных конфигураций.", {
            reply_markup: {
                inline_keyboard
            }
        });*/
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
    const totalPages = Math.ceil(configs.length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageConfigs = configs.slice(startIndex, endIndex);
    
    let caption = `📄 <b>Ваши конфигурации</b> (Страница ${currentPage + 1}/${totalPages}):\n\n`;
    
    let itemsInCurrentRow = 0;
    let currentRowSymbolsLength = 0;
    let currentRow: CallbackButton[] = [];
    let insertedButtons = [];
    
    pageConfigs.forEach((config, index) => {
        const globalIndex = startIndex + index;
        const deviceName = devices.find(d => d.id === config.deviceId)?.name || 'Неизвестное устройство';
        
        const connectionInfo = getWgConnectionInfo(config.wgEasyClientId);
        
        let usedLastDay = false;
        const latestHandshakeAt = connectionInfo?.latestHandshakeAt || config.latestHandshakeAt;
        
        if(latestHandshakeAt) {
            const usedAt = new Date(latestHandshakeAt);
            usedLastDay = Date.now() - usedAt.getTime() < 24 * 60 * 60 * 1000;
        }
        const symbol = !config.isEnabled ? '❌' : usedLastDay ? '✅' : '💤';
        
        const totalTraffic = (config.totalTx || 0) + (config.totalRx || 0);
        caption += `<b>${globalIndex + 1}.</b> ${symbol} ${config.userGivenName} (${deviceName}, трафик: ${getUsageText(totalTraffic)})\n`;
        
        const button = { text: `${config.userGivenName}`, callback_data: `view_config_${config.wgEasyClientId}` }
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
    const [ totalRx, totalTx ] = getTotalBandwidthUsage(configs)
    caption += `\n📊 Всего скачано ${getUsageText(totalTx)}, отправлено ${getUsageText(totalRx)}`
    
    const paginationButtons: TelegramBot.InlineKeyboardButton[] = [];
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
    
    let sentMessage;
    
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

export async function handleViewConfig(chatId: number, userId: number, messageId: number, wgEasyClientId: string) {
    const user = db.getUser(userId);
    if (!user) return;

    const config = user.configs.find(c => c.wgEasyClientId === wgEasyClientId);
    if (!config) {
        await botInstance.sendMessage(chatId, "Конфигурация не найдена.");
        await handleListMyConfigs(chatId, userId, messageId, 0);
        return;
    }

    let placeholderMessage = 
        isMediaCached('config-' + wgEasyClientId) ? undefined :
        await botInstance.sendMessage(chatId, `🔄 Загрузка деталей для "${config.userGivenName}"...`);

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
        
        let text = `ℹ️ <b>Детали конфигурации:</b>\n\n`;
        text += `<b>Имя:</b> ${config.userGivenName}\n`;
        text += `<b>Устройство:</b> ${deviceName}\n`;
        text += `<b>Создан:</b> ${creationDate}\n`;
        text += `<b>Статус:</b> ${status}\n`;
        text += `<b>Трафик:</b> ${bandwidth}\n`
        text += `<b>ID (wg-easy):</b> ${config.wgEasyClientId}`;

        const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: "📥 Скачать (.conf)", callback_data: `config_file_${wgEasyClientId}` },
                { text: "📱 QR-код", callback_data: `qr_config_${wgEasyClientId}` }
            ],
            /*[
                { text: "📱 QR-код", callback_data: `qr_config_${wgEasyClientId}` }
            ],*/
            [
                config.isEnabled
                    ? { text: "🚫 Отключить", callback_data: `disable_config_${wgEasyClientId}` }
                    : { text: "▶️ Включить", callback_data: `enable_config_${wgEasyClientId}` }
            ],
            [
                { text: "🗑 Удалить", callback_data: `delete_config_ask_${wgEasyClientId}` }
            ],
            [{ text: "⬅️ К списку конфигов", callback_data: `list_my_configs_page_0` }],
            [{ text: "⬅️ Главное меню", callback_data: "user_main_menu" }]
        ];
        
        async function getMediaFunction(usage: DailyUsage[]) {
            return await generateMonthlyUsageChart(usage);
        }
        
        // TODO fix
        // @ts-ignore
        await botInstance.sendCachedMedia(chatId, messageId, {
            uniqueKey: 'config-' + config.wgEasyClientId,
            media: (config: UserConfig) => getMediaFunction(config?.dailyUsage || []),
            expiresIn: 60 * 1000,
            caption: text,
            keyboard: inline_keyboard,
        })
        
        if (placeholderMessage)
            await botInstance.deleteMessage(chatId, placeholderMessage.message_id);
    } catch (error) {
        console.error(`Failed to show config details with chart for ${wgEasyClientId}:`, error);
        logActivity(`Failed to show config details with chart for ${wgEasyClientId}: ${error}`);
        await botInstance.editMessageText(`⚠️ Не удалось загрузить детали конфигурации с графиком.`, {
            chat_id: chatId,
            message_id: messageId,
        });
    }
}

export async function handleConfigFile(chatId: number, userId: number, messageId: number, wgEasyClientId: string, action: string) {
    const user = db.getUser(userId);
    if (!user) return;
    
    console.log(wgEasyClientId)

    const configIndex = user.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
    console.log('wg easy id ',wgEasyClientId)
    if (configIndex === -1) {
        await botInstance.sendMessage(chatId, "❓ Конфигурация не найдена.");
        return;
    }
    
    const config = user.configs[configIndex];
    
    if (!user.subnets) {
        user.subnets = {};
        db.updateUser(userId, { subnets: {} });
    }
    
    const allSubnets: Record<string, Subnet> = db.getSubnets();
    const allExistingKeys = Object.keys(allSubnets);
    Object.keys(user.subnets).forEach(subnetId => {
        if (!allExistingKeys.includes(subnetId)) delete user.subnets[subnetId];
    })
    // TODO do updateUser
    
    async function show(user: User) {
        let caption = `📥 <b>Настройка .conf</b>`
                   + `\nВы можете настроить разрешения (AllowedIPs), чтобы конфиг работал только на определенных сервисах`
                   + `\n<b>Внимание:</b> разрешения плохо работают на Linux!`;
        
        const buttons = [];
        
        const subButtons: CallbackButton[] = [];
        
        Object.entries(allSubnets)
          .filter(([ subnetId ]) => user.subnets[subnetId] === undefined)
          .forEach(([ subnetId, subnet ]) => {
              subButtons.unshift({ text: `✖ ${subnet.name}`, callback_data: `config_file_${wgEasyClientId} swap-${subnetId}` });
          });
        
        /*let allowedAmount = 0;
        let blockedAmount = 0;*/
        
        Object.entries(user.subnets).forEach(([ subnetId, enabled ]) => {
            const emoji = enabled ? '➕' : '➖';
            /*if (enabled) allowedAmount += allSubnets[subnetId].ips?.length;
            else         blockedAmount += allSubnets[subnetId].ips?.length;*/
            subButtons.unshift({ text: `${emoji} ${allSubnets[subnetId]?.name}`, callback_data: `config_file_${wgEasyClientId} swap-${subnetId}` })
        });
        
        /*caption += `\n<b>Разрешенных IP:</b> ${allowedAmount === 0 ? 'все' : allowedAmount}`
        caption += `\n<b>Исключенных IP:</b> ${(allowedAmount > 0 && blockedAmount === 0) ? 'все' : blockedAmount}`*/
        
        for (let i = 0; i < subButtons.length; i += 2) {
            buttons.push([ subButtons[i] ])
            if (subButtons[i + 1]) {
                buttons[Math.floor(i / 2)].push(subButtons[i + 1])
            }
        }
        
        buttons.push([{ text: "✅ Получить конфиг", callback_data: `config_file_${wgEasyClientId} get` }]);
        
        const reply_markup = {
            inline_keyboard: buttons
        }
        
        await botInstance.editMessageCaption(caption, {
            parse_mode: 'HTML',
            chat_id: chatId,
            message_id: messageId,
            reply_markup,
        });
    }
    
    try {
        if (action === 'get') {
            let fileContent = await wgAPI.getClientConfiguration(wgEasyClientId);
            if (typeof fileContent === 'string' && fileContent.length > 0) {
                const subnetKeys = Object.keys(user.subnets);
                
                if (subnetKeys.length !== 0) {
                    const subnets: [string, boolean][] = Object.entries(user.subnets);
                    
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
                    
                    console.log('allowed/blocked size', allowed.length, blocked.length);
                    const sum = getAllowedIPs(allowed, blocked);
                    console.log('sum size', sum.length);
                    
                    const lines = fileContent.split('\n');
                    console.log(lines);
                    const aiLine = lines.findIndex(l => l.startsWith('AllowedIPs'));
                    if (aiLine === -1) throw new Error("No AllowedIPs line found");
                    
                    lines[aiLine] = 'AllowedIPs = ' + sum.join(',');
                    fileContent = lines.join('\n');
                }
                
                await handleViewConfig(chatId, userId, messageId, wgEasyClientId);
                await botInstance.sendDocument(chatId, Buffer.from(fileContent), {}, {
                    filename: `${escapeConfigName(config.userGivenName)}.conf`,
                    contentType: 'text/plain'
                });
                logActivity(`User ${userId} downloaded config ${config.userGivenName} (ID: ${wgEasyClientId})`);
            } else {
                logActivity(`Failed to get config file content for ${wgEasyClientId} in handleConfigAction (dl_config). Content: ${fileContent}`);
                await botInstance.sendMessage(chatId, "Не удалось получить файл конфигурации.");
            }
        }
        else if (action?.startsWith('swap')) {
            const subnet: number = +action.split('-')[1];
            
            const entry: boolean = user.subnets[subnet];
            
            if (entry === undefined) user.subnets[subnet] = true;
            else if (entry === true) user.subnets[subnet] = false;
            else delete user.subnets[subnet];
            
            db.updateUser(userId, { subnets: user.subnets });
            
            await show(user);
        }
        else {
            await show(user);
        }
    } catch (e) {
        console.log('Ошибка', e);
        await botInstance.sendMessage(chatId, "Произошла неизвестная ошибка.");
    }
}

export async function handleConfigAction(chatId: number, userId: number, messageId: number, action: string, wgEasyClientId: string, isAdminAction: boolean = false) {
    const user = db.getUser(userId);
    if (!user) return;

    const configIndex = user.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
    
    if (configIndex === -1) {
        await botInstance.sendMessage(chatId, "❓ Конфигурация не найдена.");
        return;
    }
    const config = user.configs[configIndex];

    try {
        const refreshView = async () => {
            if (isAdminAction) {
                await handleAdminViewConfig(chatId, userId, messageId, wgEasyClientId);
            } else {
                await handleViewConfig(chatId, userId, messageId, wgEasyClientId);
            }
        };
        switch (action) {
            case 'qr_config':
                const qrBuffer = await wgAPI.getClientQrCodeSvg(wgEasyClientId);
                if (qrBuffer instanceof Buffer && qrBuffer.length > 0) {
                    logActivity(`Attempting to send QR code photo (PNG) for config ${wgEasyClientId}. Buffer length: ${qrBuffer.length}`);
                    await botInstance.sendPhoto(chatId, qrBuffer, {
                        caption: `QR-код для ${config.userGivenName}`
                    }, {});
                    logActivity(`User ${userId} requested QR photo (PNG) for config ${config.userGivenName} (ID: ${wgEasyClientId})`);
                } else {
                    logActivity(`Failed to get QR code buffer for ${wgEasyClientId} in handleConfigAction (qr_config). Buffer: ${qrBuffer}`);
                    await botInstance.sendMessage(chatId, "Не удалось получить QR-код.");
                }
                break;
            case 'disable_config':
                if (await wgAPI.disableWgClient(wgEasyClientId)) {
                    user.configs[configIndex].isEnabled = false;
                    db.updateUser(userId, { configs: user.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" отключена.` }); // callback_query_handler
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} disabled config ${config.userGivenName} (ID: ${wgEasyClientId}) for user ${userId}`);
                    await refreshView();
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось отключить конфигурацию.");
                }
                break;
            case 'enable_config':
                if (await wgAPI.enableWgClient(wgEasyClientId)) {
                    user.configs[configIndex].isEnabled = true;
                    db.updateUser(userId, { configs: user.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" включена.` }); // callback_query_handler
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} enabled config ${config.userGivenName} (ID: ${wgEasyClientId}) for user ${userId}`);
                    await refreshView();
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось включить конфигурацию.");
                }
                break;
            case 'delete_config_ask':
                await botInstance.sendMessage(chatId, `Вы уверены, что хотите удалить конфигурацию "${config.userGivenName}"? Это действие необратимо.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🗑 Да, удалить", callback_data: `${isAdminAction ? 'admin_' : ''}delete_config_confirm_${isAdminAction ? `${userId}_${wgEasyClientId}` : wgEasyClientId}` }],
                            [{ text: "⬅️ Нет, отмена", callback_data: `del` }],
                            //[{ text: "⬅️ Нет, отмена", callback_data: `${isAdminAction ? `admin_view_config_${userId}_${wgEasyClientId}` : `view_config_${wgEasyClientId}`}` }],
                        ]
                    }
                });
                break;
            case 'delete_config_confirm':
                if (await wgAPI.deleteWgClient(wgEasyClientId)) {
                    user.configs.splice(configIndex, 1);
                    db.updateUser(userId, { configs: user.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" удалена.` }); // callback_query_handler
                    await botInstance.sendMessage(chatId, `➖ Конфигурация "${config.userGivenName}" удалена.`); // TODO: edit message instead of sending new one
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} deleted config ${config.userGivenName} (ID: ${wgEasyClientId}) of user ${userId}`);
                    if (isAdminAction) await handleAdminListAllConfigs(chatId, 0);
                    else await handleListMyConfigs(chatId, userId, messageId, 0);
                } else {
                    await botInstance.sendMessage(chatId, "Не удалось удалить конфигурацию.");
                }
                break;
        }
    } catch (error : any) {
        console.error(`Error processing config action ${action} for ${wgEasyClientId}:`, error);
        logActivity(`Error in config action ${action} for ${wgEasyClientId} by user ${userId}: ${error}`);
        await botInstance.sendMessage(chatId, "Произошла ошибка при выполнении действия.");
    }
}

export async function handleVpnHelp(chatId: number) {
    const helpText = `Если у вас возникли проблемы с работой VPN, попробуйте следующие шаги:

1️⃣ **Замените Endpoint в вашем конфигурационном файле или приложении WireGuard.**
   Найдите строку, начинающуюся с \`Endpoint = \` и замените текущий адрес на:
   \`Endpoint = 83.217.213.118:51820\`

   *Как это сделать?*
   - **На компьютере:** Откройте ваш \`.conf\` файл в текстовом редакторе, найдите строку \`Endpoint\` и измените значение после знака \`=\`. Сохраните файл и переподключитесь к VPN.
   - **На телефоне (в приложении WireGuard):**
     - Нажмите на ваш туннель (конфигурацию).
     - Нажмите на значок редактирования (обычно карандаш ✏️).
     - В разделе "ИНТЕРФЕЙС" или "PEERS" (в зависимости от приложения и версии) найдите поле "Конечная точка" или "Endpoint".
     - Измените его на \`83.217.213.118:51820\`.
     - Сохраните изменения и попробуйте подключиться снова.

2️⃣ **Если после смены Endpoint VPN вообще перестал работать или интернет пропал:**
   Попробуйте убрать галочку "Блокировать нетуннелированный трафик" (Kill-switch).
   - **На телефоне (в приложении WireGuard):**
     - Нажмите на ваш туннель (конфигурацию).
     - Нажмите на значок редактирования (обычно карандаш ✏️).
     - Найдите опцию "Блокировать нетуннелированный трафик" (может называться "Kill-switch" или похоже).
     - Снимите с нее галочку.
     - Сохраните изменения и попробуйте подключиться.
   *Примечание:* Эта опция повышает безопасность, но иногда может вызывать проблемы с подключением, если основной Endpoint недоступен.

Если эти шаги не помогли, пожалуйста, сообщите администратору.`;

    await botInstance.sendMessage(chatId, helpText, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "✍️ Обратная связь", callback_data: "request_feedback" }]
            ]
        }
    });
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
