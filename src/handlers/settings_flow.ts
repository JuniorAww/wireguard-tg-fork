import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { findCity, CityData } from '$/utils/timezone';
import * as db from '$/db/index';


let botInstance: TelegramBot;

export function initSettingsFlow(bot: TelegramBot) {
    botInstance = bot;
}

export async function handlePersonalSettings(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    if (!user) return;
    
    db.updateUser(userId, { state: undefined });
    
    const inline_keyboard: InlineKeyboardButton[][] = [
        [{ text: "🌆 Часовой пояс: UTC+" + user.settings.utc, callback_data: `set_timezone` }],
        [{ text: "⬅️ В главное меню", callback_data: `user_main_menu` }],
    ]
    
    const caption = "⚙ <b>Персональные настройки</b>"
    + "\nЗдесь можно настроить графики — например, используемый часовой пояс.";
    
    // TODO fix
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: 999999999,
        caption,
        keyboard: inline_keyboard
    })
}

const handleTimezonesDefaultKeyboard: InlineKeyboardButton[][] = [
    [
        { text: "⬅️ Отменить и к настройкам", callback_data: `personal_settings` },
    ]
]

export async function handleSetTimezoneStart(chatId: number, userId: number, messageId: number) {
    const user = db.getUser(userId);
    if (!user) return;
    
    const caption = "⚙ <b>Часовой пояс</b>"
    + "\nНапишите название ближайшего к вам города - и я определю ваш часовой пояс.";
    
    // @ts-ignore
    await botInstance.sendCachedMedia(chatId, messageId, {
        media: "empty.png",
        uniqueKey: 'empty',
        expiresIn: 999999999,
        caption,
        keyboard: handleTimezonesDefaultKeyboard
    })
    
    db.updateUser(userId, { state: { action: 'set_timezone', messageId } });
}

export async function handleSetTimezone(userId: number, text: string) {
    const user = db.getUser(userId);
    if (!user || !user.state) return;
    
    const city: CityData | undefined = findCity(text);
    
    if (city === undefined) {
        botInstance.editMessageText("✅ <i>Сообщение устарело</i>", {
            message_id: user.state.messageId,
            chat_id: userId,
        })
        
        const reply = await botInstance.sendMessage(userId, "⚙ <b>Город не найден</b>"
        + "\nВозможно, вы допустили опечатку?", {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: handleTimezonesDefaultKeyboard }
        });
        
        db.updateUser(userId, { state: { action: 'set_timezone', messageId: reply.message_id } });
        return;
    }
    
    await botInstance.sendMessage(userId, `✅ Часовой пояс установлен на <b>UTC+${city.utc}</b>`, { parse_mode: 'HTML' });
    
    db.updateUser(userId, { settings: { ...user.settings, city: city.name, utc: city.utc } });
    
    handlePersonalSettings(userId, userId, NaN); // TODO change first userId to chatId?
}

export default {
	handlePersonalSettings,
	handleSetTimezoneStart,
	handleSetTimezone,
}
