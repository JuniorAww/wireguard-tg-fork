export interface Device {
    id: string;
    name: string;
}

export interface UserConfig {
    userGivenName: string;
    wgEasyClientId: string; // ID клиента из wg-easy
    deviceId: string;
    createdAt: string; // ISO timestamp
    isEnabled: boolean;
}

export interface ConnectionInfo {
    transferTx: number;
    transferRx: number;
    latestHandshakeAt: string // ISO timestamp
}

export interface User {
    id: number; // Telegram User ID
    username?: string;
    hasAccess: boolean;
    accessRequestedAt?: string;
    accessGrantedAt?: string;
    configs: UserConfig[];
    // Для отслеживания состояния в многошаговых операциях
    state?: {
        action: string; // e.g., 'awaiting_config_name'
        data?: any;     // e.g., { deviceId: 'macos_laptop' }
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
}

export interface AppConfig {
    telegramBotToken: string;
    adminTelegramId: number;
    wgEasyApiUrl: string;
}
