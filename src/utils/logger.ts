// src/utils/logger.ts
export class Logger {
    private static getTimestamp(): string {
        return new Date().toISOString();
    }

    static info(message: string, ...meta: any[]) {
        console.log(`[INFO] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }

    static warn(message: string, ...meta: any[]) {
        console.warn(`[WARN] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }

    static error(message: string, ...meta: any[]) {
        console.error(`[ERROR] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }

    static debug(message: string, ...meta: any[]) {
        if (process.env.DEBUG === "true") {
            console.debug(`[DEBUG] [${Logger.getTimestamp()}] ${message}`, ...meta);
        }
    }
}
