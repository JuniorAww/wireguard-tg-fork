import { AppConfig } from './types';
import { logActivity } from './logger';
import sharp from 'sharp';

let appConfig: AppConfig;

export function initWgEasyApi(config: AppConfig) {
    appConfig = config;
    console.log(config)
}

async function fetchWgEasy(endpoint: string, options: RequestInit = {}) {
    const url = `${appConfig.wgEasyApiUrl}${endpoint}`;
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    try {
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const errorBody = await response.text();
            logActivity(`wg-easy API Error ${response.status} for ${endpoint}: ${errorBody}`);
            const error = new Error(`wg-easy API request failed with status ${response.status}: ${errorBody}`);
            // @ts-ignore
            error.status = response.status;
            throw error;
        }

        if (response.status === 204) {
            return response;
        }

        // Попытка обработать тело ответа
        try {
            const contentType = response.headers.get("content-type");
            if (options.method?.toUpperCase() === 'POST' || options.method?.toUpperCase() === 'GET' || !options.method) {
                if (contentType && contentType.includes("application/json")) {
                    const textBody = await response.clone().text();
                    if (textBody) {
                        return JSON.parse(textBody);
                    }
                    return {};
                }
            }
            // Для SVG, plain text или других типов файлов всегда возвращаем Response, чтобы его тело можно было прочитать как arrayBuffer или text
            if (contentType && (contentType.includes("image/svg+xml") || contentType.includes("text/plain") || contentType.includes("application/octet-stream"))) {
                return response;
            }
        } catch (e) { /* Ошибка парсинга JSON */ }
        return response;
    } catch (error) {
        logActivity(`wg-easy API fetch error for ${endpoint}: ${error}`);
        throw error;
    }
}


export interface WgEasyClient {
    id: string; // Это wgEasyClientId
    name: string;
    address: string;
    publicKey: string;
    createdAt: string; // ISO Date string
    updatedAt: string; // ISO Date string
    persistentKeepalive: string;
    downloadUrl: string;
    qrCodeUrl: string;
    disabledAt: string | null;
    isOnline: boolean;
    latestHandshakeAt: string | null;
    transferRx: number;
    transferTx: number;
}


export async function createWgClient(clientNameForWgEasy: string): Promise<WgEasyClient | null> {
    logActivity(`Attempting to create wg client: ${clientNameForWgEasy}`);
    try {
        const createResponse = await fetchWgEasy('/api/wireguard/client', {
            method: 'POST',
            body: JSON.stringify({ name: clientNameForWgEasy }),
        });

        if (createResponse && typeof createResponse.status === 'number') {
            if (createResponse.status === 200 || createResponse.status === 201 || createResponse.status === 204) {
                logActivity(`Client ${clientNameForWgEasy} creation request successful (status ${createResponse.status}). Fetching client list to find ID.`);
                const allClients = await listWgClients();
                if (allClients) {
                    const newClient = allClients.find(c => c.name === clientNameForWgEasy);
                    if (newClient) {
                        logActivity(`Successfully created and found wg client: ${clientNameForWgEasy}, ID: ${newClient.id}`);
                        return newClient;
                    }
                }
                logActivity(`Could not find client ${clientNameForWgEasy} in the list after creation.`);
                return null;
            } else {
                try {
                    if (typeof createResponse.json === 'function') {
                        const clientData = await createResponse.json();
                        if (clientData && clientData.id) {
                            logActivity(`Successfully created wg client (from response body with status ${createResponse.status}): ${clientNameForWgEasy}, ID: ${clientData.id}`);
                            return clientData as WgEasyClient;
                        }
                    }
                } catch (e) {
                    logActivity(`Client ${clientNameForWgEasy} creation response (status ${createResponse.status}) was not JSON or did not contain client data: ${e.message}`);
                }
                logActivity(`Unexpected response status after creating client ${clientNameForWgEasy}: ${createResponse.status}`);
                return null;
            }
        }
        else if (createResponse && typeof createResponse === 'object') {
            // @ts-ignore
            if (createResponse.success === true) {
                logActivity(`Client ${clientNameForWgEasy} creation reported success via JSON. Fetching client list to find ID. Response: ${JSON.stringify(createResponse)}`);
                const allClients = await listWgClients();
                if (allClients) {
                    const newClient = allClients.find(c => c.name === clientNameForWgEasy);
                    if (newClient) {
                        logActivity(`Successfully created and found wg client: ${clientNameForWgEasy}, ID: ${newClient.id}`);
                        return newClient;
                    }
                }
                logActivity(`Could not find client ${clientNameForWgEasy} in the list after JSON success response.`);
                return null;
            }
            const clientData = createResponse as WgEasyClient;
            if (clientData && clientData.id) {
                logActivity(`Successfully created wg client (from parsed JSON object with ID): ${clientNameForWgEasy}, ID: ${clientData.id}`);
                return clientData;
            }
            logActivity(`createResponse was a parsed JSON object but did not indicate success clearly or provide an ID. Value: ${JSON.stringify(createResponse)}`);
            return null;
        }
    } catch (error) {
        console.error(`Error creating WireGuard client ${clientNameForWgEasy}:`, error);
        return null;
    }
}

export async function getClientConfiguration(clientId: string): Promise<string | null> {
    logActivity(`Fetching configuration for client ID: ${clientId}`);
    try {
        const response = await fetchWgEasy(`/api/wireguard/client/${clientId}/configuration`, { method: 'GET' });
        if (response.ok) {
            return await response.text();
        }
        logActivity(`Failed to fetch configuration for client ${clientId}. Status: ${response.status}`);
        return null;
    } catch (error) {
        console.error(`Error fetching configuration for client ${clientId}:`, error);
        return null;
    }
}

export async function getClientQrCodeSvg(clientId: string): Promise<Buffer | null> {
    logActivity(`Fetching QR code for client ID: ${clientId}`);
    try {
        const response = await fetchWgEasy(`/api/wireguard/client/${clientId}/qrcode.svg`, { method: 'GET' });
        if (response && typeof response.ok === 'boolean' && response.ok && typeof response.arrayBuffer === 'function') {
            const arrayBuffer = await response.arrayBuffer();
            const svgBuffer = Buffer.from(arrayBuffer);

            if (svgBuffer && svgBuffer.length > 0) {
                logActivity(`Successfully fetched SVG QR code for client ${clientId}, SVG buffer length: ${svgBuffer.length}`);
                // Конвертируем SVG в PNG
                const pngBuffer = await sharp(svgBuffer).png().toBuffer();
                logActivity(`Converted SVG to PNG for client ${clientId}, PNG buffer length: ${pngBuffer.length}`);
                return pngBuffer;
            }
            logActivity(`Fetched QR code for client ${clientId}, but SVG buffer was empty.`);
            return null;
        }
        const responseDetails = response ? `Status: ${response.status}, OK: ${response.ok}, Headers: ${JSON.stringify(Object.fromEntries(response.headers))}` : 'Response object is null/undefined';
        logActivity(`Failed to fetch QR code for client ${clientId}. Response not OK or not a valid Response object. Details: ${responseDetails}`);
        return null;
    } catch (error) {
        console.error(`Error fetching QR code for client ${clientId}:`, error);
        return null;
    }
}

export async function deleteWgClient(clientId: string): Promise<boolean> {
    logActivity(`Attempting to delete wg client ID: ${clientId}`);
    try {
        const response = await fetchWgEasy(`/api/wireguard/client/${clientId}`, { method: 'DELETE' });
        if (response && typeof response.status === 'number') {
            if (response.ok || response.status === 204) { // 200, 201, 202, 203, 204
                logActivity(`Successfully deleted wg client ID: ${clientId} (status ${response.status})`);
                return true;
            }
            logActivity(`Failed to delete wg client ID: ${clientId}. Status: ${response.status}`);
            return false;
        } else if (response && response.success === true) {
            logActivity(`Successfully deleted wg client ID: ${clientId} (JSON success)`);
            return true;
        }
        logActivity(`Failed to delete wg client ID: ${clientId}. Unexpected response: ${JSON.stringify(response)}`);
        return false;
    } catch (error) {
        console.error(`Error deleting WireGuard client ${clientId}:`, error);
        return false;
    }
}

export async function disableWgClient(clientId: string): Promise<boolean> {
    logActivity(`Attempting to disable wg client ID: ${clientId}`);
    try {
        const response = await fetchWgEasy(`/api/wireguard/client/${clientId}/disable`, { method: 'POST' });
        if (response && typeof response.status === 'number') {
            if (response.ok) {
                logActivity(`Successfully disabled wg client ID: ${clientId} (status ${response.status})`);
                return true;
            }
            logActivity(`Failed to disable wg client ID: ${clientId}. Status: ${response.status}`);
            return false;
        } else if (response && response.success === true) {
            logActivity(`Successfully disabled wg client ID: ${clientId} (JSON success)`);
            return true;
        }
        logActivity(`Failed to disable wg client ID: ${clientId}. Unexpected response: ${JSON.stringify(response)}`);
        return false;
    } catch (error) {
        console.error(`Error disabling WireGuard client ${clientId}:`, error);
        return false;
    }
}

export async function enableWgClient(clientId: string): Promise<boolean> {
    logActivity(`Attempting to enable wg client ID: ${clientId}`);
    try {
        const response = await fetchWgEasy(`/api/wireguard/client/${clientId}/enable`, { method: 'POST' });
        if (response && typeof response.status === 'number') {
            if (response.ok) {
                logActivity(`Successfully enabled wg client ID: ${clientId} (status ${response.status})`);
                return true;
            }
            logActivity(`Failed to enable wg client ID: ${clientId}. Status: ${response.status}`);
            return false;
        } else if (response && response.success === true) {
            logActivity(`Successfully enabled wg client ID: ${clientId} (JSON success)`);
            return true;
        }
        llogActivity(`Failed to enable wg client ID: ${clientId}. Unexpected response: ${JSON.stringify(response)}`);
        return false;
    } catch (error) {
        console.error(`Error enabling WireGuard client ${clientId}:`, error);
        return false;
    }
}

export async function listWgClients(): Promise<WgEasyClient[] | null> {
    logActivity(`Attempting to list all wg clients`);
    try {
        const responseData = await fetchWgEasy('/api/wireguard/client', { method: 'GET' });
        if (Array.isArray(responseData)) {
            return responseData as WgEasyClient[];
        }
        logActivity(`listWgClients did not return an array. Response: ${JSON.stringify(responseData)}`);
        return null;
    } catch (error) {
        console.error(`Error listing WireGuard clients:`, error);
        return null;
    }
}
