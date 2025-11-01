/**
 * 统一的日志系统
 * 支持日志级别、北京时间显示、彩色输出
 */

// 日志级别枚举
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

// 日志级别颜色（ANSI颜色代码）
const LogColors = {
    DEBUG: '\x1b[36m',   // 青色
    INFO: '\x1b[32m',    // 绿色
    WARN: '\x1b[33m',    // 黄色
    ERROR: '\x1b[31m',   // 红色
    RESET: '\x1b[0m'     // 重置
};

// 日志级别名称
const LogLevelNames = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR'
};

// 当前日志级别（可通过环境变量设置）
let currentLogLevel: LogLevel = LogLevel.INFO;

// 从环境变量读取日志级别
declare const Bun: any;
const envLogLevel = Bun?.env?.LOG_LEVEL?.toUpperCase();
if (envLogLevel === 'DEBUG') currentLogLevel = LogLevel.DEBUG;
if (envLogLevel === 'INFO') currentLogLevel = LogLevel.INFO;
if (envLogLevel === 'WARN') currentLogLevel = LogLevel.WARN;
if (envLogLevel === 'ERROR') currentLogLevel = LogLevel.ERROR;

/**
 * 获取北京时间字符串
 */
function getBeijingTime(): string {
    const now = new Date();
    // 转换为北京时间（UTC+8）
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));

    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    const hour = String(beijingTime.getUTCHours()).padStart(2, '0');
    const minute = String(beijingTime.getUTCMinutes()).padStart(2, '0');
    const second = String(beijingTime.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/**
 * 格式化日志消息
 */
function formatLog(level: LogLevel, tag: string, message: string): string {
    const timestamp = getBeijingTime();
    const levelName = LogLevelNames[level];
    const color = LogColors[levelName as keyof typeof LogColors];
    const reset = LogColors.RESET;

    // 格式: [时间] [级别] [标签] 消息
    return `${color}[${timestamp}] [${levelName}]${reset} [${tag}] ${message}`;
}

/**
 * 统一的日志输出函数
 */
function log(level: LogLevel, tag: string, message: string, ...args: any[]): void {
    if (level < currentLogLevel) {
        return; // 低于当前日志级别，不输出
    }

    const formattedMessage = formatLog(level, tag, message);

    // 根据级别选择输出方法
    if (level === LogLevel.ERROR) {
        console.error(formattedMessage, ...args);
    } else if (level === LogLevel.WARN) {
        console.warn(formattedMessage, ...args);
    } else {
        console.log(formattedMessage, ...args);
    }
}

/**
 * 日志工具类
 */
export const logger = {
    /**
     * DEBUG 级别日志（调试信息）
     */
    debug(tag: string, message: string, ...args: any[]): void {
        log(LogLevel.DEBUG, tag, message, ...args);
    },

    /**
     * INFO 级别日志（一般信息）
     */
    info(tag: string, message: string, ...args: any[]): void {
        log(LogLevel.INFO, tag, message, ...args);
    },

    /**
     * WARN 级别日志（警告信息）
     */
    warn(tag: string, message: string, ...args: any[]): void {
        log(LogLevel.WARN, tag, message, ...args);
    },

    /**
     * ERROR 级别日志（错误信息）
     */
    error(tag: string, message: string, ...args: any[]): void {
        log(LogLevel.ERROR, tag, message, ...args);
    },

    /**
     * 设置日志级别
     */
    setLevel(level: LogLevel): void {
        currentLogLevel = level;
    },

    /**
     * 获取当前日志级别
     */
    getLevel(): LogLevel {
        return currentLogLevel;
    }
};

/**
 * 便捷的日志函数（向后兼容）
 */
export function logInfo(tag: string, message: string, ...args: any[]): void {
    logger.info(tag, message, ...args);
}

export function logWarn(tag: string, message: string, ...args: any[]): void {
    logger.warn(tag, message, ...args);
}

export function logError(tag: string, message: string, ...args: any[]): void {
    logger.error(tag, message, ...args);
}

export function logDebug(tag: string, message: string, ...args: any[]): void {
    logger.debug(tag, message, ...args);
}

// 导出默认实例
export default logger;

