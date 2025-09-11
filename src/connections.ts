import { ConnectionInfo } from './types';
import { listWgClients } from './wg_easy_api';
import { logActivity } from './logger';

/* BETA handshake, transfer info */
// TODO общая статистика трафика

let connectionInfo: Record<string, ConnectionInfo> = {};

const updateConnectionInfos = async () => {
    const clients = await listWgClients() || []
    let clientIds: string[] = []
    clients.forEach(client => {
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

export function getWgConnectionInfo(clientId: string): Promise<ConnectionInfo | null> {
    logActivity(`Fetching connection info for client ${clientId}`);
    return connectionInfo[clientId] || null;
}
