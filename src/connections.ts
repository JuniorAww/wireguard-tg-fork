import { ConnectionInfo, UserConfig } from './types';
import { listWgClients } from './wg_easy_api';
import { logActivity } from './logger';

/* BETA handshake, transfer info */
// TODO общая статистика трафика

let connectionInfo: Record<string, ConnectionInfo> = {};
let lastHourUsage = { rx: 0, tx: 0 };

const updateConnectionInfos = async () => {
    const clients = await listWgClients() || []
    let clientIds: string[] = []
    clients.forEach(client => {
        /* Небольшая запись статистики для /start */
        const entry = connectionInfo[client.id]
        if(entry !== undefined) {
            lastHourUsage.rx += (client.transferRx - entry.transferRx)
            lastHourUsage.tx += (client.transferTx - entry.transferTx)
        }
        
        /* Записываем кеш */
        connectionInfo[client.id] = {
            transferRx: client.transferRx,
            transferTx: client.transferTx,
            latestHandshakeAt: client.latestHandshakeAt
        }
        clientIds.push(client.id)
    })
    // Подчищаем удаленные конфиги из кеша
    for(const clientId of Object.keys(connectionInfo)) {
        if(!clientIds.includes(clientId))
            delete connectionInfo[clientId];
    }
}

setInterval(updateConnectionInfos, 30000);
setTimeout(updateConnectionInfos, 5000);

export { lastHourUsage };

export function getWgConnectionInfo(clientId: string): Promise<ConnectionInfo | null> {
    logActivity(`Fetching connection info for client ${clientId}`);
    return connectionInfo[clientId] || null;
}

export function getTotalBandwidthUsage(configs: UserConfig[]): Promise<number[] | null> {
    logActivity(`Fetching total bandwidth usage`);
    let rx = 0; let tx = 0;
    for(const config of configs) {
        const client = connectionInfo[config.wgEasyClientId]
        if(!client) continue;
        rx += client.transferRx;
        tx += client.transferTx;
    }
    return [ rx, tx ]
}
