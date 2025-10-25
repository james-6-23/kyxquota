import { Hono } from 'hono';
import { userQueries, slotQueries, adminQueries } from '../database';
import type { SessionData } from '../types';
import { getCookie, getSession } from '../utils';
import {
    getSlotConfig,
    getUserTodaySpins,
    getUserFreeSpins,
    addUserFreeSpins,
    useUserFreeSpin,
    generateSymbols,
    calculateWin,
    saveGameRecord,
    getUserRecords,
    getUserTodayStats,
    updateUserTotalStats,
    getLeaderboard,
    getUserRank,
    getUserTotalStats,
    WIN_TYPE_NAMES,
    WinType
} from '../services/slot';
import { getKyxUserById, updateKyxUserQuota } from '../services/kyx-api';

const slot = new Hono();

/**
 * 中间件：验证用户登录（共享加油站session）
 */
async function requireAuth(c: any, next: any) {
    const sessionId = getCookie(c.req.raw.headers, 'session_id');
    if (!sessionId) {
        return c.json({ success: false, message: '未登录' }, 401);
    }

    const session = await getSession(sessionId);
    if (!session || !session.linux_do_id) {
        return c.json({ success: false, message: '会话无效' }, 401);
    }

    // 检查用户是否被封禁
    const user = userQueries.get.get(session.linux_do_id);
    if (user && user.is_banned) {
        return c.json({
            success: false,
            message: `您的账号已被封禁${user.banned_reason ? '，原因：' + user.banned_reason : ''}`,
            banned: true
        }, 403);
    }

    c.set('session', session);
    await next();
}

// 获取老虎机配置和用户状态
slot.get('/config', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const user = userQueries.get.get(session.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 检查是否被封禁
        if (user.is_banned) {
            return c.json({
                success: false,
                message: '您的账号已被封禁',
                banned: true,
                banned_reason: user.banned_reason
            }, 403);
        }

        const config = getSlotConfig();
        if (!config) {
            return c.json({ success: false, message: '老虎机配置未找到' }, 500);
        }

        if (!config.enabled) {
            return c.json({ success: false, message: '老虎机功能已关闭' }, 403);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 获取用户额度
        const kyxUserResult = await getKyxUserById(user.kyx_user_id, adminConfig.session, adminConfig.new_api_user);
        if (!kyxUserResult.success || !kyxUserResult.user) {
            return c.json({ success: false, message: '获取额度失败' }, 500);
        }

        const quota = kyxUserResult.user.quota;

        // 获取今日游玩次数
        const todaySpins = getUserTodaySpins(session.linux_do_id);

        // 获取免费次数
        const freeSpins = getUserFreeSpins(session.linux_do_id);

        // 获取今日统计
        const todayStats = getUserTodayStats(session.linux_do_id);

        // 计算剩余次数
        const remainingSpins = Math.max(0, config.max_daily_spins - todaySpins);

        // 是否可以游玩
        const canPlay = (remainingSpins > 0 || freeSpins > 0) && quota >= config.min_quota_required;

        return c.json({
            success: true,
            data: {
                config: {
                    bet_amount: config.bet_amount,
                    max_daily_spins: config.max_daily_spins,
                    min_quota_required: config.min_quota_required,
                    enabled: config.enabled
                },
                user: {
                    quota,
                    today_spins: todaySpins,
                    free_spins: freeSpins,
                    remaining_spins: remainingSpins,
                    can_play: canPlay,
                    today_bet: todayStats.totalBet,
                    today_win: todayStats.totalWin,
                    today_count: todayStats.count
                }
            }
        });
    } catch (error) {
        console.error('获取老虎机配置失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 旋转老虎机
slot.post('/spin', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const user = userQueries.get.get(session.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 检查是否被封禁
        if (user.is_banned) {
            return c.json({
                success: false,
                message: '您的账号已被封禁',
                banned: true,
                banned_reason: user.banned_reason
            }, 403);
        }

        const config = getSlotConfig();
        if (!config || !config.enabled) {
            return c.json({ success: false, message: '老虎机功能已关闭' }, 403);
        }

        // 解析请求参数
        const body = await c.req.json();
        const useFreeSpinn = body.useFreeSpinn === true;

        let isFreeSpin = false;
        let betAmount = config.bet_amount;

        if (useFreeSpinn) {
            // 使用免费次数
            const freeSpins = getUserFreeSpins(session.linux_do_id);
            if (freeSpins <= 0) {
                return c.json({ success: false, message: '没有免费次数' }, 400);
            }

            // 扣除免费次数
            const used = useUserFreeSpin(session.linux_do_id);
            if (!used) {
                return c.json({ success: false, message: '扣除免费次数失败' }, 500);
            }

            isFreeSpin = true;
            betAmount = 0; // 免费游戏不扣费
        } else {
            // 检查今日次数
            const todaySpins = getUserTodaySpins(session.linux_do_id);
            if (todaySpins >= config.max_daily_spins) {
                return c.json({ success: false, message: '今日游玩次数已用完' }, 400);
            }

            // 获取管理员配置
            const adminConfig = adminQueries.get.get();
            if (!adminConfig) {
                return c.json({ success: false, message: '系统配置未找到' }, 500);
            }

            // 检查额度
            const kyxUserResult = await getKyxUserById(user.kyx_user_id, adminConfig.session, adminConfig.new_api_user);
            if (!kyxUserResult.success || !kyxUserResult.user) {
                return c.json({ success: false, message: '获取额度失败' }, 500);
            }

            const currentQuota = kyxUserResult.user.quota;

            if (currentQuota < config.min_quota_required) {
                return c.json({
                    success: false,
                    message: `额度不足，最少需要 $${(config.min_quota_required / 500000).toFixed(2)}`
                }, 400);
            }

            if (currentQuota < betAmount) {
                return c.json({
                    success: false,
                    message: `额度不足以支付投注金额 $${(betAmount / 500000).toFixed(2)}`
                }, 400);
            }

            // 扣除投注额度（计算新额度 = 当前额度 - 投注金额）
            const newQuotaAfterBet = currentQuota - betAmount;
            const deductResult = await updateKyxUserQuota(
                user.kyx_user_id,
                newQuotaAfterBet,
                adminConfig.session,
                adminConfig.new_api_user,
                user.username,
                kyxUserResult.user.group || 'default'
            );
            if (!deductResult || !deductResult.success) {
                return c.json({ success: false, message: '扣除额度失败' }, 500);
            }
        }

        // 生成随机符号
        const symbols = generateSymbols();

        // 计算中奖结果
        const result = calculateWin(symbols);

        // 计算中奖金额
        const winAmount = Math.floor(betAmount * result.multiplier);

        // 获取管理员配置（用于更新额度）
        const adminConfigForWin = adminQueries.get.get();
        if (!adminConfigForWin) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 如果中奖，增加额度
        if (winAmount > 0) {
            // 获取当前额度
            const currentKyxUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
            if (currentKyxUser.success && currentKyxUser.user) {
                // 计算新额度 = 当前额度 + 中奖金额
                const newQuotaAfterWin = currentKyxUser.user.quota + winAmount;
                await updateKyxUserQuota(
                    user.kyx_user_id,
                    newQuotaAfterWin,
                    adminConfigForWin.session,
                    adminConfigForWin.new_api_user,
                    user.username,
                    currentKyxUser.user.group || 'default'
                );
            }
        }

        // 如果奖励免费次数
        if (result.freeSpinAwarded) {
            addUserFreeSpins(session.linux_do_id, 1);
        }

        // 保存游戏记录
        saveGameRecord(
            session.linux_do_id,
            user.username,
            betAmount,
            symbols,
            result.winType,
            result.multiplier,
            winAmount,
            result.freeSpinAwarded,
            isFreeSpin
        );

        // 更新用户总统计（用于排行榜）
        updateUserTotalStats(
            session.linux_do_id,
            user.username,
            session.avatar_url || '',
            betAmount,
            winAmount,
            result.winType
        );

        // 获取更新后的状态
        const kyxUserAfterResult = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
        const quotaAfter = (kyxUserAfterResult.success && kyxUserAfterResult.user) ? kyxUserAfterResult.user.quota : 0;

        const todaySpinsAfter = getUserTodaySpins(session.linux_do_id);
        const freeSpinsAfter = getUserFreeSpins(session.linux_do_id);
        const remainingSpinsAfter = Math.max(0, config.max_daily_spins - todaySpinsAfter);

        // 构造响应消息
        let message = WIN_TYPE_NAMES[result.winType];
        if (result.multiplier > 0) {
            message += ` ${result.multiplier}倍！赢得 $${(winAmount / 500000).toFixed(2)}`;
        }
        if (result.freeSpinAwarded) {
            message += ' | 🎁 获得1次免费机会！';
        }

        return c.json({
            success: true,
            data: {
                symbols,
                win_type: result.winType,
                win_type_name: WIN_TYPE_NAMES[result.winType],
                multiplier: result.multiplier,
                bet_amount: betAmount,
                win_amount: winAmount,
                free_spin_awarded: result.freeSpinAwarded,
                quota_after: quotaAfter,
                spins_remaining: remainingSpinsAfter,
                free_spins_remaining: freeSpinsAfter
            },
            message
        });
    } catch (error) {
        console.error('旋转老虎机失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 获取游戏记录
slot.get('/records', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const records = getUserRecords(session.linux_do_id);

        // 解析符号 JSON
        const formattedRecords = records.map(r => ({
            ...r,
            result_symbols: JSON.parse(r.result_symbols),
            win_type_name: WIN_TYPE_NAMES[r.win_type as WinType] || r.win_type
        }));

        return c.json({
            success: true,
            data: formattedRecords
        });
    } catch (error) {
        console.error('获取游戏记录失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 获取今日统计
slot.get('/stats', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const stats = getUserTodayStats(session.linux_do_id);

        return c.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('获取今日统计失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 获取排行榜
slot.get('/leaderboard', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const limit = parseInt(c.req.query('limit') || '100');
        const leaderboard = getLeaderboard(limit);

        // 获取用户自己的排名和统计
        const userStats = getUserTotalStats(session.linux_do_id);
        const userRank = getUserRank(session.linux_do_id);

        return c.json({
            success: true,
            data: {
                leaderboard,
                userStats: userStats || {
                    linux_do_id: session.linux_do_id,
                    total_spins: 0,
                    total_bet: 0,
                    total_win: 0,
                    biggest_win: 0,
                    biggest_win_type: null
                },
                userRank
            }
        });
    } catch (error) {
        console.error('获取排行榜失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

export default slot;

