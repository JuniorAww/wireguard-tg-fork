import fs from 'fs';
import path from 'path';
import { Database, User, AccessRequest, UserConfig } from '$/db/types';
import { logActivity } from '$/utils/logger';

const dbFilePath = path.join(process.cwd(), 'data', 'database.json');
const SAVE_INTERVAL = 15 * 1000; // 15 секунд

let database: Database = {
    users: {},
    accessRequests: {},
};

const dataDir = path.dirname(dbFilePath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

export function loadDb(): void {
    try {
        if (fs.existsSync(dbFilePath)) {
            const data = fs.readFileSync(dbFilePath, 'utf-8');
            database = JSON.parse(data);
            logActivity('Database loaded successfully.');
        } else {
            logActivity('No existing database found, starting with an empty one.');
            saveDb();
        }
    } catch (error) {
        console.error('Error loading database:', error);
        logActivity(`Error loading database: ${error}`);
    }
}

export function saveDb(): void {
    try {
        const data = JSON.stringify(database, null, 2);
        fs.writeFileSync(dbFilePath, data, 'utf-8');
        // logActivity('Database saved successfully.'); // Можно раскомментировать для отладки, но будет спамить логи
    } catch (error) {
        console.error('Error saving database:', error);
        logActivity(`Error saving database: ${error}`);
    }
}

// Автосохранение
setInterval(saveDb, SAVE_INTERVAL);

export function getUser(userId: number): User | undefined {
    return database.users[userId];
}

export function ensureUser(userId: number, username?: string): User {
    if (!database.users[userId]) {
        database.users[userId] = {
            id: userId,
            username: username,
            hasAccess: false,
            configs: [],
        };
        logActivity(`New user created: ${userId} (${username || 'N/A'})`);
    } else if (username && database.users[userId].username !== username) {
        database.users[userId].username = username;
    }
    return database.users[userId];
}

export function updateUser(userId: number, partialUser: Partial<User>): void {
    if (database.users[userId]) {
        database.users[userId] = { ...database.users[userId], ...partialUser };
    }
}

export function addAccessRequest(userId: number, username?: string, adminMessageId?: number): void {
    database.accessRequests[userId] = {
        userId,
        username,
        requestedAt: new Date().toISOString(),
        adminMessageId,
    };
    logActivity(`Access request added for user: ${userId} (${username || 'N/A'})`);
}

export function getAccessRequest(userId: number): AccessRequest | undefined {
    return database.accessRequests[userId];
}

export function removeAccessRequest(userId: number): void {
    delete database.accessRequests[userId];
    logActivity(`Access request removed for user: ${userId}`);
}

export function getAllUsersWithAccess(): User[] {
    return Object.values(database.users).filter(user => user.hasAccess);
}

export function getAllConfigs(): Array<UserConfig & { ownerId: number, ownerUsername?: string }> {
    const allConfigs: Array<UserConfig & { ownerId: number, ownerUsername?: string }> = [];
    for (const userId in database.users) {
        const user = database.users[userId];
        user.configs.forEach(config => {
            allConfigs.push({
                ...config,
                ownerId: user.id,
                ownerUsername: user.username
            });
        });
    }
    return allConfigs;
}
