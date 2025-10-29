export interface Device {
    id: string;
    name: string;
}

export interface DailyUsage {
    date: string;
    rx: number;
    tx: number;
}

export interface UserConfig {
	creator: number;
    userGivenName: string;
    wgEasyClientId: string; // ID клиента из wg-easy
    deviceId: string;
    createdAt: string; // ISO timestamp
    isEnabled: boolean;
    totalRx?: number;
    totalTx?: number;
    lastKnownRx?: number;
    lastKnownTx?: number;
    latestHandshakeAt?: string | null;
    dailyUsage?: DailyUsage[];
}

export interface ConnectionInfo {
    transferTx: number;
    transferRx: number;
    latestHandshakeAt: string | null // ISO timestamp
}

export interface User {
    id: number; // Telegram User ID
    username?: string;
    hasAccess: boolean;
    accessRequestedAt?: string;
    accessGrantedAt?: string;
    configs: UserConfig[];
    subnets: Record<string, boolean>;
    // Для отслеживания состояния в многошаговых операциях
    state?: {
        action: string;     // e.g., 'awaiting_config_name'
        data?: any;         // e.g., { deviceId: 'macos_laptop' }
        messageId?: number; // previous message number
    };
}

export interface AccessRequest {
    userId: number;
    username?: string;
    requestedAt: string;
    adminMessageId?: number; // ID сообщения, отправленного админу для одобрения
}

export interface Database {
    users: Record<number, User>;
    accessRequests: Record<number, AccessRequest>; // Ключ - userId
    subnets: Record<string, Subnet>;
}

export interface Subnet {
	name: string;
	creator: number; // Telegram ID
	createdAt: number;
	ips?: string[];
	source?: string; // На будущее (источник, то есть URL или функция парсера)
}

export interface AppConfig {
    telegramBotToken: string;
    adminTelegramIds: number[];
    wgEasyApiUrl: string;
}

export interface CallbackButton {
    text: string;
    callback_data: string;
}
