import TelegramBot from 'node-telegram-bot-api';
import { AppConfig } from '$/db/types';
import * as userFlow from '$/handlers/user_flow';
import * as adminFlow from '$/handlers/admin_flow';
import settingsFlow from '$/handlers/settings_flow';
import { logActivity } from '$/utils/logger';
import * as db from '$/db/index';


let botInstance: TelegramBot;
let appConfigInstance: AppConfig;

export function initCallbackQueryHandler(bot: TelegramBot, appCfg: AppConfig) {
    botInstance = bot;
    appConfigInstance = appCfg;
}

export async function handleCallbackQuery(query: TelegramBot.CallbackQuery) {
    const chatId = query.message!.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message!.message_id;
    
    if (!data) return;

    logActivity(`Callback query from ${userId} (${query.from.username || 'N/A'}): ${data} in chat ${chatId}`);
    
    const user = db.ensureUser(userId);
    
    try {
        // Запросы доступа
        if (data === 'request_access') {
            await userFlow.handleRequestAccess(chatId, userId, query.from.username);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        
        const hasSharedConfigs = db.getAllConfigs().some(c => c.sharedWith === userId);

        // Пользовательский флоу (без доступа)
        if (user.hasAccess || user.configs.length || hasSharedConfigs) {
            if (data === 'user_main_menu') {
                await userFlow.showMainMenu(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'personal_settings') {
                await settingsFlow.handlePersonalSettings(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'set_timezone') {
                await settingsFlow.handleSetTimezoneStart(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('list_my_configs_page_')) {
                const page = parseInt(data.substring('list_my_configs_page_'.length), 10) || 0;
                await userFlow.handleListMyConfigs(chatId, userId, messageId, page);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('view_config_')) {
                const parts = data.substring('view_config_'.length).split('_');
                const ownerId = parseInt(parts[0], 10);
                const wgEasyClientId = parts[1];
                await userFlow.handleViewConfig(chatId, userId, messageId, ownerId, wgEasyClientId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('cf_')) {
                const parts = data.substring('cf_'.length).split(' ');
                const [ownerIdStr, wgEasyClientId, action, pageStr] = parts[0].split('_').concat(parts.slice(1));
                const ownerId = parseInt(ownerIdStr, 10);
                await userFlow.handleConfigFile(chatId, userId, messageId, ownerId, wgEasyClientId, action, parseInt(pageStr, 10));
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            const configActionMatch = data.match(/^ca_(\d+)_([0-9a-fA-F-]+)_(qr|d|e|da|dc|s|r)$/);
            if (configActionMatch) {
                const ownerId = parseInt(configActionMatch[1], 10);
                const wgEasyClientId = configActionMatch[2];
                const action = configActionMatch[3];
                await userFlow.handleConfigAction(chatId, userId, messageId, action, ownerId, wgEasyClientId, query.id);
                const actionsThatAnswerInternally = ['da'];
                if (!actionsThatAnswerInternally.includes(action)) {
                    try { await botInstance.answerCallbackQuery(query.id); } catch (e) { /* Игнорируем ошибку */ }
                }
                return;
            }
        }
        
        // + Пользовательский флоу (с доступом)
        if (user.hasAccess) {
            if (data === 'create_wg_config_start') {
                await userFlow.handleCreateWgConfigStart(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('select_device_')) {
                const deviceId = data.substring('select_device_'.length);
                await userFlow.handleDeviceSelection(chatId, userId, messageId, deviceId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'config_owner_self') {
                await userFlow.handleAssignConfigToSelf(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'config_owner_link') {
                await userFlow.handleGenerateOwnershipLink(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
        }

        // Админский флоу
        if ((data.startsWith('admin') || data.includes('_access_'))
        && appConfigInstance.adminTelegramIds.includes(userId)
        /*&& db.getUser(userId).role === 2*/) {
            if (data.startsWith('approve_access_')) {
                const userIdToApprove = parseInt(data.split('_')[2]);
                await adminFlow.handleApproveAccess(chatId, userIdToApprove, messageId);
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ одобрен." });
                return;
            }
            if (data.startsWith('deny_access_')) {
                const userIdToDeny = parseInt(data.split('_')[2]);
                await adminFlow.handleDenyAccess(chatId, userIdToDeny, messageId);
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ отклонен." });
                return;
            }
            if (data === 'admin_main_menu') {
                await adminFlow.showAdminMainMenu(chatId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_list_users_page_')) {
                const page = parseInt(data.substring('admin_list_users_page_'.length));
                await adminFlow.handleAdminListUsers(chatId, page, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_view_user_')) {
                const parts = data.substring('admin_view_user_'.length).split('_');
                const userIdToView = parseInt(parts[0], 10);
                const page = parts.length > 1 ? parseInt(parts[1], 10) : 0;
                await adminFlow.handleAdminViewUser(chatId, userIdToView, messageId, page);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_revoke_access_ask_')) {
                const userIdToRevoke = parseInt(data.substring('admin_revoke_access_ask_'.length));
                await adminFlow.handleAdminRevokeAccessAsk(chatId, userIdToRevoke);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_revoke_access_confirm_')) {
                const userIdToRevoke = parseInt(data.substring('admin_revoke_access_confirm_'.length));
                await adminFlow.handleAdminRevokeAccessConfirm(chatId, userIdToRevoke);
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ отозван." });
                return;
            }
            if (data.startsWith('admin_list_all_configs_page_')) {
                const page = parseInt(data.substring('admin_list_all_configs_page_'.length));
                await adminFlow.handleAdminListAllConfigs(chatId, page, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_show_stats')) {
                await adminFlow.handleAdminShowUsageStats(chatId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_view_config_')) {
                const parts = data.substring('admin_view_config_'.length).split('_');
                const ownerId = parseInt(parts[0]);
                const wgEasyClientId = parts[1];
                await adminFlow.handleAdminViewConfig(chatId, ownerId, messageId, wgEasyClientId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_view_cfg_idx_')) {
                const globalIndex = parseInt(data.substring('admin_view_cfg_idx_'.length));
                const allConfigs = db.getAllConfigs();
                if (isNaN(globalIndex) || globalIndex < 0 || globalIndex >= allConfigs.length) {
                    await botInstance.sendMessage(chatId, "Ошибка: неверный индекс конфигурации для просмотра.");
                    await botInstance.answerCallbackQuery(query.id, { text: "Ошибка индекса."});
                    return;
                }
                const targetConfig = allConfigs[globalIndex];
                await adminFlow.handleAdminViewConfig(chatId, targetConfig.ownerId, messageId, targetConfig.wgEasyClientId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            // Действия с конфигом от админа
            const adminConfigActionMatch = data.match(/^(ad_(?:dl|qr|dis|en|del_a|del_c))_(\d+)_([0-9a-fA-F-]+)$/);
            if (adminConfigActionMatch) {
                const actionWithPrefix = adminConfigActionMatch[1]; // e.g., admin_dl_config
                const ownerId = parseInt(adminConfigActionMatch[2], 10);
                const wgEasyClientId = adminConfigActionMatch[3];

                await adminFlow.handleAdminConfigAction(chatId, actionWithPrefix, `${ownerId}_${wgEasyClientId}`, messageId);

                if (!actionWithPrefix.endsWith('_ask')) {
                    try { await botInstance.answerCallbackQuery(query.id); } catch (e) { /* Игнорируем ошибку */ }
                }
                return;
            }
            if (data.startsWith('admin_subnets_')) {
                const page = parseInt(data.substring('admin_subnets_'.length), 10) || 0;
                await adminFlow.handleSubnetList(chatId, messageId, page);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data.startsWith('admin_subnet_')) {
                const id = parseInt(data.substring('admin_subnet_'.length), 10) || 0;
                await adminFlow.handleSubnetInfo(chatId, id);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'admin_create_subnet') {
                await adminFlow.handleSubnetCreation(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
            if (data === 'admin_delete_subnet') {
                await adminFlow.handleSubnetDeletion(chatId, userId, messageId);
                await botInstance.answerCallbackQuery(query.id);
                return;
            }
        }


        if (data.startsWith('noop')) { // Кнопка-пустышка
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        else if (data === 'del') { // Кнопка-пустышка
            await botInstance.deleteMessage(chatId, messageId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }

        logActivity(`Unknown callback_data: ${data} from user ${userId}`);
        await botInstance.answerCallbackQuery(query.id, { text: "Неизвестное действие." });

    } catch (error) {
        console.error("Error handling callback query:", error);
        logActivity(`Error in callback query ${data} from user ${userId}: ${error}`);
        try {
            await botInstance.answerCallbackQuery(query.id, { text: "Произошла ошибка при обработке вашего запроса." });
        } catch (e) { /* Игнорируем ошибку */ }
    }
}
