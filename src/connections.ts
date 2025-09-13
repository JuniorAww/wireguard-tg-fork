import { ConnectionInfo, UserConfig } from './types';
import { listWgClients } from './wg_easy_api';
import { logActivity } from './logger';
import * as db from './db';

let connectionInfo: Record<string, ConnectionInfo> = {};

const BUCKETS_COUNT = 120; // 120 бакетов = 1 час
let usageHistory: { rx: number, tx: number }[] = Array(BUCKETS_COUNT).fill({ rx: 0, tx: 0 });
let currentBucketIndex = 0;

export let lastHourUsage = { rx: 0, tx: 0 };

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
            }

            config.lastKnownRx = client.transferRx;
            config.lastKnownTx = client.transferTx;

            db.updateUser(user.id, { configs: user.configs });
        }

        connectionInfo[client.id] = {
            transferRx: client.transferRx,
            transferTx: client.transferTx,
            latestHandshakeAt: client.latestHandshakeAt
        };
    });

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
