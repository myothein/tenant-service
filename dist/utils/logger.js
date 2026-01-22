"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
// src/utils/logger.ts
class Logger {
    static getTimestamp() {
        return new Date().toISOString();
    }
    static info(message, ...meta) {
        console.log(`[INFO] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }
    static warn(message, ...meta) {
        console.warn(`[WARN] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }
    static error(message, ...meta) {
        console.error(`[ERROR] [${Logger.getTimestamp()}] ${message}`, ...meta);
    }
    static debug(message, ...meta) {
        if (process.env.DEBUG === "true") {
            console.debug(`[DEBUG] [${Logger.getTimestamp()}] ${message}`, ...meta);
        }
    }
}
exports.Logger = Logger;
