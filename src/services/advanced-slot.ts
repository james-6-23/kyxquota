/**
 * 高级场系统服务层
 */

import { advancedSlotQueries, userQueries } from '../database';
import type { UserTickets, AdvancedSlotConfig } from '../types';
import { isBannedFromAdvanced, getKunbeiConfig } from './kunbei';
import logger from '../utils/logger';

/**
 * 获取用户显示名称（优先使用 linux_do_username，否则使用 linux_do_id）
 */
function getUserDisplayName(linuxDoId: string): string {
    const user = userQueries.get.get(linuxDoId);
    if (user?.linux_do_username) {
        return user.linux_do_username;
    }
    return linuxDoId;
}

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
        logger.error('高级场', `查询入场券信息失败: ${error}`);
        return null;
    }
}

/**
 * 获取高级场配置
 */
export function getAdvancedSlotConfig(): AdvancedSlotConfig {
    const result = advancedSlotQueries.getAdvancedConfig.get();

    if (!result) {
        logger.error('高级场', '配置未找到，返回默认配置');
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
            daily_entry_limit: 2,         // 默认每日2次
            daily_ticket_grant_limit: 2,  // 默认每日获得2张
            updated_at: Date.now()
        };
    }

    return result;
}

/**
 * 添加入场券（最多持有N张，有效期24小时）
 */
export function addTicket(linuxDoId: string, count: number = 1): { success: boolean; message?: string; granted?: number } {
    const now = Date.now();
    const config = getAdvancedSlotConfig();
    const today = getTodayDate();

    // 检查今日获得限制
    const todayGrant = advancedSlotQueries.getTodayGrant.get(linuxDoId, today);
    const ticketsGrantedToday = todayGrant?.ticket_granted || 0;

    if (ticketsGrantedToday >= config.daily_ticket_grant_limit) {
        logger.info('入场券', `用户 ${getUserDisplayName(linuxDoId)} 今日已获得 ${ticketsGrantedToday} 张入场券，达到限制 ${config.daily_ticket_grant_limit}`);
        return {
            success: false,
            message: `今日获得入场券已达上限（${config.daily_ticket_grant_limit}张）`
        };
    }

    // 计算实际可获得数量
    const remainingQuota = config.daily_ticket_grant_limit - ticketsGrantedToday;
    const actualCount = Math.min(count, remainingQuota);

    if (actualCount <= 0) {
        return {
            success: false,
            message: '今日入场券获得配额已用完'
        };
    }

    const expiresAt = now + (config.ticket_valid_hours * 3600000);

    advancedSlotQueries.addTickets.run(
        linuxDoId, actualCount, expiresAt, now,
        actualCount, config.max_tickets_hold, expiresAt, now
    );

    // 记录今日获得数量
    advancedSlotQueries.updateTodayTicketGrant.run(
        linuxDoId, today, actualCount, 0, now, actualCount, 0, now
    );

    logger.info('入场券', `用户 ${getUserDisplayName(linuxDoId)} 获得 ${actualCount} 张入场券（今日已获得 ${ticketsGrantedToday + actualCount}/${config.daily_ticket_grant_limit}）`);

    return {
        success: true,
        granted: actualCount,
        message: actualCount < count ? `仅获得 ${actualCount} 张入场券（今日限额）` : undefined
    };
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

    logger.info('碎片', `用户 ${getUserDisplayName(linuxDoId)} 获得 ${count} 个碎片`);
}

/**
 * 合成入场券（5碎片 → 1券）
 */
export function synthesizeTicket(linuxDoId: string): { success: boolean; message: string; data?: any } {
    const tickets = getUserTickets(linuxDoId);
    const config = getAdvancedSlotConfig();
    const today = getTodayDate();

    if (!tickets || tickets.fragments < config.fragments_needed) {
        return {
            success: false,
            message: `碎片不足，需要 ${config.fragments_needed} 个碎片`
        };
    }

    // 🔥 检查今日获得入场券限制
    const todayGrant = advancedSlotQueries.getTodayGrant.get(linuxDoId, today);
    const ticketsGrantedToday = todayGrant?.ticket_granted || 0;

    if (ticketsGrantedToday >= config.daily_ticket_grant_limit) {
        logger.info('合成', `用户 ${getUserDisplayName(linuxDoId)} 今日已获得 ${ticketsGrantedToday} 张入场券，达到限制 ${config.daily_ticket_grant_limit}`);
        return {
            success: false,
            message: `今日获得入场券已达上限（${config.daily_ticket_grant_limit}张），无法合成`
        };
    }

    // 🔥 检查持有上限
    if (tickets.tickets >= config.max_tickets_hold) {
        return {
            success: false,
            message: `已达持有上限（${config.max_tickets_hold}张），无法合成`
        };
    }

    const now = Date.now();
    const expiresAt = now + (config.ticket_valid_hours * 3600000);

    // 减少碎片并增加入场券
    const newFragments = tickets.fragments - config.fragments_needed;
    const newTickets = tickets.tickets + 1;  // 已检查上限，直接+1

    advancedSlotQueries.upsertTickets.run(
        linuxDoId,
        newTickets,
        newFragments,
        expiresAt,
        tickets.advanced_mode_until,
        now
    );

    // 🔥 记录今日获得数量（合成也算获得）
    advancedSlotQueries.updateTodayTicketGrant.run(
        linuxDoId, today, 1, 0, now, 1, 0, now
    );

    logger.info('合成', `用户 ${getUserDisplayName(linuxDoId)} 合成了1张入场券（今日已获得 ${ticketsGrantedToday + 1}/${config.daily_ticket_grant_limit}）`);

    return {
        success: true,
        message: '合成成功！获得1张高级场入场券',
        data: {
            tickets: newTickets,
            fragments: newFragments,
            expires_at: expiresAt,
            today_granted: ticketsGrantedToday + 1,
            daily_limit: config.daily_ticket_grant_limit
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
 * 获取今日日期（YYYY-MM-DD格式，北京时间）
 * 重置时间：北京时间每天00:00:00
 */
function getTodayDate(): string {
    // 🔥 使用北京时区（Asia/Shanghai, UTC+8）
    const beijingDateStr = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    // 转换格式：'2025/10/31' → '2025-10-31'
    const [year, month, day] = beijingDateStr.split('/');
    return `${year}-${month}-${day}`;
}

/**
 * 进入高级场（消耗1张入场券）
 */
export async function enterAdvancedMode(linuxDoId: string): Promise<{ success: boolean; message: string; validUntil?: number }> {
    // 🔥 检查坤呗逾期惩罚（禁止进入高级场）
    const kunbeiConfig = getKunbeiConfig();
    if (kunbeiConfig.overdue_ban_advanced) {
        const banStatus = isBannedFromAdvanced(linuxDoId);
        if (banStatus.banned) {
            const remainingHours = Math.ceil((banStatus.until! - Date.now()) / 3600000);
            logger.info('高级场', `进入失败 - 用户: ${getUserDisplayName(linuxDoId)}, 坤呗逾期惩罚中，剩余 ${remainingHours} 小时`);
            return {
                success: false,
                message: `您因逾期未还款被禁止进入高级场，解禁时间：${new Date(banStatus.until!).toLocaleString('zh-CN', { hour12: false })} (剩余约${remainingHours}小时)`
            };
        }
    }

    // 检查入场券是否过期
    checkTicketExpiry(linuxDoId);

    const tickets = getUserTickets(linuxDoId);

    if (!tickets || tickets.tickets < 1) {
        logger.info('高级场', `进入失败 - 用户: ${getUserDisplayName(linuxDoId)}, 入场券不足: ${tickets?.tickets || 0}`);
        return {
            success: false,
            message: '入场券不足，无法进入高级场'
        };
    }

    const config = getAdvancedSlotConfig();

    if (!config.enabled) {
        logger.info('高级场', '进入失败 - 高级场功能已关闭');
        return {
            success: false,
            message: '高级场功能已关闭'
        };
    }

    // 检查每日进入次数限制
    const today = getTodayDate();
    const todayEntry = advancedSlotQueries.getTodayEntry.get(linuxDoId, today);
    const entryCount = todayEntry?.entry_count || 0;

    if (entryCount >= config.daily_entry_limit) {
        logger.info('高级场', `进入失败 - 用户: ${getUserDisplayName(linuxDoId)}, 今日已进入 ${entryCount} 次，达到限制 ${config.daily_entry_limit}`);
        return {
            success: false,
            message: `今日进入次数已达上限（${config.daily_entry_limit}次）`
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
                logger.info('高级场', `用户 ${getUserDisplayName(linuxDoId)} 成功进入高级场，有效期至 ${new Date(validUntil).toLocaleString()}`);
            } else {
                logger.error('高级场', `进入失败 - 用户: ${getUserDisplayName(linuxDoId)}, 验证失败`);
                return {
                    success: false,
                    message: '进入失败，请重试'
                };
            }
        } else {
            // 如果 result.changes 存在，直接使用
            if (result.changes === 0) {
                logger.info('高级场', `进入失败 - 用户: ${getUserDisplayName(linuxDoId)}, 数据库更新失败`);
                return {
                    success: false,
                    message: '进入失败，请重试'
                };
            }
            logger.info('高级场', `用户 ${getUserDisplayName(linuxDoId)} 成功进入高级场，有效期至 ${new Date(validUntil).toLocaleString()}`);
        }
    } catch (error) {
        logger.error('高级场', `进入高级场失败 - 用户: ${getUserDisplayName(linuxDoId)}, 错误: ${error}`);
        return {
            success: false,
            message: '数据库操作失败'
        };
    }

    // 记录今日进入次数
    try {
        advancedSlotQueries.updateTodayEntry.run(linuxDoId, today, now, now);
        logger.info('高级场', `记录用户 ${getUserDisplayName(linuxDoId)} 今日第 ${entryCount + 1} 次进入高级场`);
    } catch (error) {
        logger.error('高级场', `记录进入次数失败: ${error}`);
        // 不影响进入成功
    }

    // 🏆 触发成就检查
    try {
        const { checkAndUnlockAchievement, updateAchievementProgress } = await import('./achievement');

        // 首次进入高级场成就
        await checkAndUnlockAchievement(linuxDoId, 'first_advanced');

        // 高级场常客成就（进入10次）
        await updateAchievementProgress(linuxDoId, 'advanced_10_times', 1);
    } catch (error: any) {
        logger.warn('高级场', `成就检查失败: ${error.message}`);
    }

    return {
        success: true,
        message: `成功进入高级场！（今日第${entryCount + 1}次）`,
        validUntil
    };
}

/**
 * 退出高级场
 */
export function exitAdvancedMode(linuxDoId: string): void {
    const now = Date.now();

    advancedSlotQueries.exitAdvancedMode.run(now, linuxDoId);

    logger.info('高级场', `用户 ${getUserDisplayName(linuxDoId)} 退出高级场`);
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

    logger.info('掉落记录', `用户 ${getUserDisplayName(linuxDoId)} 获得 ${dropType} x${dropCount}，触发: ${triggerWinType}`);
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

