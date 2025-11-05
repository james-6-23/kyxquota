/**
 * 🛡️ 反滥用和异常行为检测服务
 */

import { rateLimitBanQueries, userQueries } from '../database';
import logger from '../utils/logger';

interface BehaviorPattern {
    requestTimes: number[];      // 请求时间戳列表
    betAmounts: number[];         // 投注金额列表
    lastCheck: number;            // 上次检查时间
}

// 存储用户行为模式 - 用户ID -> 行为模式
const behaviorPatterns = new Map<string, BehaviorPattern>();

/**
 * 🔍 记录用户行为
 */
export function recordBehavior(linuxDoId: string, betAmount?: number) {
    const now = Date.now();
    
    if (!behaviorPatterns.has(linuxDoId)) {
        behaviorPatterns.set(linuxDoId, {
            requestTimes: [],
            betAmounts: [],
            lastCheck: now
        });
    }
    
    const pattern = behaviorPatterns.get(linuxDoId)!;
    
    // 只保留最近5分钟的数据
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    pattern.requestTimes = pattern.requestTimes.filter(t => t > fiveMinutesAgo);
    pattern.betAmounts = pattern.betAmounts.filter((_, idx) => pattern.requestTimes[idx] && pattern.requestTimes[idx] > fiveMinutesAgo);
    
    // 添加新记录
    pattern.requestTimes.push(now);
    if (betAmount !== undefined) {
        pattern.betAmounts.push(betAmount);
    }
}

/**
 * 🔍 检测异常行为
 */
export async function detectAnomalies(linuxDoId: string): Promise<{
    isAnomalous: boolean;
    reason?: string;
    shouldBan?: boolean;
    banDuration?: number;
}> {
    const pattern = behaviorPatterns.get(linuxDoId);
    if (!pattern || pattern.requestTimes.length < 5) {
        return { isAnomalous: false };
    }
    
    const now = Date.now();
    
    // 🚨 检测1：请求频率过高（每秒超过3次）
    const lastSecond = now - 1000;
    const requestsInLastSecond = pattern.requestTimes.filter(t => t > lastSecond).length;
    if (requestsInLastSecond > 3) {
        logger.warn('异常检测', `用户 ${linuxDoId} 请求频率异常：每秒${requestsInLastSecond}次`);
        return {
            isAnomalous: true,
            reason: '请求频率过高（每秒超过3次）',
            shouldBan: requestsInLastSecond > 5,  // 超过5次/秒则封禁
            banDuration: 10 * 60 * 1000  // 10分钟
        };
    }
    
    // 🚨 检测2：固定时间间隔（脚本特征）
    if (pattern.requestTimes.length >= 10) {
        const intervals = [];
        for (let i = 1; i < Math.min(10, pattern.requestTimes.length); i++) {
            intervals.push(pattern.requestTimes[i] - pattern.requestTimes[i - 1]);
        }
        
        // 计算间隔的标准差
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);
        
        // 如果标准差很小（<100ms），说明间隔几乎完全一致，疑似脚本
        if (stdDev < 100 && intervals.length >= 5) {
            logger.warn('异常检测', `用户 ${linuxDoId} 请求间隔异常一致：标准差${stdDev.toFixed(2)}ms，疑似脚本`);
            return {
                isAnomalous: true,
                reason: '请求间隔异常一致（疑似脚本）',
                shouldBan: true,
                banDuration: 30 * 60 * 1000  // 30分钟
            };
        }
    }
    
    // 🚨 检测3：单一金额模式（连续使用同一投注金额）
    if (pattern.betAmounts.length >= 10) {
        const recentBets = pattern.betAmounts.slice(-10);
        const uniqueBets = new Set(recentBets);
        
        // 如果10次投注中只有1-2个不同的金额，疑似脚本
        if (uniqueBets.size <= 2) {
            logger.warn('异常检测', `用户 ${linuxDoId} 投注金额模式单一：10次中只有${uniqueBets.size}种金额`);
            return {
                isAnomalous: true,
                reason: '投注金额模式单一（疑似脚本）',
                shouldBan: uniqueBets.size === 1,  // 完全一致则封禁
                banDuration: 15 * 60 * 1000  // 15分钟
            };
        }
    }
    
    // 🚨 检测4：深夜高频活动（凌晨3-6点）
    const hour = new Date().getHours();
    if (hour >= 3 && hour < 6) {
        const lastMinute = now - 60 * 1000;
        const requestsInLastMinute = pattern.requestTimes.filter(t => t > lastMinute).length;
        
        if (requestsInLastMinute > 20) {
            logger.warn('异常检测', `用户 ${linuxDoId} 深夜高频活动：凌晨${hour}点，1分钟内${requestsInLastMinute}次请求`);
            return {
                isAnomalous: true,
                reason: '深夜高频活动（疑似脚本）',
                shouldBan: true,
                banDuration: 60 * 60 * 1000  // 1小时
            };
        }
    }
    
    return { isAnomalous: false };
}

/**
 * 🛡️ 自动封禁异常用户
 */
export async function banUserForAnomaly(
    linuxDoId: string,
    reason: string,
    duration: number,
    triggerCount: number
): Promise<boolean> {
    try {
        const now = Date.now();
        const banUntil = now + duration;
        
        const user = userQueries.get.get(linuxDoId);
        const username = user?.linux_do_username || user?.username || linuxDoId;
        
        rateLimitBanQueries.insert.run(
            linuxDoId,
            username,
            'behavior_anomaly',
            triggerCount,
            reason,
            now,
            banUntil,
            now
        );
        
        const banMinutes = Math.ceil(duration / 60000);
        logger.error(
            '异常检测',
            `🚨 用户 ${username} (${linuxDoId}) 因异常行为被封禁${banMinutes}分钟 - 原因: ${reason}`
        );
        
        return true;
    } catch (error) {
        logger.error('异常检测', `封禁用户失败: ${error}`);
        return false;
    }
}

/**
 * 🧹 清理过期的行为记录
 */
export function cleanupBehaviorPatterns() {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    let cleaned = 0;
    
    for (const [linuxDoId, pattern] of behaviorPatterns.entries()) {
        // 清理超过5分钟的数据
        pattern.requestTimes = pattern.requestTimes.filter(t => t > fiveMinutesAgo);
        pattern.betAmounts = pattern.betAmounts.filter((_, idx) => pattern.requestTimes[idx] && pattern.requestTimes[idx] > fiveMinutesAgo);
        
        // 如果没有数据了，删除整个记录
        if (pattern.requestTimes.length === 0) {
            behaviorPatterns.delete(linuxDoId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        logger.info('异常检测', `清理${cleaned}个过期行为记录`);
    }
}

// 每10分钟清理一次过期记录
setInterval(cleanupBehaviorPatterns, 10 * 60 * 1000);

/**
 * 📊 获取异常检测统计
 */
export function getAnomalyStats() {
    return {
        totalTracked: behaviorPatterns.size,
        patterns: Array.from(behaviorPatterns.entries()).map(([id, pattern]) => ({
            linuxDoId: id,
            requestCount: pattern.requestTimes.length,
            uniqueBetAmounts: new Set(pattern.betAmounts).size,
            lastActivity: pattern.requestTimes[pattern.requestTimes.length - 1]
        }))
    };
}

