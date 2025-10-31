import { ConnectionInfo, UserConfig, DailyUsage } from '$/db/types';
import { listWgClients } from '$/api/wg_easy_api';
import { logActivity } from '$/utils/logger';
import * as db from '$/db/index';

let connectionInfo: Record<string, ConnectionInfo> = {};

const BUCKETS_COUNT = 120; // 120 бакетов = 1 час
let usageHistory: { rx: number, tx: number }[] = Array(BUCKETS_COUNT).fill({ rx: 0, tx: 0 });
let currentBucketIndex = 0;

const HOURLY_BUCKETS_COUNT = 24;

export interface HourlyUsage {
    hour: number;
    rx: number;
    tx: number;
}

// UPD: теперь hourlyUsageHistory наполняется бесконечно, без сброса, начиная с 0 до 24. самый первый элемент - это текущий час
export const hourlyUsageHistory: { rx: number, tx: number }[] = Array(HOURLY_BUCKETS_COUNT).fill(null).map(() => ({ rx: 0, tx: 0 }));

let lastUpdateHour = new Date().getUTCHours();

export let lastHourUsage = { rx: 0, tx: 0 };

function getTodayDateString(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

const updateConnectionInfos = async () => {
    const clients = await listWgClients() || [];
    const allUsers = db.getAllUsersWithAccess();
    const allConfigsMap = new Map<string, { user: typeof allUsers[0], config: UserConfig }>();
    allUsers.forEach(user => {
        user.configs.forEach(config => {
            allConfigsMap.set(config.wgEasyClientId, { user, config });
        });
    });

    let currentDeltaRx = 0;
    let currentDeltaTx = 0;
    const todayStr = getTodayDateString();

    clients.forEach(client => {
        const storedConfigData = allConfigsMap.get(client.id);
        if (storedConfigData) {
            const { user, config } = storedConfigData;

            const lastKnownRx = config.lastKnownRx || 0;
            const lastKnownTx = config.lastKnownTx || 0;

            let deltaRx = client.transferRx - lastKnownRx;
            let deltaTx = client.transferTx - lastKnownTx;

            if (deltaRx < 0) deltaRx = client.transferRx;
            if (deltaTx < 0) deltaTx = client.transferTx;

            if (deltaRx > 0 || deltaTx > 0) {
                config.totalRx = (config.totalRx || 0) + deltaRx;
                config.totalTx = (config.totalTx || 0) + deltaTx;
                currentDeltaRx += deltaRx;
                currentDeltaTx += deltaTx;

                // --- Статистика за месяц ---
                if (!config.dailyUsage) {
                    config.dailyUsage = [];
                }
                let todayUsage = config.dailyUsage.find(d => d.date === todayStr);
                if (!todayUsage) {
                    todayUsage = { date: todayStr, rx: 0, tx: 0 };
                    config.dailyUsage.push(todayUsage);
                }
                todayUsage.rx += deltaRx;
                todayUsage.tx += deltaTx;

                config.dailyUsage = config.dailyUsage.slice(-31);
            }

            config.lastKnownRx = client.transferRx;
            config.lastKnownTx = client.transferTx;
            if (client.latestHandshakeAt)
                config.latestHandshakeAt = client.latestHandshakeAt;

            db.updateUser(user.id, { configs: user.configs });
        }

        connectionInfo[client.id] = {
            transferRx: client.transferRx,
            transferTx: client.transferTx,
            latestHandshakeAt: client.latestHandshakeAt
        };
    });

    // --- Статистика за последние 24 часа ---
    const currentHour = new Date().getUTCHours();

    if (currentHour !== lastUpdateHour) {
        lastUpdateHour = currentHour;
        hourlyUsageHistory.unshift({ rx: 0, tx: 0 });
        hourlyUsageHistory.pop();
    }
    
    hourlyUsageHistory[0].rx += currentDeltaRx;
    hourlyUsageHistory[0].tx += currentDeltaTx;
    
    usageHistory[currentBucketIndex] = { rx: currentDeltaRx, tx: currentDeltaTx };
    currentBucketIndex = (currentBucketIndex + 1) % BUCKETS_COUNT;
    usageHistory[currentBucketIndex] = { rx: 0, tx: 0 };

    lastHourUsage = usageHistory.reduce((acc, bucket) => {
        acc.rx += bucket.rx;
        acc.tx += bucket.tx;
        return acc;
    }, { rx: 0, tx: 0 });
}

setInterval(updateConnectionInfos, 30000);
setTimeout(updateConnectionInfos, 5000);

export function getWgConnectionInfo(clientId: string): ConnectionInfo | null {
    logActivity(`Fetching connection info for client ${clientId}`);
    return connectionInfo[clientId] || null;
}

export function getTotalBandwidthUsage(configs: UserConfig[]): [number, number] {
    logActivity(`Fetching total bandwidth usage`);
    let rx = 0; let tx = 0;
    for(const config of configs) {
        rx += config.totalRx || 0;
        tx += config.totalTx || 0;
    }
    return [ rx, tx ];
}

export function getMonthlyUsage(config: UserConfig): { rx: number, tx: number } {
    console.log(config)
    if (!config.dailyUsage) {
        return { rx: 0, tx: 0 };
    }
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return config.dailyUsage.reduce((acc, day) => {
        if (new Date(day.date) >= thirtyDaysAgo) {
            acc.rx += day.rx;
            acc.tx += day.tx;
        }
        return acc;
    }, { rx: 0, tx: 0 });
}
