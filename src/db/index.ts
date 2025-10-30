import fs from 'fs';
import path from 'path';
import { Database, User, AccessRequest, UserConfig, Subnet } from '$/db/types';
import { logActivity } from '$/utils/logger';

const dbFilePath = path.join(process.cwd(), 'data', 'database.json');
const SAVE_INTERVAL = 15 * 1000; // 15 секунд

let database: Database = {
    users: {},
    accessRequests: {},
    subnets: {},
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
			updateTables(database);
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

function updateTables(database: Database) {
	const sampleUserId: string = Object.keys(database.users)[0];
	console.log('Sample user ID', sampleUserId);
	if (!sampleUserId) return;
	
	const sampleUser: User = database.users[+sampleUserId];
	console.log('Sample user', sampleUser);
	
	if (!sampleUser.subnets) {
        logActivity(`Config migration (subnets №1)`);
		
		for (const userId in database.users) {
			const user = database.users[userId]
			//user.role = 2;
			user.subnets = {};
			for (const c of user.configs) {
				c.creator = user.id;
			}
		}
	}
	
	if (!database.subnets) {
		console.log("Config migration (subnets №2)")
		database.subnets = {
			1: {
				name: "Google",
				creator: 0,
				createdAt: Date.now(),
				source: "(await (await fetch('https://www.gstatic.com/ipranges/goog.json')).json()).prefixes.filter(x=>x.ipv4Prefix).map(x=>x.ipv4Prefix)"
			},
			2: {
				name: "Госуслуги",
				creator: 0,
				createdAt: Date.now(),
				source: "await (await import('node:dns/promises')).resolve4('gosuslugi.ru')"
			},
			3: {
				name: "Локальная сеть",
				creator: 0,
				createdAt: Date.now(),
				ips: [ '192.168.0.0/16' ],
			}
		};
	}
    
	if (!sampleUser.settings) {
        logActivity(`Config migration №3`);
		
		for (const userId in database.users) {
			const user = database.users[userId]
			user.settings = {
                utc: 2
            }
		}
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

// TODO если user.username === null и в текущем контексте ее можно получить, установить
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
            subnets: {},
            settings: { utc: 2 },
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

export function getSubnets(): Record<number, Subnet> {
	return database.subnets;
}
