import TelegramBot, { EditMessageMediaOptions } from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';

interface Cache {
	photoId: string;
	expiresAt: number;
}

const mediaCache: Record<string, Cache> = {};

export function isMediaCached(uniqueKey: string) {
	const cache = mediaCache[uniqueKey];
	return cache !== undefined && cache.expiresAt > Date.now();
}

export async function sendCachedMedia(
	this: TelegramBot, 
	chatId: number,
	messageId: number,
	params: any
) {
	const {
		uniqueKey,
		media,
		expiresIn,
		caption,
		keyboard: inline_keyboard
	} = params;
	
	const cache: Cache = mediaCache[uniqueKey];
	
	const messageParams: EditMessageMediaOptions = !messageId ? {} : {
		chat_id: chatId,
		message_id: messageId,
		reply_markup: { inline_keyboard },
	};
	
	let nextMessageId: number = messageId;
	
	if (cache && cache.expiresAt > Date.now()) {
		if (messageId) {
			await this.editMessageMedia({
				type: 'photo',
				caption,
				parse_mode: 'HTML',
				media: cache.photoId,
			}, messageParams);
		} else {
			const response = await this.sendPhoto(chatId, cache.photoId, {
				caption,
				parse_mode: 'HTML',
				reply_markup: { inline_keyboard },
			});
			
			nextMessageId = response.message_id;
		}
	}
	else {
		let image: any;
		let intermediaryFile: string | undefined;
		
		if (typeof media === 'function') {
			image = await media(); // (1) buffer
		}
		else if (!isNaN(parseInt(media, 10)))
			image = media; // photoId
		else if (typeof media === 'string') {
			const file = path.join(process.cwd(), 'images', media);
			image = 'attach://' + file; // local file
		}
		else
			throw new Error(`unknown media type: ${typeof media}`);
		
		let photoId: string | undefined;
		
		if (messageId) {
			if (typeof media === 'function') {
				const filename = (Math.random() + '.png').slice(2);
				intermediaryFile = path.join(process.cwd(), 'images', filename);
				fs.writeFileSync(intermediaryFile, image); // см. строку 64 (1)
				image = 'attach://' + intermediaryFile;
			}
			
			const response = await this.editMessageMedia({
				type: 'photo',
				caption,
				parse_mode: 'HTML',
				media: image,
			}, messageParams);
			
			if(typeof response !== 'boolean' && response.photo) photoId = response.photo[0].file_id;
		}
		else {
			const response = await this.sendPhoto(chatId, image, {
				caption,
				parse_mode: 'HTML',
				reply_markup: { inline_keyboard },
			});
			
			if(typeof response !== 'boolean' && response.photo) photoId = response.photo[0].file_id;
			nextMessageId = response.message_id;
		}
		
		if (photoId) {
			mediaCache[uniqueKey] = {
				expiresAt: Date.now() + expiresIn,
				photoId,
			}
		}
		
		if (intermediaryFile !== undefined) {
			console.log('Unlinked intermediary file')
			fs.unlinkSync(intermediaryFile)
		}
	}
	
	return nextMessageId;
}
