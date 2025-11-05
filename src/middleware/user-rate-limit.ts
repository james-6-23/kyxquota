/**
 * 用户操作速率限制中间件
 * 防止通过API恶意刷接口
 */

import type { Context, Next } from 'hono';
import type { SessionData } from '../types';
import logger from '../utils/logger';

interface RateLimitRecord {
    count: number;
    resetTime: number;
    lastRequestTime: number;
    violationCount?: number;  // 🛡️ 违规次数
    firstViolationTime?: number;  // 🛡️ 首次违规时间
}

interface RateLimitConfig {
    /** 窗口时间（毫秒） */
    windowMs: number;
    /** 窗口内最大请求数 */
    maxRequests: number;
    /** 最小请求间隔（毫秒） */
    minInterval?: number;
    /** 操作名称（用于日志） */
    operationName?: string;
    /** 🛡️ 累计惩罚阈值（1分钟内触发多少次后封禁） */
    penaltyThreshold?: number;
    /** 🛡️ 累计惩罚时长（毫秒） */
    penaltyDuration?: number;
}

// 存储用户请求记录 - 用户ID -> 操作类型 -> 记录
const userRecords = new Map<string, Map<string, RateLimitRecord>>();

// 存储IP请求记录 - IP -> 操作类型 -> 记录
const ipRecords = new Map<string, Map<string, RateLimitRecord>>();

// 🛡️ 存储临时封禁记录 - 用户ID -> 封禁结束时间
const tempBans = new Map<string, number>();

/**
 * 获取客户端真实IP
 */
function getClientIP(c: Context): string {
    // 尝试从各种头部获取真实IP
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    const realIp = c.req.header('x-real-ip');
    if (realIp) {
        return realIp;
    }

    // Cloudflare
    const cfIp = c.req.header('cf-connecting-ip');
    if (cfIp) {
        return cfIp;
    }

    return 'unknown';
}

/**
 * 检查速率限制
 */
function checkRateLimit(
    records: Map<string, Map<string, RateLimitRecord>>,
    identifier: string,
    operationType: string,
    config: RateLimitConfig
): { allowed: boolean; retryAfter?: number; reason?: string } {
    const now = Date.now();

    // 获取或创建该标识符的记录
    if (!records.has(identifier)) {
        records.set(identifier, new Map());
    }

    const identifierRecords = records.get(identifier)!;

    // 获取或创建该操作类型的记录
    if (!identifierRecords.has(operationType)) {
        identifierRecords.set(operationType, {
            count: 0,
            resetTime: now + config.windowMs,
            lastRequestTime: 0,
            violationCount: 0,
            firstViolationTime: 0
        });
    }

    const record = identifierRecords.get(operationType)!;

    // 检查是否需要重置窗口
    if (now >= record.resetTime) {
        record.count = 0;
        record.resetTime = now + config.windowMs;
    }

    // 🛡️ 重置违规计数（1分钟后重置）
    if (record.firstViolationTime && now - record.firstViolationTime > 60000) {
        record.violationCount = 0;
        record.firstViolationTime = 0;
    }

    // 检查最小请求间隔
    if (config.minInterval && record.lastRequestTime > 0) {
        const timeSinceLastRequest = now - record.lastRequestTime;
        if (timeSinceLastRequest < config.minInterval) {
            const retryAfter = Math.ceil((config.minInterval - timeSinceLastRequest) / 1000);

            // 🛡️ 记录违规
            if (!record.firstViolationTime) {
                record.firstViolationTime = now;
            }
            record.violationCount = (record.violationCount || 0) + 1;

            return {
                allowed: false,
                retryAfter,
                reason: `请求过于频繁，请等待 ${retryAfter} 秒后再试`
            };
        }
    }

    // 检查窗口内请求次数
    if (record.count >= config.maxRequests) {
        const retryAfter = Math.ceil((record.resetTime - now) / 1000);

        // 🛡️ 记录违规
        if (!record.firstViolationTime) {
            record.firstViolationTime = now;
        }
        record.violationCount = (record.violationCount || 0) + 1;

        return {
            allowed: false,
            retryAfter,
            reason: `请求次数超限，请在 ${retryAfter} 秒后再试`
        };
    }

    // 通过检查，增加计数
    record.count++;
    record.lastRequestTime = now;

    return { allowed: true };
}

/**
 * 创建速率限制中间件
 */
export function createRateLimiter(config: RateLimitConfig) {
    const operationType = config.operationName || 'default';

    return async (c: Context, next: Next) => {
        const session = c.get('session') as SessionData | undefined;
        const clientIP = getClientIP(c);
        const now = Date.now();

        // 🛡️ 检查是否在临时封禁中
        if (session?.linux_do_id) {
            const banUntil = tempBans.get(session.linux_do_id);
            if (banUntil && now < banUntil) {
                const remainingMinutes = Math.ceil((banUntil - now) / 60000);
                logger.warn('速率限制', `用户 ${session.linux_do_id} 在临时封禁中，剩余 ${remainingMinutes} 分钟`);
                return c.json({
                    success: false,
                    message: `⚠️ 检测到异常请求行为，已被临时限制。解除时间：${new Date(banUntil).toLocaleString('zh-CN')} (剩余${remainingMinutes}分钟)`
                }, 403);
            }
        }

        // 如果没有session，至少基于IP限制
        if (!session?.linux_do_id) {
            const ipCheck = checkRateLimit(ipRecords, clientIP, operationType, config);
            if (!ipCheck.allowed) {
                logger.warn('速率限制', `IP ${clientIP} 触发限制: ${ipCheck.reason}`);
                return c.json({
                    success: false,
                    message: ipCheck.reason || '请求过于频繁',
                    retryAfter: ipCheck.retryAfter
                }, 429);
            }
        } else {
            // 基于用户ID的限制（主要限制）
            const userCheck = checkRateLimit(
                userRecords,
                session.linux_do_id,
                operationType,
                config
            );

            if (!userCheck.allowed) {
                logger.warn(
                    '速率限制',
                    `用户 ${session.linux_do_id} 触发限制 [${operationType}]: ${userCheck.reason}`
                );

                // 🛡️ 检查是否需要触发累计惩罚
                const identifierRecords = userRecords.get(session.linux_do_id);
                const record = identifierRecords?.get(operationType);

                if (config.penaltyThreshold && config.penaltyDuration && record) {
                    const violationCount = record.violationCount || 0;

                    if (violationCount >= config.penaltyThreshold) {
                        // 触发累计惩罚封禁
                        const banUntil = now + config.penaltyDuration;
                        tempBans.set(session.linux_do_id, banUntil);

                        // 🛡️ 记录到数据库
                        try {
                            const { rateLimitBanQueries, userQueries } = await import('../database');
                            const user = userQueries.get.get(session.linux_do_id);
                            const username = user?.linux_do_username || user?.username || session.linux_do_id;

                            rateLimitBanQueries.insert.run(
                                session.linux_do_id,
                                username,
                                'rate_limit_penalty',
                                violationCount,
                                `${operationType}操作触发速率限制${violationCount}次，自动临时封禁`,
                                now,
                                banUntil,
                                now
                            );
                        } catch (err) {
                            logger.error('速率限制', `记录封禁失败: ${err}`);
                        }

                        const banMinutes = Math.ceil(config.penaltyDuration / 60000);
                        logger.error(
                            '速率限制',
                            `⚠️ 用户 ${session.linux_do_id} 触发累计惩罚！违规${violationCount}次，封禁${banMinutes}分钟`
                        );

                        // 重置违规计数
                        record.violationCount = 0;
                        record.firstViolationTime = 0;

                        return c.json({
                            success: false,
                            message: `⚠️ 检测到异常请求行为，已被临时限制${banMinutes}分钟。请勿使用脚本或自动化工具。`
                        }, 403);
                    }
                }

                return c.json({
                    success: false,
                    message: userCheck.reason || '请求过于频繁',
                    retryAfter: userCheck.retryAfter
                }, 429);
            }

            // 基于IP的辅助限制（更宽松，防止多账号刷）
            const ipConfig: RateLimitConfig = {
                ...config,
                maxRequests: config.maxRequests * 3, // IP限制放宽到3倍
                minInterval: config.minInterval ? config.minInterval / 2 : undefined
            };

            const ipCheck = checkRateLimit(ipRecords, clientIP, operationType, ipConfig);
            if (!ipCheck.allowed) {
                logger.warn(
                    '速率限制',
                    `IP ${clientIP} (用户: ${session.linux_do_id}) 触发IP级限制: ${ipCheck.reason}`
                );
                return c.json({
                    success: false,
                    message: '检测到异常请求频率，请稍后再试',
                    retryAfter: ipCheck.retryAfter
                }, 429);
            }
        }

        await next();
    };
}

/**
 * 预定义的速率限制配置
 */
export const RateLimits = {
    /** 抽奖操作 - 严格限制 */
    SLOT_SPIN: {
        windowMs: 60 * 1000,        // 1分钟
        maxRequests: 30,             // 最多30次（每2秒1次）
        minInterval: 1500,           // 最小间隔1.5秒
        operationName: '抽奖',
        penaltyThreshold: 10,        // 🛡️ 1分钟内触发10次限制
        penaltyDuration: 10 * 60 * 1000  // 🛡️ 封禁10分钟
    },

    /** 至尊场抽奖 - 更严格限制（金额更大） */
    SUPREME_SPIN: {
        windowMs: 60 * 1000,        // 1分钟
        maxRequests: 20,             // 最多20次（每3秒1次）
        minInterval: 2000,           // 最小间隔2秒
        operationName: '至尊场抽奖',
        penaltyThreshold: 8,         // 🛡️ 1分钟内触发8次限制
        penaltyDuration: 15 * 60 * 1000  // 🛡️ 封禁15分钟
    },

    /** 进入/退出场次 */
    MODE_SWITCH: {
        windowMs: 60 * 1000,        // 1分钟
        maxRequests: 10,             // 最多10次
        minInterval: 1000,           // 最小间隔1秒
        operationName: '场次切换',
        penaltyThreshold: 15,        // 🛡️ 1分钟内触发15次限制
        penaltyDuration: 5 * 60 * 1000   // 🛡️ 封禁5分钟
    },

    /** 购买次数/合成 */
    PURCHASE: {
        windowMs: 60 * 1000,        // 1分钟
        maxRequests: 20,             // 最多20次
        minInterval: 500,            // 最小间隔0.5秒
        operationName: '购买操作',
        penaltyThreshold: 30,        // 🛡️ 1分钟内触发30次限制
        penaltyDuration: 10 * 60 * 1000  // 🛡️ 封禁10分钟
    },

    /** 一般查询操作 */
    QUERY: {
        windowMs: 10 * 1000,        // 10秒
        maxRequests: 50,             // 最多50次
        operationName: '查询',
        penaltyThreshold: 100,       // 🛡️ 1分钟内触发100次限制
        penaltyDuration: 5 * 60 * 1000   // 🛡️ 封禁5分钟
    }
};

/**
 * 清理过期记录（定时任务）
 */
export function cleanupExpiredRecords() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedIPs = 0;

    // 清理用户记录
    for (const [identifier, records] of userRecords.entries()) {
        for (const [type, record] of records.entries()) {
            if (now > record.resetTime + 60000) { // 超过重置时间1分钟
                records.delete(type);
            }
        }
        if (records.size === 0) {
            userRecords.delete(identifier);
            cleanedUsers++;
        }
    }

    // 清理IP记录
    for (const [ip, records] of ipRecords.entries()) {
        for (const [type, record] of records.entries()) {
            if (now > record.resetTime + 60000) {
                records.delete(type);
            }
        }
        if (records.size === 0) {
            ipRecords.delete(ip);
            cleanedIPs++;
        }
    }

    if (cleanedUsers > 0 || cleanedIPs > 0) {
        logger.info('速率限制', `清理过期记录 - 用户: ${cleanedUsers}, IP: ${cleanedIPs}`);
    }
}

// 每5分钟清理一次过期记录
setInterval(cleanupExpiredRecords, 5 * 60 * 1000);

/**
 * 获取统计信息
 */
export function getRateLimitStats() {
    return {
        totalUsers: userRecords.size,
        totalIPs: ipRecords.size,
        userDetails: Array.from(userRecords.entries()).map(([id, records]) => ({
            identifier: id,
            operations: Array.from(records.entries()).map(([type, record]) => ({
                type,
                count: record.count,
                resetIn: Math.max(0, record.resetTime - Date.now())
            }))
        })),
        ipDetails: Array.from(ipRecords.entries()).map(([ip, records]) => ({
            ip,
            operations: Array.from(records.entries()).map(([type, record]) => ({
                type,
                count: record.count,
                resetIn: Math.max(0, record.resetTime - Date.now())
            }))
        }))
    };
}
