import fs from 'node:fs';
import path from 'node:path';

const logFilePath = path.join(process.cwd(), 'data', 'activity.log');

const dataDir = path.dirname(logFilePath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

export function logActivity(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp}: ${message}\n`;
    console.log(logMessage.trim());
    try {
        fs.appendFileSync(logFilePath, logMessage, 'utf8');
    } catch (error) {
        console.error('Failed to write to log file:', error);
    }
}
