import TelegramBot from 'node-telegram-bot-api';
import { getWgConnectionInfo, getTotalBandwidthUsage, lastHourUsage, hourlyUsageHistory, getMonthlyUsage } from '$/api/connections';
import { handleAdminViewConfig, handleAdminListAllConfigs } from '$/handlers/admin_flow'
import { User, Device, AppConfig, CallbackButton } from '$/db/types';
import { getUsageText, escapeConfigName } from '$/utils/text'
import { generateUsageChart, generateMonthlyUsageChart } from '$/utils/chart';
import { logActivity } from '$/utils/logger';
import * as wgAPI from '$/api/wg_easy_api';
import * as db from '$/db';

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

    if (userId === appConfigInstance.adminTelegramId) {
        if (!user.hasAccess) {
            user.hasAccess = true;
            user.accessGrantedAt = new Date().toISOString();
            db.updateUser(userId, { hasAccess: true, accessGrantedAt: user.accessGrantedAt });
            logActivity(`Admin ${userId} (${username}) started the bot. Access granted/confirmed.`);
        }
    }

    if (user.hasAccess) {
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

export async function showMainMenu(chatId: number, userId: number) {
    db.updateUser(userId, { state: undefined });
    const isAdmin = userId === appConfigInstance.adminTelegramId;

    const keyboard: TelegramBot.KeyboardButton[][] = [
        [{ text: "❓ Плохо работает VPN" }],
        [{ text: "🛡 Wireguard" }, { text: "📄 Мои конфиги" }],
    ];

    if (isAdmin) {
        keyboard.push([{ text: "👑 Админ-панель" }]);
    }
    
    const hourStats = `📊<b>За последний час</b> скачано ${getUsageText(lastHourUsage.tx)}, загружено ${getUsageText(lastHourUsage.rx)}`;
    const caption = `🌟 <b>Главное меню</b>\n\n${hourStats}`;

    const placeholderMessage = await botInstance.sendMessage(chatId, "🔄 Загрузка статистики...", {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true,
            one_time_keyboard: false,
        },
    });
    
    try {
        const currentHour = new Date().getUTCHours();
        const hourlyUsageWithHours = hourlyUsageHistory
            .map((usage, hour) => ({ ...usage, hour }))
            .slice(0, currentHour + 1);
        const chartImageBuffer = await generateUsageChart(hourlyUsageWithHours);

        await botInstance.sendPhoto(chatId, chartImageBuffer, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: keyboard,
                resize_keyboard: true,
                one_time_keyboard: false,
            },
        });

        await botInstance.deleteMessage(chatId, placeholderMessage.message_id);

    } catch (error) {
        console.error("Failed to generate or send usage chart:", error);
        logActivity(`Failed to generate or send usage chart for user ${userId}: ${error}`);
        try {
            await botInstance.editMessageText(`${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
                chat_id: chatId,
                message_id: placeholderMessage.message_id,
                parse_mode: 'HTML',
            });
        } catch (editError) {
            console.error("Failed to edit caption on error, sending new message:", editError);
            await botInstance.sendMessage(chatId, `${caption}\n\n⚠️ Не удалось загрузить график статистики.`, {
                parse_mode: 'HTML',
                reply_markup: { keyboard: keyboard, resize_keyboard: true, one_time_keyboard: false },
            });
        }
    }
}

export async function handleRequestAccess(chatId: number, userId: number, username?: string) {
    const adminId = appConfigInstance.adminTelegramId;
    const userIdentifier = username ? `@${username}` : `ID ${userId}`;

    try {
        const adminMessage = await botInstance.sendMessage(adminId,
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

export async function handleCreateWgConfigStart(chatId: number, userId: number) {
    const user = db.ensureUser(userId);
    if (!user.hasAccess) {
        await botInstance.sendMessage(chatId, "У вас нет доступа для создания конфигураций.");
        return;
    }

    const deviceButtons = devices.map(device => ([{ text: device.name, callback_data: `select_device_${device.id}` }]));

    deviceButtons.push([{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]);

    await botInstance.sendMessage(chatId, "Выберите тип устройства для конфигурации:", {
        reply_markup: {
            inline_keyboard: deviceButtons,
        }
    });
}

export async function handleDeviceSelection(chatId: number, userId: number, deviceId: string) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        await botInstance.sendMessage(chatId, "Неверный тип устройства.");
        return;
    }
    db.updateUser(userId, { state: { action: 'awaiting_config_name', data: { deviceId } } });
    await botInstance.sendMessage(chatId,
        `Вы выбрали: ${device.name}.\nТеперь введите имя для этой конфигурации (например, "Мой ноутбук" или "Телефон Мамы").\n\nДля отмены нажмите кнопку ниже или введите /cancel.`,
        {
            reply_markup: {
                inline_keyboard: [[{ text: "⬅️ Отмена и назад в меню", callback_data: "user_main_menu" }]],
                // remove_keyboard: true // Это уберет reply-клавиатуру, если она была
            }
        });
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
    if (!user || !user.state || user.state.action !== 'awaiting_config_name' || !user.state.data?.deviceId) {
        await botInstance.sendMessage(chatId, "Произошла ошибка или вы не завершили предыдущее действие. Пожалуйста, начните заново с /start.");
        db.updateUser(userId, { state: undefined });
        return;
    }

    const { deviceId } = user.state.data;
    const wgClientName = `user${userId}_${deviceId}_${Date.now()}`;

    const { message_id: savedMessageId } = await botInstance.sendMessage(chatId, `🔄 Создаю конфигурацию "${configName}" для устройства... Пожалуйста, подождите!`);

    try {
        const newClient = await wgAPI.createWgClient(wgClientName);
        if (!newClient || !newClient.id) {
            await botInstance.editMessageText(`❌ Не удалось создать конфигурацию wg-easy "${configName}"\nПопробуйте позже`, {
                chat_id: chatId,
                message_id: savedMessageId
            });
            logActivity(`Failed to create wg-easy client for user ${userId}, name ${wgClientName}`);
            return;
        }

        const userConfig = {
            userGivenName: configName,
            wgEasyClientId: newClient.id,
            deviceId: deviceId,
            createdAt: new Date().toISOString(),
            isEnabled: true,
        };

        user.configs.push(userConfig);
        db.updateUser(userId, { configs: user.configs, state: undefined });

        logActivity(`User ${userId} created config: ${configName} (wgID: ${newClient.id})`);
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
            });
        } else {
            logActivity(`Failed to get QR code buffer for ${newClient.id} in handleConfigNameInput. Buffer: ${qrCodeBuffer}`);
            await botInstance.sendMessage(chatId, "📸 Не удалось получить QR-код.");
        }
        await showMainMenu(chatId, userId);

    } catch (error : any) {
        console.error("Error in config creation flow:", error);
        logActivity(`Error creating config for user ${userId}: ${error}`);
        await botInstance.sendMessage(chatId, "Произошла ошибка при создании конфигурации. Пожалуйста, попробуйте позже.");
        db.updateUser(userId, { state: undefined });
    }
}


export async function handleListMyConfigs(chatId: number, userId: number, page: number) {
    const user = db.getUser(userId);
    if (!user || !user.hasAccess) {
        await botInstance.sendMessage(chatId, "У вас нет доступа или конфигураций.");
        return;
    }

    const configs = user.configs;
    if (configs.length === 0) {
        await botInstance.sendMessage(chatId, "У вас пока нет созданных конфигураций.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Создать новую", callback_data: "create_wg_config_start" }],
                    [{ text: "⬅️ Назад в меню", callback_data: "user_main_menu" }]
                ]
            }
        });
        return;
    }

    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(configs.length / ITEMS_PER_PAGE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageConfigs = configs.slice(startIndex, endIndex);
    
    let messageText = `📄 <b>Ваши конфигурации</b> (Страница ${currentPage + 1}/${totalPages}):\n\n`;
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [];
    
    let itemsInCurrentRow = 0;
    let currentRowSymbolsLength = 0;
    let currentRow: CallbackButton[] = [];
    
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
        messageText += `<b>${globalIndex + 1}.</b> ${symbol} ${config.userGivenName} (${deviceName}, трафик: ${getUsageText(totalTraffic)})\n`;
        
        const button = { text: `${config.userGivenName}`, callback_data: `view_config_${config.wgEasyClientId}` }
        const userGivenLength = config.userGivenName.length
        
        /* Группируем кнопки в одну строчку */
        if(itemsInCurrentRow === 3 || (currentRowSymbolsLength + userGivenLength) >= 35) {
            if(currentRow.length > 0) inline_keyboard.push(currentRow)
            
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
    inline_keyboard.push(currentRow)
    
    /* Немного статистики */
    const [ totalRx, totalTx ] = getTotalBandwidthUsage(configs)
    messageText += `\n📊 Всего скачано ${getUsageText(totalTx)}, отправлено ${getUsageText(totalRx)}`
    
    const paginationButtons: TelegramBot.InlineKeyboardButton[] = [];
    if (currentPage > 0) {
        paginationButtons.push({ text: "⬅️", callback_data: `list_my_configs_page_${currentPage - 1}` });
    }
    paginationButtons.push({ text: `${currentPage + 1} / ${totalPages}`, callback_data: "noop" }); // noop - ничего не делать
    if (currentPage < totalPages - 1) {
        paginationButtons.push({ text: "➡️", callback_data: `list_my_configs_page_${currentPage + 1}` });
    }

    if (paginationButtons.length > 0) {
        inline_keyboard.push(paginationButtons);
    }
    inline_keyboard.push([{ text: "➕ Создать новую", callback_data: "create_wg_config_start" }]);
    inline_keyboard.push([{ text: "⬅️ Назад в главное меню", callback_data: "user_main_menu" }]);


    const userState = user.state;
    if (userState && userState.action === 'viewing_config_list' && userState.data?.messageId) {
        try {
            await botInstance.editMessageText(messageText, {
                chat_id: chatId,
                message_id: userState.data.messageId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard }
            });
        } catch (e) {
            const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard }, parse_mode: 'HTML' });
            db.updateUser(userId, { state: { action: 'viewing_config_list', data: { messageId: sentMessage.message_id } } });
        }
    } else {
        const sentMessage = await botInstance.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard }, parse_mode: 'HTML' });
        db.updateUser(userId, { state: { action: 'viewing_config_list', data: { messageId: sentMessage.message_id } } });
    }
}

export async function handleViewConfig(chatId: number, userId: number, wgEasyClientId: string) {
    const user = db.getUser(userId);
    if (!user) return;

    const config = user.configs.find(c => c.wgEasyClientId === wgEasyClientId);
    if (!config) {
        await botInstance.sendMessage(chatId, "Конфигурация не найдена.");
        await handleListMyConfigs(chatId, userId, 0);
        return;
    }

    const placeholderMessage = await botInstance.sendMessage(chatId, `🔄 Загрузка деталей для "${config.userGivenName}"...`);

    try {
        const deviceName = devices.find(d => d.id === config.deviceId)?.name || 'Неизвестное устройство';
    const creationDate = new Date(config.createdAt).toLocaleString('ru-RU');
    
    const conInfo = getWgConnectionInfo(wgEasyClientId);
    const totalTx = config.totalTx || 0;
    const totalRx = config.totalRx || 0;
    const bandwidth = `${getUsageText(totalTx)} скачано, ${getUsageText(totalRx)} отправлено`;
    
    let usedLastDay = false;
    const latestHandshakeAt = conInfo?.latestHandshakeAt || config.latestHandshakeAt;
    console.log(conInfo, latestHandshakeAt)
    if(latestHandshakeAt) {
        const usedAt = new Date(latestHandshakeAt);
        usedLastDay = Date.now() - usedAt.getTime() < 24 * 60 * 60 * 1000;
    }
    const status = !config.isEnabled ? '❌ Отключен' : usedLastDay ? '✅ Активен' : `💤 Не использовался последние 24 часа`;
    
    let text = `ℹ️ <b>Детали конфигурации:</b>\n\n`;
    text += `<b>Имя:</b> ${config.userGivenName}\n`;
    text += `<b>Устройство:</b> ${deviceName}\n`;
    text += `<b>Создан:</b> ${creationDate}\n`;
    text += `<b>Статус:</b> ${status}\n`;
    text += `<b>Трафик:</b> ${bandwidth}\n`
    text += `<b>ID (wg-easy):</b> ${config.wgEasyClientId}`;

        const chartImageBuffer = await generateMonthlyUsageChart(config.dailyUsage);

        const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: "📥 Скачать (.conf)", callback_data: `dl_config_${wgEasyClientId}` },
                { text: "📱 QR-код", callback_data: `qr_config_${wgEasyClientId}` }
            ],
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

        await botInstance.sendPhoto(chatId, chartImageBuffer, {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
        });

        await botInstance.deleteMessage(chatId, placeholderMessage.message_id);
    } catch (error) {
        console.error(`Failed to show config details with chart for ${wgEasyClientId}:`, error);
        logActivity(`Failed to show config details with chart for ${wgEasyClientId}: ${error}`);
        await botInstance.editMessageText(`⚠️ Не удалось загрузить детали конфигурации с графиком.`, {
            chat_id: chatId,
            message_id: placeholderMessage.message_id,
        });
    }
}

export async function handleConfigAction(chatId: number, userId: number, action: string, wgEasyClientId: string, isAdminAction: boolean = false) {
    const user = db.getUser(userId);
    if (!user) return;

    const configIndex = user.configs.findIndex(c => c.wgEasyClientId === wgEasyClientId);
    if (configIndex === -1) {
        await botInstance.sendMessage(chatId, "Конфигурация не найдена.");
        return;
    }
    const config = user.configs[configIndex];

    try {
        const refreshView = async () => {
            if (isAdminAction) {
                await handleAdminViewConfig(chatId, userId, wgEasyClientId);
            } else {
                await handleViewConfig(chatId, userId, wgEasyClientId);
            }
        };
        switch (action) {
            case 'dl_config':
                const fileContent = await wgAPI.getClientConfiguration(wgEasyClientId);
                if (typeof fileContent === 'string' && fileContent.length > 0) {
                    await botInstance.sendDocument(chatId, Buffer.from(fileContent), {}, {
                        filename: `${escapeConfigName(config.userGivenName)}.conf`,
                        contentType: 'text/plain'
                    });
                    logActivity(`User ${userId} downloaded config ${config.userGivenName} (ID: ${wgEasyClientId})`);
                } else {
                    logActivity(`Failed to get config file content for ${wgEasyClientId} in handleConfigAction (dl_config). Content: ${fileContent}`);
                    await botInstance.sendMessage(chatId, "Не удалось получить файл конфигурации.");
                }
                break;
            case 'qr_config':
                const qrBuffer = await wgAPI.getClientQrCodeSvg(wgEasyClientId);
                if (qrBuffer instanceof Buffer && qrBuffer.length > 0) {
                    logActivity(`Attempting to send QR code photo (PNG) for config ${wgEasyClientId}. Buffer length: ${qrBuffer.length}`);
                    await botInstance.sendPhoto(chatId, qrBuffer, {
                        caption: `QR-код для ${config.userGivenName}`
                    });
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
                            [{ text: "⬅️ Нет, отмена", callback_data: `${isAdminAction ? `admin_view_config_${userId}_${wgEasyClientId}` : `view_config_${wgEasyClientId}`}` }]
                        ]
                    }
                });
                break;
            case 'delete_config_confirm':
                if (await wgAPI.deleteWgClient(wgEasyClientId)) {
                    user.configs.splice(configIndex, 1);
                    db.updateUser(userId, { configs: user.configs });
                    // await botInstance.answerCallbackQuery(chatId.toString(), { text: `Конфигурация "${config.userGivenName}" удалена.` }); // callback_query_handler
                    await botInstance.sendMessage(chatId, `Конфигурация "${config.userGivenName}" удалена.`); // TODO: edit message instead of sending new one
                    logActivity(`${isAdminAction ? 'Admin' : 'User'} ${chatId} deleted config ${config.userGivenName} (ID: ${wgEasyClientId}) of user ${userId}`);
                    if (isAdminAction) await handleAdminListAllConfigs(chatId, 0);
                    else await handleListMyConfigs(chatId, userId, 0);
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
        await botInstance.sendMessage(appConfigInstance.adminTelegramId, messageToAdmin);
        await botInstance.sendMessage(chatId, "Спасибо! Ваше сообщение отправлено администратору.");
        logActivity(`User ${userId} sent feedback: "${feedbackText}"`);
    } catch (error : any) {
        logActivity(`Failed to send feedback from ${userId} to admin: ${error}`);
        await botInstance.sendMessage(chatId, "Не удалось отправить сообщение администратору. Пожалуйста, попробуйте позже.");
    } finally {
        db.updateUser(userId, { state: undefined });
    }
}
