import TelegramBot from 'node-telegram-bot-api';
import { AppConfig } from '$/db/types';
import * as userFlow from '$/handlers/user_flow';
import * as adminFlow from '$/handlers/admin_flow';
import { logActivity } from '$/utils/logger';
import * as db from '$/db';


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
		
        // Пользовательский флоу (без доступа)
        if (user.configs.length) {
			if (data === 'user_main_menu') {
				await userFlow.showMainMenu(chatId, userId, messageId);
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
				const wgEasyClientId = data.substring('view_config_'.length);
				await userFlow.handleViewConfig(chatId, userId, messageId, wgEasyClientId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('config_file_')) {
				const [ wgEasyClientId, action ] = data.substring('config_file_'.length).split(' ');
				await userFlow.handleConfigFile(chatId, userId, messageId, wgEasyClientId, action);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			const configActionMatch = data.match(/^(qr_config|disable_config|enable_config|delete_config_ask|delete_config_confirm)_(.+)$/);
			if (configActionMatch) {
				const action = configActionMatch[1];
				const wgEasyClientId = configActionMatch[2];
				await userFlow.handleConfigAction(chatId, userId, messageId, action, wgEasyClientId);
				const actionsThatAnswerInternally = ['delete_config_ask'];
				if (!actionsThatAnswerInternally.includes(action)) {
					try { await botInstance.answerCallbackQuery(query.id); } catch (e) { /* Игнорируем ошибку */ }
				}
				return;
			}
			if (data === 'request_feedback') {
				await userFlow.handleRequestFeedback(chatId, userId);
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
			if (data.startsWith('select_config_owner_')) {
				const userId = data.substring('select_config_owner'.length);
				await userFlow.handleConfigOwnerInput(userId, messageId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('select_device_')) {
				const deviceId = data.substring('select_device_'.length);
				await userFlow.handleDeviceSelection(chatId, userId, messageId, deviceId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('config_owner_skip')) {
				await userFlow.handleConfigOwnerInput(query.message, true, true);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
		}

		// Админский флоу
		if (data.startsWith('admin')
		&& appConfigInstance.adminTelegramIds.includes(userId)
		/*&& db.getUser(userId).role === 2*/) {
			if (data.startsWith('approve_access_')) {
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
			if (data === 'admin_main_menu') {
				await adminFlow.showAdminMainMenu(chatId, messageId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('admin_list_users_page_')) {
				const page = parseInt(data.substring('admin_list_users_page_'.length));
				await adminFlow.handleAdminListUsers(chatId, page);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('admin_view_user_')) {
				const userIdToView = parseInt(data.substring('admin_view_user_'.length));
				await adminFlow.handleAdminViewUser(chatId, userIdToView);
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
				await adminFlow.handleAdminListAllConfigs(chatId, page);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('admin_show_stats')) {
				await adminFlow.handleAdminShowUsageStats(chatId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			if (data.startsWith('admin_view_config_')) {
				const parts = data.substring('admin_view_config_'.length).split('_');
				const ownerId = parseInt(parts[0]);
				const wgEasyClientId = parts[1];
				await adminFlow.handleAdminViewConfig(chatId, ownerId, wgEasyClientId);
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
				await adminFlow.handleAdminViewConfig(chatId, targetConfig.ownerId, targetConfig.wgEasyClientId);
				await botInstance.answerCallbackQuery(query.id);
				return;
			}
			// Действия с конфигом от админа
			const adminConfigActionMatch = data.match(/^(admin_(?:dl_config|qr_config|disable_config|enable_config|delete_config_ask|delete_config_confirm))_(?:(\d+)_([0-9a-fA-F-]+)|cfg_idx_(\d+))$/);
			if (adminConfigActionMatch) {
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
				await adminFlow.handleAdminViewLogs(chatId);
				await botInstance.answerCallbackQuery(query.id);
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


        if (data === 'noop') { // Кнопка-пустышка
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
