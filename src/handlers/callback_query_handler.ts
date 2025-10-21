import TelegramBot from 'node-telegram-bot-api';
import { AppConfig } from '../types';
import * as userFlow from './user_flow';
import * as adminFlow from './admin_flow';
import { logActivity } from '../logger';
import * as db from '../db';


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

    try {
        // Запросы доступа
        if (data === 'request_access') {
            await userFlow.handleRequestAccess(chatId, userId, query.from.username);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('approve_access_')) {
            console.log(userId, appConfigInstance)
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Это действие доступно только администратору." });
                return;
            }
            const userIdToApprove = parseInt(data.split('_')[2]);
            await adminFlow.handleApproveAccess(chatId, userIdToApprove, messageId);
            await botInstance.answerCallbackQuery(query.id, { text: "Доступ одобрен." });
            return;
        }
        if (data.startsWith('deny_access_')) {
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Это действие доступно только администратору." });
                return;
            }
            const userIdToDeny = parseInt(data.split('_')[2]);
            await adminFlow.handleDenyAccess(chatId, userIdToDeny, messageId);
            await botInstance.answerCallbackQuery(query.id, { text: "Доступ отклонен." });
            return;
        }

        // Пользовательский флоу
        if (data === 'user_main_menu') {
            await userFlow.showMainMenu(chatId, userId);
            try {
                await botInstance.deleteMessage(chatId, messageId);
            } catch (e) { /* Игнорируем ошибку, если сообщение уже удалено или не может быть удалено */ }
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data === 'create_wg_config_start') {
            await userFlow.handleCreateWgConfigStart(chatId, userId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('select_device_')) {
            const deviceId = data.substring('select_device_'.length);
            await userFlow.handleDeviceSelection(chatId, userId, deviceId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('list_my_configs_page_')) {
            const page = parseInt(data.substring('list_my_configs_page_'.length));
            await userFlow.handleListMyConfigs(chatId, userId, page);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('view_config_')) {
            const wgEasyClientId = data.substring('view_config_'.length);
            await userFlow.handleViewConfig(chatId, userId, wgEasyClientId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        // Действия с конфигом
        const configActionMatch = data.match(/^(dl_config|qr_config|disable_config|enable_config|delete_config_ask|delete_config_confirm)_(.+)$/);
        if (configActionMatch) {
            const action = configActionMatch[1];
            const wgEasyClientId = configActionMatch[2];
            await userFlow.handleConfigAction(chatId, userId, action, wgEasyClientId);
            const actionsThatAnswerInternally = ['delete_config_ask'];
            if (!actionsThatAnswerInternally.includes(action)) {
                try { await botInstance.answerCallbackQuery(query.id); } catch (e) { /* Игнорируем ошибку */ }
            }
            return;
        }


        // Админский флоу
        if (data === 'admin_main_menu') {
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return;
            }
            await adminFlow.showAdminMainMenu(chatId);
            try {
                await botInstance.deleteMessage(chatId, messageId);
            } catch (e) { /* Игнорируем ошибку */ }
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_list_users_page_')) {
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return;
            }
            const page = parseInt(data.substring('admin_list_users_page_'.length));
            await adminFlow.handleAdminListUsers(chatId, page);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_view_user_')) {
            if (userId !== appConfigInstance.adminTelegramId) {
                 await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return;
            }
            const userIdToView = parseInt(data.substring('admin_view_user_'.length));
            await adminFlow.handleAdminViewUser(chatId, userIdToView);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_revoke_access_ask_')) {
            if (userId !== appConfigInstance.adminTelegramId) { await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return; }
            const userIdToRevoke = parseInt(data.substring('admin_revoke_access_ask_'.length));
            await adminFlow.handleAdminRevokeAccessAsk(chatId, userIdToRevoke);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_revoke_access_confirm_')) {
            if (userId !== appConfigInstance.adminTelegramId) { await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return; }
            const userIdToRevoke = parseInt(data.substring('admin_revoke_access_confirm_'.length));
            await adminFlow.handleAdminRevokeAccessConfirm(chatId, userIdToRevoke);
            await botInstance.answerCallbackQuery(query.id, { text: "Доступ отозван." });
            return;
        }
        if (data.startsWith('admin_list_all_configs_page_')) {
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return;
            }
            const page = parseInt(data.substring('admin_list_all_configs_page_'.length));
            await adminFlow.handleAdminListAllConfigs(chatId, page);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_view_config_')) {
            if (userId !== appConfigInstance.adminTelegramId) { await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return; }
            const parts = data.substring('admin_view_config_'.length).split('_');
            const ownerId = parseInt(parts[0]);
            const wgEasyClientId = parts[1];
            await adminFlow.handleAdminViewConfig(chatId, ownerId, wgEasyClientId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        if (data.startsWith('admin_view_cfg_idx_')) {
            if (userId !== appConfigInstance.adminTelegramId) { await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return; }
            const globalIndex = parseInt(data.substring('admin_view_cfg_idx_'.length));
            const allConfigs = db.getAllConfigs();
            if (isNaN(globalIndex) || globalIndex < 0 || globalIndex >= allConfigs.length) {
                await botInstance.sendMessage(chatId, "Ошибка: неверный индекс конфигурации для просмотра.");
                await botInstance.answerCallbackQuery(query.id, { text: "Ошибка индекса."});
                return;
            }
            const targetConfig = allConfigs[globalIndex];
            await adminFlow.handleAdminViewConfig(chatId, targetConfig.ownerId, targetConfig.wgEasyClientId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }
        // Действия с конфигом от админа
        const adminConfigActionMatch = data.match(/^(admin_(?:dl_config|qr_config|disable_config|enable_config|delete_config_ask|delete_config_confirm))_(?:(\d+)_([0-9a-fA-F-]+)|cfg_idx_(\d+))$/);
        if (adminConfigActionMatch) {
            if (userId !== appConfigInstance.adminTelegramId) { await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return; }
            const actionWithPrefix = adminConfigActionMatch[1]; // e.g., admin_dl_config
            let configIdentifier: string;
            let ownerId: number;
            let wgEasyClientId: string;

            if (adminConfigActionMatch[4] !== undefined) { // _cfg_idx_
                const globalIndex = parseInt(adminConfigActionMatch[4]);
                const allConfigs = db.getAllConfigs();
                const targetConfig = allConfigs[globalIndex];
                await adminFlow.handleAdminConfigAction(chatId, actionWithPrefix, `${targetConfig.ownerId}_${targetConfig.wgEasyClientId}`);
            } else { // ownerId_wgClientId
                await adminFlow.handleAdminConfigAction(chatId, actionWithPrefix, `${adminConfigActionMatch[2]}_${adminConfigActionMatch[3]}`);
            }
            if (!actionWithPrefix.endsWith('_ask')) {
                try { await botInstance.answerCallbackQuery(query.id); } catch (e) { /* Игнорируем ошибку */ }
            }
            return;
        }
        if (data === 'admin_view_logs') {
            if (userId !== appConfigInstance.adminTelegramId) {
                await botInstance.answerCallbackQuery(query.id, { text: "Доступ запрещен." }); return;
            }
            await adminFlow.handleAdminViewLogs(chatId);
            await botInstance.answerCallbackQuery(query.id);
            return;
        }

        if (data === 'request_feedback') {
            await userFlow.handleRequestFeedback(chatId, userId);
            return;
        }


        if (data === 'noop') { // Кнопка-пустышка
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
