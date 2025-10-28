/**
 * 高级场系统服务层
 */

import { advancedSlotQueries } from '../database';
import type { UserTickets, AdvancedSlotConfig } from '../types';

/**
 * 获取用户入场券信息
 */
export function getUserTickets(linuxDoId: string): UserTickets | null {
    try {
        const result = advancedSlotQueries.getTickets.get(linuxDoId);

        if (!result) {
            return {
                linux_do_id: linuxDoId,
                tickets: 0,
                fragments: 0,
                tickets_expires_at: null,
                advanced_mode_until: null,
                updated_at: Date.now()
            };
        }

        return result;
    } catch (error) {
        console.error(`[高级场] 查询入场券信息失败:`, error);
        return null;
    }
}

/**
 * 获取高级场配置
 */
export function getAdvancedSlotConfig(): AdvancedSlotConfig {
    const result = advancedSlotQueries.getAdvancedConfig.get();

    if (!result) {
        console.error('[高级场] 配置未找到，返回默认配置');
        // 返回默认配置而不是抛出错误
        return {
            id: 1,
            enabled: 1,
            bet_min: 50000000,
            bet_max: 250000000,
            reward_multiplier: 4.0,
            penalty_weight_factor: 2.0,
            rtp_target: 0.88,
            ticket_valid_hours: 24,
            session_valid_hours: 24,
            fragments_needed: 5,
            drop_rate_triple: 1.0,
            drop_rate_double: 1.0,
            max_tickets_hold: 2,
            daily_bet_limit: 5000000000,
            updated_at: Date.now()
        };
    }

    return result;
}

/**
 * 添加入场券（最多持有N张，有效期24小时）
 */
export function addTicket(linuxDoId: string, count: number = 1): void {
    const now = Date.now();
    const config = getAdvancedSlotConfig();
    const expiresAt = now + (config.ticket_valid_hours * 3600000);

    advancedSlotQueries.addTickets.run(
        linuxDoId, count, expiresAt, now,
        count, config.max_tickets_hold, expiresAt, now
    );

    console.log(`[入场券] 用户 ${linuxDoId} 获得 ${count} 张入场券，过期时间: ${new Date(expiresAt).toLocaleString()}`);
}

/**
 * 添加碎片
 */
export function addFragment(linuxDoId: string, count: number = 1): void {
    const now = Date.now();

    advancedSlotQueries.addFragments.run(
        linuxDoId, count, now,
        count, now
    );

    console.log(`[碎片] 用户 ${linuxDoId} 获得 ${count} 个碎片`);
}

/**
 * 合成入场券（5碎片 → 1券）
 */
export function synthesizeTicket(linuxDoId: string): { success: boolean; message: string; data?: any } {
    const tickets = getUserTickets(linuxDoId);
    const config = getAdvancedSlotConfig();

    if (!tickets || tickets.fragments < config.fragments_needed) {
        return {
            success: false,
            message: `碎片不足，需要 ${config.fragments_needed} 个碎片`
        };
    }

    const now = Date.now();
    const expiresAt = now + (config.ticket_valid_hours * 3600000);

    // 减少碎片并增加入场券
    const newFragments = tickets.fragments - config.fragments_needed;
    const newTickets = Math.min(tickets.tickets + 1, config.max_tickets_hold);

    advancedSlotQueries.upsertTickets.run(
        linuxDoId,
        newTickets,
        newFragments,
        expiresAt,
        tickets.advanced_mode_until,
        now
    );

    console.log(`[合成] 用户 ${linuxDoId} 合成了1张入场券`);

    return {
        success: true,
        message: '合成成功！获得1张高级场入场券',
        data: {
            tickets: newTickets,
            fragments: newFragments,
            expires_at: expiresAt
        }
    };
}

/**
 * 检查并清理过期入场券
 */
export function checkTicketExpiry(linuxDoId: string): boolean {
    const tickets = getUserTickets(linuxDoId);
    const now = Date.now();

    if (tickets && tickets.tickets_expires_at && tickets.tickets_expires_at < now) {
        advancedSlotQueries.clearExpiredTickets.run(now, linuxDoId, now);
        return true;
    }

    return false;
}

/**
 * 检查用户是否在高级场
 */
export function isInAdvancedMode(linuxDoId: string): boolean {
    const tickets = getUserTickets(linuxDoId);
    const now = Date.now();

    return !!(tickets?.advanced_mode_until && tickets.advanced_mode_until > now);
}

/**
 * 进入高级场（消耗1张入场券）
 */
export function enterAdvancedMode(linuxDoId: string): { success: boolean; message: string; validUntil?: number } {
    // 检查入场券是否过期
    checkTicketExpiry(linuxDoId);

    const tickets = getUserTickets(linuxDoId);

    if (!tickets || tickets.tickets < 1) {
        console.log(`[高级场] 进入失败 - 用户: ${linuxDoId}, 入场券不足: ${tickets?.tickets || 0}`);
        return {
            success: false,
            message: '入场券不足，无法进入高级场'
        };
    }

    const config = getAdvancedSlotConfig();

    if (!config.enabled) {
        console.log(`[高级场] 进入失败 - 高级场功能已关闭`);
        return {
            success: false,
            message: '高级场功能已关闭'
        };
    }

    const now = Date.now();
    const validUntil = now + (config.session_valid_hours * 3600000);

    try {
        const result = advancedSlotQueries.useTicket.run(validUntil, now, linuxDoId);

        // UPDATE 语句可能不返回结果对象（这是正常的）
        // 通过验证查询来确认是否扣除成功
        if (!result || typeof result.changes === 'undefined') {
            // 查询验证是否扣除成功
            const afterTickets = getUserTickets(linuxDoId);

            if (afterTickets && afterTickets.tickets === tickets.tickets - 1 && afterTickets.advanced_mode_until === validUntil) {
                console.log(`[高级场] 用户 ${linuxDoId} 成功进入高级场，有效期至 ${new Date(validUntil).toLocaleString()}`);
            } else {
                console.error(`[高级场] 进入失败 - 用户: ${linuxDoId}, 验证失败`);
                return {
                    success: false,
                    message: '进入失败，请重试'
                };
            }
        } else {
            // 如果 result.changes 存在，直接使用
            if (result.changes === 0) {
                console.log(`[高级场] 进入失败 - 用户: ${linuxDoId}, 数据库更新失败`);
                return {
                    success: false,
                    message: '进入失败，请重试'
                };
            }
            console.log(`[高级场] 用户 ${linuxDoId} 成功进入高级场，有效期至 ${new Date(validUntil).toLocaleString()}`);
        }
    } catch (error) {
        console.error(`[高级场] 进入高级场失败 - 用户: ${linuxDoId}`, error);
        return {
            success: false,
            message: '数据库操作失败'
        };
    }

    return {
        success: true,
        message: '成功进入高级场！',
        validUntil
    };
}

/**
 * 退出高级场
 */
export function exitAdvancedMode(linuxDoId: string): void {
    const now = Date.now();

    advancedSlotQueries.exitAdvancedMode.run(now, linuxDoId);

    console.log(`[高级场] 用户 ${linuxDoId} 退出高级场`);
}

/**
 * 检查高级场资格是否过期
 */
export function checkAdvancedModeExpiry(linuxDoId: string): boolean {
    const tickets = getUserTickets(linuxDoId);
    const now = Date.now();

    if (tickets?.advanced_mode_until && tickets.advanced_mode_until < now) {
        exitAdvancedMode(linuxDoId);
        return true;
    }

    return false;
}

/**
 * 记录入场券掉落
 */
export function recordTicketDrop(
    linuxDoId: string,
    username: string,
    dropType: 'ticket' | 'fragment',
    dropCount: number,
    triggerWinType: string
): void {
    const now = Date.now();
    const date = new Date().toISOString().split('T')[0];

    advancedSlotQueries.insertDropRecord.run(
        linuxDoId,
        username,
        dropType,
        dropCount,
        triggerWinType,
        now,
        date
    );

    console.log(`[掉落记录] 用户 ${username} 获得 ${dropType} x${dropCount}，触发: ${triggerWinType}`);
}

/**
 * 更新高级场RTP统计
 */
export function updateAdvancedRTPStats(
    linuxDoId: string,
    betAmount: number,
    winAmount: number
): void {
    const now = Date.now();

    advancedSlotQueries.updateRTPStats.run(
        linuxDoId, betAmount, winAmount,
        betAmount > 0 ? winAmount / betAmount : 0,
        1, now,
        betAmount, winAmount, now
    );
}

