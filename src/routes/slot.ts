import { Hono } from 'hono';
import { userQueries, slotQueries, adminQueries, pendingRewardQueries, advancedSlotQueries } from '../database';
import type { SessionData } from '../types';
import { getCookie, getSession } from '../utils';
import logger from '../utils/logger';
import { createRateLimiter, RateLimits } from '../middleware/user-rate-limit';
import {
    getSlotConfig,
    getUserTodaySpins,
    getUserTodayBet,
    getUserFreeSpins,
    addUserFreeSpins,
    useUserFreeSpin,
    generateSymbols,
    calculateWin,
    saveGameRecord,
    getUserRecords,
    getUserRecordsByMode,
    getUserTodayStats,
    updateUserTotalStats,
    getLeaderboard,
    getLossLeaderboard,
    getUserRank,
    getUserLossRank,
    getUserTotalStats,
    isUserBanned,
    banUserFromSlot,
    getRewardMultipliers,
    getTodayDate,
    WIN_TYPE_NAMES,
    WinType
} from '../services/slot';
import {
    getUserTickets,
    getAdvancedSlotConfig,
    addTicket,
    addFragment,
    synthesizeTicket,
    checkTicketExpiry,
    isInAdvancedMode,
    enterAdvancedMode,
    exitAdvancedMode,
    checkAdvancedModeExpiry,
    recordTicketDrop
} from '../services/advanced-slot';
import {
    addSupremeFragment,
    recordSupremeDrop
} from '../services/supreme-slot';
import { getKyxUserById, updateKyxUserQuota } from '../services/kyx-api';
import { getAndUseBuff } from '../services/kunbei';
import { checkAndUnlockAchievement, updateAchievementProgress, recordSymbols, updateProfitTracking } from '../services/achievement';

/**
 * 获取用户显示名称（优先使用 linux_do_username）
 */
function getUserDisplayName(linuxDoId: string): string {
    try {
        const user = userQueries.get.get(linuxDoId);
        if (user?.linux_do_username) {
            return `@${user.linux_do_username} (${linuxDoId})`;
        }
        return linuxDoId;
    } catch (error) {
        return linuxDoId;
    }
}

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

        // 🎯 关键修复：使用同一个日期变量进行所有查询
        const today = getTodayDate();

        // 获取今日游玩次数
        const todaySpins = getUserTodaySpins(session.linux_do_id, today);  // 🎯 传入日期

        // 获取免费次数
        const freeSpins = getUserFreeSpins(session.linux_do_id);

        // 获取今日统计
        const todayStats = getUserTodayStats(session.linux_do_id);

        // 获取历史总统计
        const totalStats = getUserTotalStats(session.linux_do_id);

        // 检查是否被禁止抽奖
        const banStatus = isUserBanned(session.linux_do_id);

        // 计算剩余次数
        const remainingSpins = Math.max(0, config.max_daily_spins - todaySpins);

        // 是否可以游玩
        const canPlay = !banStatus.banned && (remainingSpins > 0 || freeSpins > 0) && quota >= config.min_quota_required;

        const resolveAbsoluteUrl = (path: string) => {
            const normalizedPath = path.startsWith('/') ? path : `/${path}`;
            const reqUrl = new URL(c.req.url);
            const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
            const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
            const proto = (forwardedProto || reqUrl.protocol.replace(':', '')).toLowerCase();
            const host = forwardedHost || c.req.header('host') || reqUrl.host;
            return `${proto}://${host}${normalizedPath}`;
        };

        const backgroundAssetUrl = config.background_type === 'gif'
            ? resolveAbsoluteUrl('/ctrl.gif')
            : null;

        // 获取奖励倍数配置
        const multipliers = getRewardMultipliers();

        // 获取今日已购买次数（使用同一个 today 变量）
        const todayBought = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, today);  // 🎯 使用同一个 today
        const boughtToday = todayBought?.total || 0;

        // 重新计算剩余次数（包含购买的次数）
        const actualRemainingSpins = Math.max(0, config.max_daily_spins + boughtToday - todaySpins);

        // 是否可以游玩（更新为包含购买次数的判断）
        const actualCanPlay = !banStatus.banned && (actualRemainingSpins > 0 || freeSpins > 0) && quota >= config.min_quota_required;

        return c.json({
            success: true,
            data: {
                config: {
                    bet_amount: config.bet_amount,
                    max_daily_spins: config.max_daily_spins,
                    min_quota_required: config.min_quota_required,
                    enabled: config.enabled,
                    background_type: config.background_type || 'default',
                    background_asset_url: backgroundAssetUrl,
                    multipliers: multipliers,  // 添加倍率配置
                    buy_spins_enabled: config.buy_spins_enabled || 0,  // 购买次数功能开关
                    buy_spins_price: config.buy_spins_price || 20000000,  // 购买价格
                    max_daily_buy_spins: config.max_daily_buy_spins || 5  // 每日最大购买次数
                },
                user: {
                    quota,
                    today_spins: todaySpins,
                    free_spins: freeSpins,
                    remaining_spins: actualRemainingSpins,  // 包含购买次数的剩余次数
                    can_play: actualCanPlay,
                    today_bet: todayStats.totalBet,
                    today_win: todayStats.totalWin,
                    today_count: todayStats.count,
                    // 历史总统计
                    total_spins: totalStats?.total_spins || 0,
                    total_bet: totalStats?.total_bet || 0,
                    total_win: totalStats?.total_win || 0,
                    // 禁止状态
                    is_banned: banStatus.banned,
                    banned_until: banStatus.bannedUntil,
                    // 购买次数
                    bought_today: boughtToday
                }
            }
        });
    } catch (error) {
        logger.error('老虎机配置', '获取老虎机配置失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 旋转老虎机
slot.post('/spin', requireAuth, createRateLimiter(RateLimits.SLOT_SPIN), async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const user = userQueries.get.get(session.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 🔥 检查坤呗逾期状态（确保用户玩游戏时及时扣款）
        try {
            const { checkOverdueLoans } = await import('../services/kunbei');
            await checkOverdueLoans();
        } catch (err: any) {
            logger.warn('坤呗检查', '坤呗逾期检查失败', err.message);
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
        const body = await c.req.json().catch(() => ({}));
        const useFreeSpinn = body.useFreeSpinn === true;
        const advancedBetAmount = body.advancedBetAmount || null;  // 🔥 高级场自定义投注金额

        // 🔥 检查是否在高级场
        const inAdvancedMode = isInAdvancedMode(session.linux_do_id);

        // 🔥 高级场需要检查律师函禁止状态
        if (inAdvancedMode) {
            const banStatus = isUserBanned(session.linux_do_id);
            if (banStatus.banned) {
                const remainingTime = banStatus.bannedUntil - Date.now();
                const remainingHours = Math.ceil(remainingTime / 3600000);
                return c.json({
                    success: false,
                    message: `⚡ 您因收到过多律师函，已被禁止使用高级场。解禁时间：${new Date(banStatus.bannedUntil).toLocaleString('zh-CN')}（剩余约${remainingHours}小时）。您可以继续使用初级场。`
                }, 403);
            }
        }

        let isFreeSpin = false;
        let betAmount = config.bet_amount;
        let calculationBetAmount = config.bet_amount; // 用于计算奖金的金额

        // 🔥 高级场使用自定义投注金额
        if (inAdvancedMode && advancedBetAmount) {
            const advancedConfig = getAdvancedSlotConfig();

            // 验证投注金额在范围内
            if (advancedBetAmount < advancedConfig.bet_min || advancedBetAmount > advancedConfig.bet_max) {
                return c.json({
                    success: false,
                    message: `投注金额必须在 $${(advancedConfig.bet_min / 500000).toFixed(0)} ~ $${(advancedConfig.bet_max / 500000).toFixed(0)} 之间`
                }, 400);
            }

            betAmount = advancedBetAmount;
            calculationBetAmount = advancedBetAmount;
            logger.info('高级场', `使用自定义投注金额: $${(advancedBetAmount / 500000).toFixed(2)}`);
        }

        if (useFreeSpinn) {
            logger.info('免费次数', `开始处理 - 用户: ${user.username} (${session.linux_do_id})`);

            // 直接尝试扣除免费次数（原子操作）
            const used = useUserFreeSpin(session.linux_do_id);
            logger.debug('免费次数', `扣除免费次数结果: ${used}`);

            if (!used) {
                // 扣除失败，重新查询当前免费次数
                const actualFreeSpins = getUserFreeSpins(session.linux_do_id);
                logger.error('免费次数', `扣除失败 - 用户: ${user.username}, 实际免费次数: ${actualFreeSpins}`);

                // 提供更详细的错误信息
                const errorMsg = actualFreeSpins > 0
                    ? `扣除免费次数失败，请重试（当前有${actualFreeSpins}次）`
                    : '没有免费次数';

                logger.error('免费次数', `返回错误: ${errorMsg}`);
                return c.json({
                    success: false,
                    message: errorMsg
                }, 400);
            }

            logger.info('免费次数', `✅ 用户 ${user.username} 成功使用1次免费机会`);
            isFreeSpin = true;
            betAmount = 0; // 免费游戏不扣费（用于记录）
            // calculationBetAmount 保持为 config.bet_amount（用于计算奖金）
        } else {
            // 🔥 初级场和高级场的限制检查
            if (inAdvancedMode) {
                // 🔥 高级场：检查每日投注限额（使用同一个 today 日期）
                const advancedConfig = getAdvancedSlotConfig();
                const today = getTodayDate();  // 🎯 获取今日日期
                const todayBetTotal = getUserTodayBet(session.linux_do_id, today);  // 🎯 传入日期
                const todayBetAmount = todayBetTotal / 500000;
                const newTodayBet = todayBetTotal + betAmount;
                const newTodayBetAmount = newTodayBet / 500000;

                logger.info('高级场检查', `用户: ${getUserDisplayName(session.linux_do_id)}, 今日已投注: $${todayBetAmount.toFixed(2)}, 本次投注: $${(betAmount / 500000).toFixed(2)}, 投注后总计: $${newTodayBetAmount.toFixed(2)}, 限额: $${(advancedConfig.daily_bet_limit / 500000).toFixed(2)}`);

                if (newTodayBet > advancedConfig.daily_bet_limit) {
                    const remaining = (advancedConfig.daily_bet_limit - todayBetTotal) / 500000;
                    return c.json({
                        success: false,
                        message: `超过每日投注限额！今日已投注 $${todayBetAmount.toFixed(2)}，限额 $${(advancedConfig.daily_bet_limit / 500000).toFixed(2)}（剩余 $${Math.max(0, remaining).toFixed(2)}）`
                    }, 400);
                }
            } else {
                // 🎯 初级场：检查今日次数（包含购买的次数，使用北京时间）
                const today = getTodayDate();
                const todayBought = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, today);
                const boughtToday = todayBought?.total || 0;

                const todaySpins = getUserTodaySpins(session.linux_do_id, today);  // 🎯 传入同一个 today
                const totalAllowedSpins = config.max_daily_spins + boughtToday;

                logger.debug('初级场检查', `用户: ${user.username}, 今日已玩: ${todaySpins}, 已购买: ${boughtToday}, 总允许: ${totalAllowedSpins}`);

                if (todaySpins >= totalAllowedSpins) {
                    return c.json({
                        success: false,
                        message: `今日游玩次数已用完（已玩${todaySpins}/${totalAllowedSpins}次）`
                    }, 400);
                }
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

            logger.info('老虎机', `准备扣除投注 - 用户: ${getUserDisplayName(session.linux_do_id)}, 当前: ${currentQuota}, 投注: ${betAmount}, 目标: ${newQuotaAfterBet}`);

            const deductResult = await updateKyxUserQuota(
                user.kyx_user_id,
                newQuotaAfterBet,
                adminConfig.session,
                adminConfig.new_api_user,
                user.username,
                kyxUserResult.user.group || 'default'
            );

            if (!deductResult || !deductResult.success) {
                logger.error('老虎机', `❌ 扣除投注失败 - 用户: ${getUserDisplayName(session.linux_do_id)}, 错误: ${deductResult?.message || '未知错误'}`);
                return c.json({
                    success: false,
                    message: `扣除投注额度失败: ${deductResult?.message || '未知错误'}，请稍后重试`
                }, 500);
            }

            logger.info('老虎机', `✅ 扣除投注成功 - 用户: ${getUserDisplayName(session.linux_do_id)}, 剩余: ${newQuotaAfterBet}`);
        }

        // 🔥 获取高级场配置（用于倍率）
        let rewardMultiplier = 1.0;
        let penaltyMultiplier = 1.0;
        if (inAdvancedMode) {
            const advancedConfig = getAdvancedSlotConfig();
            rewardMultiplier = advancedConfig.reward_multiplier;
            penaltyMultiplier = advancedConfig.penalty_weight_factor;
            logger.info('高级场', `用户 ${user.username} 在高级场游戏 - 投注: $${(betAmount / 500000).toFixed(2)}, 奖励倍率×${rewardMultiplier}, 惩罚倍率×${penaltyMultiplier}`);
        }

        // 生成随机符号（高级场使用独立权重配置）
        const symbols = generateSymbols(inAdvancedMode);

        // 🔥 使用配置方案进行中奖判定
        const { calculateWinByScheme } = await import('../services/reward-calculator');
        const slotConfig = inAdvancedMode
            ? advancedSlotQueries.getAdvancedConfig.get()
            : slotQueries.getConfig.get();
        const schemeId = slotConfig?.reward_scheme_id || 1;

        // 计算中奖结果（使用配置方案，高级场使用严格连续判定）
        const result = calculateWinByScheme(symbols, schemeId, inAdvancedMode);

        // ❌ 已移除场次倍率应用
        // 现在每个场次使用独立的奖励配置方案，不再基于初级场翻倍
        // if (inAdvancedMode) {
        //     if (result.multiplier > 0) {
        //         result.multiplier = result.multiplier * rewardMultiplier;
        //     } else if (result.multiplier < 0) {
        //         result.multiplier = result.multiplier * penaltyMultiplier;
        //     }
        // }

        // 🔥 检查并应用坤呗buff（只对正向中奖生效，不放大惩罚）
        const kunbeiBuff = getAndUseBuff(session.linux_do_id);
        if (kunbeiBuff > 1 && result.multiplier > 0) {
            logger.info('坤呗Buff', `应用buff×${kunbeiBuff}，原倍率: ${result.multiplier}，新倍率: ${result.multiplier * kunbeiBuff}`);
            result.multiplier = result.multiplier * kunbeiBuff;
        }

        // 🔥 检查是否需要封禁（3个及以上律师函）
        const shouldBan = result.punishmentCount && result.punishmentCount >= 3;
        if (shouldBan && result.banHours) {
            // 🔥 修复：传递小时数而不是时间戳，并记录场次类型
            const slotMode = inAdvancedMode ? 'advanced' : 'normal';
            banUserFromSlot(session.linux_do_id, result.banHours, slotMode);
            logger.info('老虎机', `🚫 严重惩罚 - 用户: ${user.username}, 在【${slotMode === 'normal' ? '初级场' : '高级场'}】禁止抽奖${result.banHours}小时`);
        }

        // 获取管理员配置（用于更新额度）
        const adminConfigForWin = adminQueries.get.get();
        if (!adminConfigForWin) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 处理中奖或惩罚金额
        let winAmount = 0;
        let quotaUpdateFailed = false;
        let quotaUpdateError = '';

        if (result.multiplier > 0) {
            // 正常中奖 - 使用 calculationBetAmount 计算奖金
            winAmount = Math.floor(calculationBetAmount * result.multiplier);

            logger.info('老虎机', `💰 中奖 - 用户: ${getUserDisplayName(session.linux_do_id)}, 类型: ${result.ruleName || WIN_TYPE_NAMES[result.winType] || result.winType}, 奖金: $${(winAmount / 500000).toFixed(2)}`);

            // 增加额度
            const currentKyxUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
            if (!currentKyxUser.success || !currentKyxUser.user) {
                logger.error('老虎机', `❌ 中奖后获取用户信息失败 - 用户: ${getUserDisplayName(session.linux_do_id)}`);
                quotaUpdateFailed = true;
                quotaUpdateError = '获取用户信息失败，请联系管理员补发奖金';
            } else {
                const quotaBeforeWin = currentKyxUser.user.quota;
                const newQuotaAfterWin = quotaBeforeWin + winAmount;

                logger.debug('老虎机', `准备添加额度 - 当前: ${quotaBeforeWin}, 奖金: ${winAmount}, 目标: ${newQuotaAfterWin}`);

                const updateResult = await updateKyxUserQuota(
                    user.kyx_user_id,
                    newQuotaAfterWin,
                    adminConfigForWin.session,
                    adminConfigForWin.new_api_user,
                    user.username,
                    currentKyxUser.user.group || 'default'
                );

                // 【关键】检查更新结果
                if (!updateResult || !updateResult.success) {
                    logger.error('老虎机', `❌ 添加额度失败 - 用户: ${user.username}, 奖金: $${(winAmount / 500000).toFixed(2)}, 错误: ${updateResult?.message || '未知错误'}`);
                    quotaUpdateFailed = true;

                    // 记录到待发放表，系统会自动重试
                    try {
                        const now = Date.now();
                        pendingRewardQueries.insert.run(
                            session.linux_do_id,
                            user.kyx_user_id,
                            user.username,
                            winAmount,
                            `老虎机中奖 - ${result.ruleName || WIN_TYPE_NAMES[result.winType] || result.winType} ${result.multiplier}倍`,
                            'pending',
                            0,
                            now,
                            now
                        );
                        logger.info('老虎机', `📝 已记录到待发放表 - 用户: ${user.username}, 金额: $${(winAmount / 500000).toFixed(2)}`);
                        quotaUpdateError = '奖金已记录，系统会自动发放到您的账户';
                    } catch (dbError) {
                        logger.error('老虎机', `❌ 记录待发放失败`, dbError);
                        quotaUpdateError = '额度添加失败，请联系管理员补发奖金';
                    }
                } else {
                    // 验证额度是否真的更新了
                    const verifyUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
                    if (verifyUser.success && verifyUser.user) {
                        const actualQuota = verifyUser.user.quota;
                        logger.debug('老虎机', `✅ 验证额度 - 期望: ${newQuotaAfterWin}, 实际: ${actualQuota}`);

                        // 允许小范围误差（可能有其他操作）
                        if (Math.abs(actualQuota - newQuotaAfterWin) > winAmount) {
                            logger.error('老虎机', `⚠️ 额度验证异常 - 期望: ${newQuotaAfterWin}, 实际: ${actualQuota}, 差异过大`);
                            quotaUpdateFailed = true;

                            // 记录到待发放表，系统会自动重试
                            try {
                                const now = Date.now();
                                pendingRewardQueries.insert.run(
                                    session.linux_do_id,
                                    user.kyx_user_id,
                                    user.username,
                                    winAmount,
                                    `老虎机中奖 - ${result.ruleName || WIN_TYPE_NAMES[result.winType] || result.winType} ${result.multiplier}倍 (验证失败)`,
                                    'pending',
                                    0,
                                    now,
                                    now
                                );
                                logger.info('老虎机', `📝 已记录到待发放表 - 用户: ${user.username}, 金额: $${(winAmount / 500000).toFixed(2)}`);
                                quotaUpdateError = '奖金已记录，系统会自动发放到您的账户';
                            } catch (dbError) {
                                logger.error('老虎机', `❌ 记录待发放失败`, dbError);
                                quotaUpdateError = '额度验证失败，请联系管理员';
                            }
                        }
                    }
                }
            }
        } else if (result.multiplier < 0) {
            // 惩罚扣除（负倍率）- 使用 calculationBetAmount 计算惩罚金额
            const punishmentAmount = Math.floor(calculationBetAmount * Math.abs(result.multiplier));

            // 获取当前额度
            const currentKyxUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
            if (!currentKyxUser.success || !currentKyxUser.user) {
                logger.error('老虎机', `❌ 惩罚时获取用户信息失败 - 用户: ${user.username}`);
                // 惩罚失败不阻止游戏继续
            } else {
                // 计算扣除后的额度，确保不会为负数
                const currentQuota = currentKyxUser.user.quota;
                const actualDeduction = Math.min(punishmentAmount, currentQuota);  // 最多扣到0
                const newQuotaAfterPunishment = currentQuota - actualDeduction;

                logger.debug('老虎机', `⚡ 准备扣除惩罚 - 当前: ${currentQuota}, 惩罚: ${actualDeduction}, 目标: ${newQuotaAfterPunishment}`);

                const updateResult = await updateKyxUserQuota(
                    user.kyx_user_id,
                    newQuotaAfterPunishment,
                    adminConfigForWin.session,
                    adminConfigForWin.new_api_user,
                    user.username,
                    currentKyxUser.user.group || 'default'
                );

                // 检查惩罚扣除结果
                if (!updateResult || !updateResult.success) {
                    logger.error('老虎机', `❌ 惩罚扣除失败 - 用户: ${user.username}, 应扣: $${(actualDeduction / 500000).toFixed(2)}, 错误: ${updateResult?.message || '未知错误'}`);
                    // 惩罚失败，记录为0
                    winAmount = 0;
                } else {
                    // winAmount 设为负数，用于记录
                    winAmount = -actualDeduction;
                    logger.info('老虎机', `⚡ 惩罚成功 - 用户: ${user.username}, 律师函数量: ${result.punishmentCount}, 扣除: $${(actualDeduction / 500000).toFixed(2)}`);
                }
            }

            // 🔥 封禁逻辑已移至上方（第472-476行），使用配置的 banHours，此处删除硬编码的60小时
        }

        // 如果奖励免费次数
        if (result.freeSpinAwarded) {
            addUserFreeSpins(session.linux_do_id, 1);
        }

        // 🔥 保存游戏记录（记录 winType，兼容配置方案）
        // 优先使用session中的LinuxDo用户名（最新），其次使用数据库中的
        const linuxDoUsername = session.username || user.linux_do_username || null;

        logger.info('中奖判定', `符号: ${symbols.join(',')}, 规则: ${result.ruleName || result.winType}, 倍率: ${result.multiplier}`);

        saveGameRecord(
            session.linux_do_id,
            user.username,
            linuxDoUsername,
            betAmount,
            symbols,
            result.winType as any,  // 使用配置方案返回的 winType
            result.multiplier,
            winAmount,
            result.freeSpinAwarded,
            isFreeSpin,
            inAdvancedMode ? 'advanced' : 'normal',  // 🔥 传入场次模式
            result.ruleName || result.winType  // 🔥 传入规则名称（用于显示）
        );

        // 更新用户总统计（用于排行榜）
        // 优先使用session中的LinuxDo用户名（最新），其次使用数据库中的，最后使用公益站用户名
        const displayUsername = session.username || user.linux_do_username || user.username;
        updateUserTotalStats(
            session.linux_do_id,
            displayUsername,
            session.avatar_url || '',
            betAmount,
            winAmount,
            result.winType
        );

        // 🏆 排名成就检查（每次游戏后检查）
        try {
            await checkAndUnlockAchievement(session.linux_do_id, 'rank_top10');
            await checkAndUnlockAchievement(session.linux_do_id, 'rank_top3');
            await checkAndUnlockAchievement(session.linux_do_id, 'rank_1_profit');
            await checkAndUnlockAchievement(session.linux_do_id, 'rank_1_loss');
        } catch (rankError) {
            // 排名检查失败不影响游戏
        }

        // ========== 高级场掉落逻辑 ==========
        let ticketDropped = false;
        let dropType: 'ticket' | 'fragment' | null = null;
        let dropCount = 0;

        // 🔥 使用新的掉落配置系统
        const { handleDrops } = await import('../services/drop-config');
        const slotMode = inAdvancedMode ? 'advanced' : 'normal';
        const dropResult = await handleDrops(session.linux_do_id, user.username, slotMode, result.ruleName);

        if (dropResult.dropped) {
            ticketDropped = true;
            // 记录第一个成功掉落的物品（用于提示）
            const firstDrop = dropResult.items.find(item => item.triggered);
            if (firstDrop) {
                dropType = firstDrop.type;
                dropCount = firstDrop.count;
            }
        }

        // ❌ 旧的硬编码掉落逻辑已被上面的新系统替代
        // 保留注释以供参考
        // if (!inAdvancedMode) {
        //     if (result.winType === WinType.QUAD && Math.random() < advancedConfig.drop_rate_triple) {
        //         addTicket(session.linux_do_id, 1);
        //     }
        // }

        // 高级场中掉落至尊令牌/碎片（现在也由新系统处理）
        else if (inAdvancedMode) {
            const advancedConfig = getAdvancedSlotConfig();

            // 极低概率直接掉落至尊令牌
            if (advancedConfig.supreme_token_drop_rate && Math.random() < advancedConfig.supreme_token_drop_rate) {
                // TODO: 需要实现 addSupremeToken 函数
                // addSupremeToken(session.linux_do_id, 1);
                recordSupremeDrop(session.linux_do_id, user.username, 'token', 1, 'advanced_slot', result.winType);
                ticketDropped = true;
                dropType = 'supreme_token' as any;
                dropCount = 1;
                logger.info('至尊掉落', `💎 稀有掉落！用户 ${user.username} 获得1个至尊令牌`);
            }
            // 低概率掉落至尊碎片（四连/三连）
            else if ((result.winType === WinType.QUAD || result.winType === WinType.TRIPLE) &&
                advancedConfig.supreme_fragment_drop_rate &&
                Math.random() < advancedConfig.supreme_fragment_drop_rate) {
                addSupremeFragment(session.linux_do_id, 1);
                recordSupremeDrop(session.linux_do_id, user.username, 'fragment', 1, 'advanced_slot', result.winType);
                ticketDropped = true;
                dropType = 'supreme_fragment' as any;
                dropCount = 1;
                logger.info('至尊掉落', `🧩 用户 ${user.username} 获得1个至尊碎片`);
            }
        }

        // 获取更新后的状态
        const kyxUserAfterResult = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
        const quotaAfter = (kyxUserAfterResult.success && kyxUserAfterResult.user) ? kyxUserAfterResult.user.quota : 0;

        // 🎯 关键修复：获取今日已购买次数（使用北京时间，确保与抽奖检查时使用同一日期）
        const todayForSpinResult = getTodayDate();
        const todayBoughtAfter = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, todayForSpinResult);
        const boughtTodayAfter = todayBoughtAfter?.total || 0;

        const todaySpinsAfter = getUserTodaySpins(session.linux_do_id, todayForSpinResult);  // 🎯 传入同一个日期
        const freeSpinsAfter = getUserFreeSpins(session.linux_do_id);

        // 🎯 关键修复：计算剩余次数时必须包含购买次数！
        const remainingSpinsAfter = Math.max(0, config.max_daily_spins + boughtTodayAfter - todaySpinsAfter);

        logger.debug('Spin结果', `📊 剩余次数计算 - 用户: ${user.username}, 基础: ${config.max_daily_spins}, 购买: ${boughtTodayAfter}, 已玩: ${todaySpinsAfter}, 剩余: ${remainingSpinsAfter}`);

        // 构造响应消息
        let message = '';

        if (result.winType === WinType.PUNISHMENT) {
            // 惩罚消息
            const deductedAmount = Math.abs(winAmount);
            message = `⚡ 律师函警告！收到 ${result.punishmentCount} 份律师函，扣除 $${(deductedAmount / 500000).toFixed(2)} 额度`;
            // 🔥 使用配置的封禁时长，不硬编码
            if (result.banHours && result.banHours > 0) {
                const days = (result.banHours / 24).toFixed(1);
                message += ` | 🚫 已被禁止抽奖${result.banHours}小时（${days}天）`;
            }
        } else {
            // 正常中奖消息 - 使用规则名称而不是固定映射
            message = result.ruleName || WIN_TYPE_NAMES[result.winType] || '未知';
            if (result.multiplier > 0) {
                message += ` ${result.multiplier}倍！赢得 $${(winAmount / 500000).toFixed(2)}`;

                // 【关键】如果额度更新失败，明确告知用户
                if (quotaUpdateFailed) {
                    message += ` | ⚠️ ${quotaUpdateError}`;
                }
            }
            if (result.freeSpinAwarded) {
                message += ' | 🎁 获得1次免费机会！';
            }
            // 添加掉落消息
            if (ticketDropped) {
                if (dropType === 'ticket') {
                    message += ' | 🎟️ 获得入场券×1！';
                } else if (dropType === 'fragment') {
                    message += ' | 🧩 获得碎片×1！';
                }
            }
        }

        // 🔥 如果使用了坤呗buff，添加提示
        if (kunbeiBuff > 1 && result.multiplier > 0) {
            message += ' | 🐔 坤呗buff已生效！';
        }

        // 获取最新的入场券信息
        const ticketsInfo = getUserTickets(session.linux_do_id);

        // ========== 成就系统检查 ==========
        // 🏆 收集本次解锁的成就
        const unlockedAchievements: any[] = [];

        try {
            // 1. 首次游戏成就
            const result1 = await checkAndUnlockAchievement(session.linux_do_id, 'first_game');
            if (result1.unlocked && result1.achievement) {
                unlockedAchievements.push(result1.achievement);
            }

            // 🔥 2. 游玩次数成就（并发检查，避免深度调用链）
            const playProgressResults = await Promise.allSettled([
                updateAchievementProgress(session.linux_do_id, 'play_10_games', 1),
                updateAchievementProgress(session.linux_do_id, 'play_50_games', 1),
                updateAchievementProgress(session.linux_do_id, 'play_200_games', 1),
                updateAchievementProgress(session.linux_do_id, 'play_1000_games', 1)
            ]);

            // 收集解锁的成就
            playProgressResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value.unlocked && result.value.achievement) {
                    unlockedAchievements.push(result.value.achievement);
                }
            });

            // 3. 中奖相关成就
            if (result.winType !== 'none' && result.winType !== WinType.PUNISHMENT && result.multiplier > 0) {
                // 首次中奖
                const result2 = await checkAndUnlockAchievement(session.linux_do_id, 'first_win');
                if (result2.unlocked && result2.achievement) {
                    unlockedAchievements.push(result2.achievement);
                }

                // 🔥 中奖次数成就（并发检查）
                const winProgressResults = await Promise.allSettled([
                    updateAchievementProgress(session.linux_do_id, 'win_10_times', 1),
                    updateAchievementProgress(session.linux_do_id, 'win_50_times', 1),
                    updateAchievementProgress(session.linux_do_id, 'win_100_times', 1)
                ]);

                // 收集解锁的成就
                winProgressResults.forEach(result => {
                    if (result.status === 'fulfilled' && result.value.unlocked && result.value.achievement) {
                        unlockedAchievements.push(result.value.achievement);
                    }
                });

                // 🔥 连击计数器（连续中奖）
                const streakResult = userQueries.getWinStreak.get(session.linux_do_id);
                const currentStreak = (streakResult?.win_streak || 0) + 1;
                userQueries.updateWinStreak.run(currentStreak, session.linux_do_id);

                // 连续中奖成就
                if (currentStreak >= 3) {
                    const result3 = await checkAndUnlockAchievement(session.linux_do_id, 'combo_3_wins');
                    if (result3.unlocked && result3.achievement) {
                        unlockedAchievements.push(result3.achievement);
                    }
                }
                if (currentStreak >= 5) {
                    const result4 = await checkAndUnlockAchievement(session.linux_do_id, 'combo_5_wins');
                    if (result4.unlocked && result4.achievement) {
                        unlockedAchievements.push(result4.achievement);
                    }
                }

                // 4. 中奖类型成就（双连、三连、四连等）
                if (result.winType === WinType.DOUBLE) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'double_win');
                } else if (result.winType === WinType.TRIPLE) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'triple_win');
                } else if (result.winType === WinType.QUAD) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'quad_win');
                } else if (result.winType === 'special_combo' || result.ruleName?.includes('特殊')) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'special_combo_win');
                } else if (result.winType === 'super_jackpot' || result.multiplier >= 256) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'super_jackpot_win');
                }

                // 5. 单次大额中奖成就（单次中奖超过 5000 quota）
                if (winAmount >= 2500000) { // 5000 * 500000 = 2500000
                    await checkAndUnlockAchievement(session.linux_do_id, 'single_win_5k');
                }
            } else {
                // 未中奖，重置连击计数器
                userQueries.updateWinStreak.run(0, session.linux_do_id);
            }

            // 6. 律师函相关成就
            const lshCount = symbols.filter((s: string) => s === 'lsh').length;
            if (lshCount > 0) {
                // 首次收到律师函
                await checkAndUnlockAchievement(session.linux_do_id, 'first_lsh');

                // 律师函数量累计
                await updateAchievementProgress(session.linux_do_id, 'lsh_10_times', lshCount);

                // 单次4个律师函
                if (lshCount === 4) {
                    await checkAndUnlockAchievement(session.linux_do_id, 'lsh_quad');
                }
            }

            // 🔥 6.5. Man符号相关成就
            const manCount = symbols.filter((s: string) => s === 'man').length;
            if (manCount > 0) {
                // 累计抽到25个Man符号
                const manProgress = await updateAchievementProgress(session.linux_do_id, 'man_25_times', manCount);
                if (manProgress.unlocked && manProgress.achievement) {
                    unlockedAchievements.push(manProgress.achievement);
                }
            }

            // 🔥 6.6. 偶像练习生成就（按顺序抽到 BJ→ZFT→BDK→LQ）
            if (symbols.length === 4 &&
                symbols[0] === 'bj' &&
                symbols[1] === 'zft' &&
                symbols[2] === 'bdk' &&
                symbols[3] === 'lq') {
                const idolResult = await checkAndUnlockAchievement(session.linux_do_id, 'idol_trainee');
                if (idolResult.unlocked && idolResult.achievement) {
                    unlockedAchievements.push(idolResult.achievement);
                }
            }

            // 7. 禁赛成就（被禁止抽奖）
            if (result.shouldBan || shouldBan) {
                await checkAndUnlockAchievement(session.linux_do_id, 'first_ban');
            }

            // 🔥 8. 免费游戏成就（收集解锁信息）
            if (result.freeSpinAwarded) {
                const freeGameProgress = await updateAchievementProgress(session.linux_do_id, 'free_game_10', 1);
                if (freeGameProgress.unlocked && freeGameProgress.achievement) {
                    unlockedAchievements.push(freeGameProgress.achievement);
                }
            }

            // 9. 高级场梭哈大师成就（高级场单次下注5k+）
            if (inAdvancedMode && betAmount >= 2500000) { // 5000 * 500000 = 2500000
                await checkAndUnlockAchievement(session.linux_do_id, 'bet_5k_advanced');
            }

            // 10. 财富成就 - 余额达标（余额达到50k）
            if (quotaAfter >= 25000000) { // 50000 * 500000 = 25000000
                await checkAndUnlockAchievement(session.linux_do_id, 'balance_50k');
            }

            // 11. 财富成就 - 累计盈利（从用户总统计获取）
            const userTotalStats = getUserTotalStats(session.linux_do_id);
            if (userTotalStats) {
                const totalProfit = userTotalStats.total_win - userTotalStats.total_bet;

                // 累计盈利10k
                if (totalProfit >= 5000000) { // 10000 * 500000 = 5000000
                    await checkAndUnlockAchievement(session.linux_do_id, 'earn_10k');
                }
                // 累计盈利100k
                if (totalProfit >= 50000000) { // 100000 * 500000 = 50000000
                    await checkAndUnlockAchievement(session.linux_do_id, 'earn_100k');
                }
                // 累计盈利1m
                if (totalProfit >= 500000000) { // 1000000 * 500000 = 500000000
                    await checkAndUnlockAchievement(session.linux_do_id, 'earn_1m');
                }
            }

            // 12. 挑战成就 - 单日盈利（从今日统计获取）
            const todayStats = getUserTodayStats(session.linux_do_id);
            if (todayStats) {
                const todayProfit = todayStats.total_win - todayStats.total_bet;

                // 单日盈利10k+
                if (todayProfit >= 5000000) { // 10000 * 500000 = 5000000
                    await checkAndUnlockAchievement(session.linux_do_id, 'daily_profit_10k');
                }
            }

            // 13. 收藏成就 - 符号收集者（收集所有9种符号）
            // TODO: 需要实现符号收集追踪逻辑，暂时禁用
            // await checkAndUnlockAchievement(session.linux_do_id, 'symbol_collector');

            // 14. 收藏成就 - 组合大师（获得5种不同中奖类型）
            // 检查用户是否获得了多种中奖类型
            const userRecords = getUserRecords(session.linux_do_id);
            const uniqueWinTypes = new Set(
                userRecords
                    .filter((r: any) => r.win_type !== 'none' && r.win_type !== 'punishment')
                    .map((r: any) => r.win_type)
            );
            if (uniqueWinTypes.size >= 5) {
                await checkAndUnlockAchievement(session.linux_do_id, 'combo_master');
            }

            // 15. 符号收集者成就 - 记录本次抽到的符号
            await recordSymbols(session.linux_do_id, symbols);

            // 16. 逆风翻盘成就 - 更新盈利追踪
            if (userTotalStats) {
                const currentProfit = userTotalStats.total_win - userTotalStats.total_bet;
                await updateProfitTracking(session.linux_do_id, currentProfit);
            }

        } catch (achievementError) {
            // 成就系统错误不应该影响游戏正常进行，只记录日志
            logger.error('成就系统', '检查成就时出错', achievementError);
        }
        // ========== 成就系统检查结束 ==========

        return c.json({
            success: true,
            data: {
                symbols,
                win_type: result.winType,
                win_type_name: result.ruleName || WIN_TYPE_NAMES[result.winType] || '未知',
                multiplier: result.multiplier,
                bet_amount: betAmount,
                win_amount: winAmount,
                free_spin_awarded: result.freeSpinAwarded,
                quota_after: quotaAfter,
                spins_remaining: remainingSpinsAfter,
                free_spins_remaining: freeSpinsAfter,
                quota_update_failed: quotaUpdateFailed,  // 标记额度更新是否失败
                // 高级场掉落信息
                ticket_dropped: ticketDropped,
                drop_type: dropType,
                drop_count: dropCount,
                tickets: ticketsInfo.tickets,
                fragments: ticketsInfo.fragments,
                // 🏆 本次解锁的成就列表
                unlocked_achievements: unlockedAchievements
            },
            message,
            warning: quotaUpdateFailed ? quotaUpdateError : undefined  // 警告信息
        });
    } catch (error) {
        logger.error('老虎机', '旋转老虎机失败', error);
        if (error instanceof Error && error.stack) {
            logger.error('老虎机', '错误堆栈', error.stack);
        }
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        return c.json({
            success: false,
            message: `服务器错误: ${errorMessage}`
        }, 500);
    }
});

// 获取游戏记录
slot.get('/records', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        // 获取查询参数
        const { mode } = c.req.query();

        let records;
        if (mode === 'supreme') {
            // 🔥 获取至尊场记录
            const { supremeSlotQueries } = await import('../database');
            records = supremeSlotQueries.getRecordsByUser.all(session.linux_do_id);
            
            // 解析符号 JSON 并格式化至尊场记录
            const formattedRecords = records.map((r: any) => ({
                ...r,
                result_symbols: JSON.parse(r.result_symbols),
                win_type_name: r.rule_name || WIN_TYPE_NAMES[r.win_type as WinType] || r.win_type,
                slot_mode: 'supreme'  // 标记为至尊场
            }));

            return c.json({
                success: true,
                data: formattedRecords
            });
        } else if (mode === 'normal' || mode === 'advanced') {
            // 按场次获取记录
            records = getUserRecordsByMode(session.linux_do_id, mode);
        } else if (mode === 'all') {
            // 🔥 获取所有场次的记录（包括至尊场）
            const normalAdvancedRecords = getUserRecords(session.linux_do_id);
            const { supremeSlotQueries } = await import('../database');
            const supremeRecords = supremeSlotQueries.getRecordsByUser.all(session.linux_do_id);
            
            // 合并记录并标记场次
            const allRecords = [
                ...normalAdvancedRecords.map((r: any) => ({
                    ...r,
                    result_symbols: JSON.parse(r.result_symbols),
                    win_type_name: r.rule_name || WIN_TYPE_NAMES[r.win_type as WinType] || r.win_type
                })),
                ...supremeRecords.map((r: any) => ({
                    ...r,
                    result_symbols: JSON.parse(r.result_symbols),
                    win_type_name: r.rule_name || WIN_TYPE_NAMES[r.win_type as WinType] || r.win_type,
                    slot_mode: 'supreme'
                }))
            ];
            
            // 按时间戳降序排序
            allRecords.sort((a, b) => b.timestamp - a.timestamp);
            
            return c.json({
                success: true,
                data: allRecords
            });
        } else {
            // 获取所有记录（兼容旧版，只包含普通场和高级场）
            records = getUserRecords(session.linux_do_id);
        }

        // 解析符号 JSON
        const formattedRecords = records.map(r => ({
            ...r,
            result_symbols: JSON.parse(r.result_symbols),
            win_type_name: r.rule_name || WIN_TYPE_NAMES[r.win_type as WinType] || r.win_type
        }));

        return c.json({
            success: true,
            data: formattedRecords
        });
    } catch (error) {
        logger.error('游戏记录', '获取游戏记录失败', error);
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
        logger.error('今日统计', '获取今日统计失败', error);
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
        const leaderboard = getLeaderboard(20); // 盈利榜也取20名（侧边栏）
        const lossLeaderboard = getLossLeaderboard(20); // 亏损榜取20名

        // 调试：检查排行榜数据（DEBUG级别，默认不显示）
        logger.debug('盈利榜', `前3名数据: ${JSON.stringify(leaderboard.slice(0, 3).map(u => ({
            username: u.username,
            profit: (u.total_win - u.total_bet) / 500000
        })))}`);
        logger.debug('亏损榜', `前3名数据: ${JSON.stringify(lossLeaderboard.slice(0, 3).map(u => ({
            username: u.username,
            profit: (u.total_win - u.total_bet) / 500000
        })))}`);

        // 获取用户自己的排名和统计
        const userStats = getUserTotalStats(session.linux_do_id);
        const userRank = getUserRank(session.linux_do_id);
        const userLossRank = getUserLossRank(session.linux_do_id);

        return c.json({
            success: true,
            data: {
                leaderboard,
                lossLeaderboard,
                userStats: userStats || {
                    linux_do_id: session.linux_do_id,
                    total_spins: 0,
                    total_bet: 0,
                    total_win: 0,
                    biggest_win: 0,
                    biggest_win_type: null
                },
                userRank,
                userLossRank
            }
        });
    } catch (error) {
        logger.error('排行榜', '获取排行榜失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 用户申请补发待发放奖金
 */
slot.post('/pending-rewards/:id/retry', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const rewardId = parseInt(c.req.param('id'));

        // 获取待发放记录
        const reward = pendingRewardQueries.getById.get(rewardId);
        if (!reward) {
            return c.json({ success: false, message: '记录不存在' }, 404);
        }

        // 验证记录真实性：确保是该用户的记录
        if (reward.linux_do_id !== session.linux_do_id) {
            logger.error('申请补发', `❌ 用户尝试申请他人记录 - 用户: ${session.linux_do_id}, 记录所属: ${reward.linux_do_id}`);
            return c.json({ success: false, message: '无权操作此记录' }, 403);
        }

        // 只允许失败状态的记录申请补发
        if (reward.status === 'success') {
            return c.json({ success: false, message: '该记录已成功发放' }, 400);
        }

        if (reward.status === 'processing') {
            return c.json({ success: false, message: '该记录正在处理中，请稍后刷新查看结果' }, 400);
        }

        logger.info('申请补发', `🎁 用户申请补发 - 用户: ${session.username || session.linux_do_id}, 记录ID: ${rewardId}, 金额: $${(reward.reward_amount / 500000).toFixed(2)}`);

        // 标记为处理中
        const now = Date.now();
        pendingRewardQueries.updateStatus.run('processing', now, null, rewardId);

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            pendingRewardQueries.updateStatus.run('failed', now, '系统配置未找到', rewardId);
            return c.json({
                success: false,
                message: '系统配置错误，请联系管理员',
                details: '管理员配置未初始化'
            }, 500);
        }

        try {
            // 获取用户当前额度
            const userResult = await getKyxUserById(
                reward.kyx_user_id,
                adminConfig.session,
                adminConfig.new_api_user,
                3,
                true // 跳过缓存，获取最新数据
            );

            if (!userResult.success || !userResult.user) {
                const errorMsg = `获取用户信息失败: ${userResult.message || '未知错误'}`;
                pendingRewardQueries.incrementRetry.run('failed', errorMsg, now, rewardId);
                logger.error('申请补发', `❌ ${errorMsg}`);
                return c.json({
                    success: false,
                    message: '系统繁忙，请联系管理员',
                    details: errorMsg
                }, 500);
            }

            const currentQuota = userResult.user.quota;
            const newQuota = currentQuota + reward.reward_amount;

            logger.debug('申请补发', `当前额度: ${currentQuota}, 奖金: ${reward.reward_amount}, 目标额度: ${newQuota}`);

            // 更新额度
            const updateResult = await updateKyxUserQuota(
                reward.kyx_user_id,
                newQuota,
                adminConfig.session,
                adminConfig.new_api_user,
                reward.username,
                userResult.user.group || 'default',
                3
            );

            if (!updateResult || !updateResult.success) {
                const errorMsg = `额度更新失败: ${updateResult?.message || '未知错误'}`;
                const httpStatus = updateResult?.httpStatus;

                // 记录详细错误信息
                let userFriendlyMsg = '系统繁忙，请联系管理员';
                if (httpStatus === 429) {
                    userFriendlyMsg = 'API请求过于频繁，请5分钟后再试';
                    pendingRewardQueries.updateStatus.run('pending', now, 'API限流，请稍后重试', rewardId);
                } else {
                    pendingRewardQueries.incrementRetry.run('failed', errorMsg, now, rewardId);
                }

                logger.error('申请补发', `❌ ${errorMsg}, HTTP状态: ${httpStatus}`);
                return c.json({
                    success: false,
                    message: userFriendlyMsg,
                    details: errorMsg,
                    httpStatus
                }, httpStatus === 429 ? 429 : 500);
            }

            // 验证额度是否真的更新了
            const verifyResult = await getKyxUserById(
                reward.kyx_user_id,
                adminConfig.session,
                adminConfig.new_api_user,
                3,
                true
            );

            if (verifyResult.success && verifyResult.user) {
                const actualQuota = verifyResult.user.quota;
                logger.debug('申请补发', `验证额度 - 期望: ${newQuota}, 实际: ${actualQuota}`);

                // 允许小范围误差
                if (Math.abs(actualQuota - newQuota) > reward.reward_amount) {
                    const errorMsg = `额度验证失败 - 期望: ${newQuota}, 实际: ${actualQuota}`;
                    pendingRewardQueries.incrementRetry.run('failed', errorMsg, now, rewardId);
                    logger.error('申请补发', `⚠️ ${errorMsg}`);
                    return c.json({
                        success: false,
                        message: '系统繁忙，请联系管理员',
                        details: errorMsg
                    }, 500);
                }
            }

            // 标记为成功
            pendingRewardQueries.markSuccess.run('success', now, now, rewardId);
            logger.info('申请补发', `✅ 发放成功 - 用户: ${reward.username}, 金额: $${(reward.reward_amount / 500000).toFixed(2)}`);

            return c.json({
                success: true,
                message: `补发成功！$${(reward.reward_amount / 500000).toFixed(2)} 已到账`,
                data: {
                    old_quota: currentQuota,
                    new_quota: newQuota,
                    reward_amount: reward.reward_amount
                }
            });

        } catch (error: any) {
            const errorMsg = error.message || '未知错误';
            logger.error('申请补发', `❌ 处理失败`, error);
            pendingRewardQueries.incrementRetry.run('failed', errorMsg, now, rewardId);

            return c.json({
                success: false,
                message: '系统繁忙，请联系管理员',
                details: errorMsg
            }, 500);
        }

    } catch (error: any) {
        logger.error('申请补发', `❌ 服务器错误`, error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// 获取用户的待发放奖金
slot.get('/pending-rewards', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        // 获取用户的待发放奖金列表
        const pendingRewards = pendingRewardQueries.getByUser.all(session.linux_do_id);

        // 获取汇总信息
        const summary = pendingRewardQueries.getUserPendingSummary.get(session.linux_do_id);

        // 格式化数据
        const formattedRewards = pendingRewards.map((reward: any) => ({
            id: reward.id,
            amount: reward.reward_amount,
            reason: reward.reason,
            status: reward.status,
            retry_count: reward.retry_count,
            error_message: reward.error_message,
            created_at: reward.created_at,
            updated_at: reward.updated_at,
            processed_at: reward.processed_at
        }));

        // 计算待发放和已成功的统计
        const filteredPendingRewards = formattedRewards.filter((r: any) =>
            r.status === 'pending' || r.status === 'processing' || r.status === 'failed'
        );
        const successRewards = formattedRewards.filter((r: any) => r.status === 'success');

        const pendingAmount = filteredPendingRewards.reduce((sum: number, r: any) => sum + r.amount, 0);
        const successAmount = successRewards.reduce((sum: number, r: any) => sum + r.amount, 0);

        // 格式化显示日期
        const formattedWithDates = formattedRewards.map((r: any) => ({
            ...r,
            amount: r.amount / 500000,  // 转换为美元
            created_date: new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }),
            updated_date: new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false }),
        }));

        return c.json({
            success: true,
            data: {
                summary: {
                    pending_count: filteredPendingRewards.length,
                    pending_amount: pendingAmount,
                    success_count: successRewards.length,
                    success_amount: successAmount,
                    total_count: formattedRewards.length
                },
                rewards: formattedWithDates
            }
        });
    } catch (error) {
        logger.error('待发放奖金', '获取待发放奖金失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 购买抽奖次数（支持批量购买）
 */
slot.post('/buy-spins', requireAuth, createRateLimiter(RateLimits.PURCHASE), async (c) => {
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

        // 获取老虎机配置
        const config = getSlotConfig();
        if (!config) {
            return c.json({ success: false, message: '老虎机配置未找到' }, 500);
        }

        // 检查购买功能是否开启
        if (!config.buy_spins_enabled) {
            return c.json({ success: false, message: '购买抽奖次数功能未开启' }, 403);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 检查用户额度
        const kyxUserResult = await getKyxUserById(user.kyx_user_id, adminConfig.session, adminConfig.new_api_user);
        if (!kyxUserResult.success || !kyxUserResult.user) {
            return c.json({ success: false, message: '获取额度失败' }, 500);
        }

        const currentQuota = kyxUserResult.user.quota;

        // 🔥 支持批量购买：从请求体获取购买数量
        const body = await c.req.json().catch(() => ({}));
        const requestedCount = parseInt(body.count) || 1;

        logger.debug('购买次数', `用户请求购买 - 用户: ${user.username}, 请求数量: ${requestedCount}, 原始body.count: ${body.count}`);

        // 🔥 检查今日已购买次数（提前检查，用于计算可购买数量）
        const today = getTodayDate();
        const todayBought = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, today);
        const totalBoughtToday = todayBought?.total || 0;

        // 计算还可以购买的数量
        const remainingCanBuy = config.max_daily_buy_spins - totalBoughtToday;

        logger.debug('购买次数', `购买限制检查 - 今日已购: ${totalBoughtToday}, 每日上限: ${config.max_daily_buy_spins}, 剩余可购: ${remainingCanBuy}`);

        // 🔥 购买数量不能超过剩余可购买数量
        const buyCount = Math.max(1, Math.min(requestedCount, remainingCanBuy));

        // 如果请求的数量超过了剩余可购买数量，返回提示
        if (requestedCount > remainingCanBuy) {
            logger.warn('购买次数', `购买数量超限 - 用户: ${user.username}, 请求: ${requestedCount}, 允许: ${remainingCanBuy}`);
            return c.json({
                success: false,
                message: `购买失败！今日还可购买 ${remainingCanBuy} 次，您尝试购买 ${requestedCount} 次`
            }, 400);
        }

        logger.info('购买次数', `购买数量确认 - 用户: ${user.username}, 请求: ${requestedCount}, 实际购买: ${buyCount}`);

        const buyPrice = config.buy_spins_price * buyCount; // 总价格

        // 检查额度是否足够
        if (currentQuota < buyPrice) {
            return c.json({
                success: false,
                message: `额度不足，购买${buyCount}次需要 $${(buyPrice / 500000).toFixed(2)}，当前额度 $${(currentQuota / 500000).toFixed(2)}`
            }, 400);
        }

        // 🚨 预验证：在扣费前检查购买后的次数是否会增加
        const currentTodaySpins = getUserTodaySpins(session.linux_do_id, today);
        const expectedTotalSpins = config.max_daily_spins + totalBoughtToday + buyCount; // 免费次数 + 已购买 + 本次购买
        const expectedRemainingSpins = expectedTotalSpins - currentTodaySpins; // 购买后的剩余次数

        logger.debug('购买次数', `预验证 - 用户: ${user.username}, 今日已玩: ${currentTodaySpins}, 免费次数: ${config.max_daily_spins}, 已购买: ${totalBoughtToday}, 本次购买: ${buyCount}, 预期总次数: ${expectedTotalSpins}, 预期剩余: ${expectedRemainingSpins}`);

        // 如果购买后剩余次数 <= 0，则拒绝购买（避免扣费后发现次数没增加）
        if (expectedRemainingSpins <= 0) {
            logger.warn('购买次数', `预验证失败 - 用户: ${user.username}, 购买后剩余次数为 ${expectedRemainingSpins}，拒绝扣费`);
            return c.json({
                success: false,
                message: `购买失败：您今日已玩 ${currentTodaySpins} 次，即使购买也无剩余次数。建议明天再来！`
            }, 400);
        }

        // 扣除购买费用
        const newQuota = currentQuota - buyPrice;
        logger.info('购买次数', `准备扣除费用 - 用户: ${user.username}, 购买: ${buyCount}次, 当前: ${currentQuota}, 费用: ${buyPrice}, 目标: ${newQuota}`);

        const deductResult = await updateKyxUserQuota(
            user.kyx_user_id,
            newQuota,
            adminConfig.session,
            adminConfig.new_api_user,
            user.username,
            kyxUserResult.user.group || 'default'
        );

        if (!deductResult || !deductResult.success) {
            logger.error('购买次数', `扣除费用失败 - 用户: ${user.username}, 错误: ${deductResult?.message || '未知错误'}`);
            return c.json({
                success: false,
                message: `扣除费用失败: ${deductResult?.message || '未知错误'}，请稍后重试`
            }, 500);
        }

        logger.info('购买次数', `扣除费用成功 - 用户: ${user.username}, 数量: ${buyCount}, 剩余额度: ${newQuota}`);

        // 🔥 记录购买（添加错误处理和回滚机制）
        const now = Date.now();
        const linuxDoUsername = session.username || user.linux_do_username || null;

        try {
            logger.debug('购买次数', `准备插入记录 - linux_do_id: ${session.linux_do_id}, username: ${user.username}, linux_do_username: ${linuxDoUsername}, buyCount: ${buyCount}, buyPrice: ${buyPrice}, today: ${today}`);

            // 🔥 执行插入
            const insertResult = slotQueries.insertBuySpinsRecord.run(
                session.linux_do_id,
                user.username,
                linuxDoUsername,
                buyCount, // 🔥 购买的数量
                buyPrice,
                now,
                today
            );

            logger.debug('购买次数', `插入操作返回 - changes: ${insertResult?.changes}, lastInsertRowid: ${insertResult?.lastInsertRowid}`);

            // 🔥 验证插入是否成功 - 查询今日已购次数
            const verifyResult = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, today);
            const actualBoughtToday = verifyResult?.total || 0;

            logger.debug('购买次数', `验证插入 - 购买前: ${totalBoughtToday}, 本次购买: ${buyCount}, 预期至少: ${totalBoughtToday + buyCount}, 实际已购: ${actualBoughtToday}, 查询日期: ${today}, verifyResult: ${JSON.stringify(verifyResult)}`);

            // 🔥 修复并发问题：只要实际购买数大于等于预期值，就认为插入成功
            // 如果actualBoughtToday > 预期值，说明有并发购买，但不影响本次购买的成功
            if (actualBoughtToday < totalBoughtToday + buyCount) {
                throw new Error(`数据库插入验证失败，预期至少: ${totalBoughtToday + buyCount}, 实际已购: ${actualBoughtToday}`);
            }

            logger.info('购买次数', `购买成功 - 用户: ${user.username}, 数量: ${buyCount}, 价格: $${(buyPrice / 500000).toFixed(2)}, 今日已购: ${actualBoughtToday}/${config.max_daily_buy_spins}`);

        } catch (dbError: any) {
            logger.error('购买次数', `数据库记录失败 - 用户: ${user.username}, 错误: ${dbError.message}, stack: ${dbError.stack || '无堆栈信息'}`);

            // 🔥 尝试回滚额度（将扣除的额度还回去）
            logger.warn('购买次数', `尝试回滚额度 - 用户: ${user.username}, 从 ${newQuota} 恢复到 ${currentQuota}`);
            const rollbackResult = await updateKyxUserQuota(
                user.kyx_user_id,
                currentQuota, // 恢复到原始额度
                adminConfig.session,
                adminConfig.new_api_user,
                user.username,
                kyxUserResult.user.group || 'default'
            );

            if (rollbackResult && rollbackResult.success) {
                logger.info('购买次数', `回滚成功 - 用户: ${user.username}, 额度已恢复到 ${currentQuota}`);
                return c.json({
                    success: false,
                    message: '购买失败：数据库记录出错，额度已自动退回，请稍后重试'
                }, 500);
            } else {
                logger.error('购买次数', `回滚失败 - 用户: ${user.username}, 损失额度: $${(buyPrice / 500000).toFixed(2)}, 需要人工处理`);

                return c.json({
                    success: false,
                    message: '购买失败：系统错误，请联系管理员处理（错误代码：DB_ROLLBACK_FAILED）',
                    error_details: `额度已扣除但记录失败，需要人工恢复 $${(buyPrice / 500000).toFixed(2)}`
                }, 500);
            }
        }

        // 🔥 重新计算剩余次数（使用实际的购买次数，避免并发问题）
        // 🎯 关键修复：确保使用同一个 today 日期变量
        const todaySpins = getUserTodaySpins(session.linux_do_id, today);

        // 🔥 重新查询实际购买次数（因为可能有并发购买）
        const finalBoughtResult = slotQueries.getTodayBuySpinsCount.get(session.linux_do_id, today);
        const finalBoughtToday = finalBoughtResult?.total || 0;

        const newRemainingSpins = Math.max(0, config.max_daily_spins + finalBoughtToday - todaySpins);

        logger.debug('购买次数', `计算剩余次数 - 用户: ${user.username}, 每日基础: ${config.max_daily_spins}, 今日已购(实际): ${finalBoughtToday}, 今日已玩: ${todaySpins}, 剩余: ${newRemainingSpins}`);

        // 返回新的额度和购买信息
        return c.json({
            success: true,
            message: `购买成功！+${buyCount}次抽奖机会，花费 $${(buyPrice / 500000).toFixed(2)}`,
            data: {
                quota_after: newQuota,
                remaining_spins: newRemainingSpins,
                bought_today: finalBoughtToday,  // 🔥 使用实际购买次数
                max_daily_buy: config.max_daily_buy_spins,
                price: buyPrice,
                buy_count: buyCount // 🔥 返回本次购买数量
            }
        });

    } catch (error) {
        logger.error('购买次数', `服务器错误: ${error instanceof Error ? error.message : '未知错误'}`);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

// ========== 高级场系统 API ==========

/**
 * 获取用户入场券信息
 */
slot.get('/tickets', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查并清理过期入场券
        checkTicketExpiry(session.linux_do_id);
        checkAdvancedModeExpiry(session.linux_do_id);

        const tickets = getUserTickets(session.linux_do_id);
        const config = getAdvancedSlotConfig();

        // 获取今日进入次数（使用北京时间）
        const today = getTodayDate();
        const todayEntry = advancedSlotQueries.getTodayEntry.get(session.linux_do_id, today);
        const todayEntryCount = todayEntry?.entry_count || 0;

        // 获取今日入场券获得数量
        const todayGrant = advancedSlotQueries.getTodayGrant.get(session.linux_do_id, today);
        const todayTicketGranted = todayGrant?.ticket_granted || 0;

        return c.json({
            success: true,
            data: {
                tickets: tickets.tickets,
                fragments: tickets.fragments,
                tickets_expires_at: tickets.tickets_expires_at,
                advanced_mode_until: tickets.advanced_mode_until,
                can_synthesize: tickets.fragments >= config.fragments_needed,
                in_advanced_mode: isInAdvancedMode(session.linux_do_id),
                fragments_needed: config.fragments_needed,
                max_tickets_hold: config.max_tickets_hold,
                today_entry_count: todayEntryCount,  // 🔥 今日已进入次数
                today_ticket_granted: todayTicketGranted,  // 🔥 今日已获得入场券数
                config: {  // 🔥 返回高级场配置
                    bet_min: config.bet_min,
                    bet_max: config.bet_max,
                    reward_multiplier: config.reward_multiplier,
                    daily_bet_limit: config.daily_bet_limit,  // 🔥 添加每日投注限额
                    daily_entry_limit: config.daily_entry_limit,  // 🔥 每日进入次数限制
                    daily_ticket_grant_limit: config.daily_ticket_grant_limit  // 🔥 每日入场券获得限制
                }
            }
        });
    } catch (error) {
        logger.error('入场券', '获取入场券信息失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 合成入场券
 */
slot.post('/tickets/synthesize', requireAuth, createRateLimiter(RateLimits.PURCHASE), async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查过期
        checkTicketExpiry(session.linux_do_id);

        const result = await synthesizeTicket(session.linux_do_id);

        return c.json(result, result.success ? 200 : 400);
    } catch (error) {
        logger.error('入场券', '合成入场券失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 进入高级场
 */
slot.post('/advanced/enter', requireAuth, createRateLimiter(RateLimits.MODE_SWITCH), async (c) => {
    try {
        const session = c.get('session') as SessionData;

        if (!session?.linux_do_id) {
            return c.json({ success: false, message: '会话无效' }, 401);
        }

        const result = await enterAdvancedMode(session.linux_do_id);
        return c.json(result, result.success ? 200 : 400);
    } catch (error) {
        logger.error('高级场', '进入高级场失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 退出高级场
 */
slot.post('/advanced/exit', requireAuth, createRateLimiter(RateLimits.MODE_SWITCH), async (c) => {
    try {
        const session = c.get('session') as SessionData;

        exitAdvancedMode(session.linux_do_id);

        return c.json({
            success: true,
            message: '已退出高级场'
        });
    } catch (error) {
        logger.error('高级场', '退出高级场失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 获取高级场状态
 */
slot.get('/advanced/status', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查过期
        checkAdvancedModeExpiry(session.linux_do_id);

        const tickets = getUserTickets(session.linux_do_id);
        const config = getAdvancedSlotConfig();
        const inAdvancedMode = isInAdvancedMode(session.linux_do_id);

        return c.json({
            success: true,
            data: {
                in_advanced_mode: inAdvancedMode,
                advanced_mode_until: tickets.advanced_mode_until,
                config: {
                    enabled: config.enabled === 1,
                    bet_min: config.bet_min,
                    bet_max: config.bet_max,
                    reward_multiplier: config.reward_multiplier,
                    penalty_weight_factor: config.penalty_weight_factor,
                    session_valid_hours: config.session_valid_hours,
                    daily_bet_limit: config.daily_bet_limit  // 🔥 添加每日投注限额
                }
            }
        });
    } catch (error) {
        logger.error('高级场', '获取高级场状态失败', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

/**
 * 获取当前场次的游戏规则（用于前端展示）
 */
slot.get('/rules', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查是否在高级场
        const inAdvancedMode = isInAdvancedMode(session.linux_do_id!);

        // 获取配置
        const slotConfig = inAdvancedMode
            ? advancedSlotQueries.getAdvancedConfig.get()
            : slotQueries.getConfig.get();

        const schemeId = slotConfig?.reward_scheme_id || 1;
        const weightConfigId = slotConfig?.weight_config_id || 1;

        // 获取规则和惩罚
        const { rewardConfigQueries, weightConfigQueries } = await import('../database');
        const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
        const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);
        const weightConfig = weightConfigQueries.getById.get(weightConfigId);

        // 🔥 用户查看时只读取缓存，不进行计算（节省资源）
        // 使用蒙特卡洛缓存（与预热保持一致）
        const { getFromCache } = await import('../services/probability-calculator');
        const probabilityData = getFromCache(weightConfigId, schemeId, 'monte-carlo');

        // 如果缓存不存在，返回null（管理员需要先在后台计算）
        if (!probabilityData) {
            logger.warn('用户规则', `概率数据未缓存 (权重配置ID:${weightConfigId}, 奖励方案ID:${schemeId})，需要管理员在后台保存配置方案以自动计算并缓存（缓存为永久有效）`);
        }

        // 计算权重总和（包含所有10个符号）
        const totalWeight = weightConfig
            ? (weightConfig.weight_m + weightConfig.weight_t + weightConfig.weight_n + weightConfig.weight_j +
                weightConfig.weight_lq + weightConfig.weight_bj + weightConfig.weight_zft + weightConfig.weight_bdk +
                weightConfig.weight_lsh + (weightConfig.weight_man || 0))
            : 825;

        // 计算律师函概率
        const lshWeight = weightConfig?.weight_lsh || 25;
        const lshSingleProb = lshWeight / totalWeight;
        const lshAtLeastOneProb = (1 - Math.pow(1 - lshSingleProb, 4)) * 100;

        // 🔥 将概率数据附加到规则上，并包含动态生成的规则（如man组合）
        let rulesWithProb = rules.filter(r => r.is_active).map(r => {
            const probData = probabilityData?.rules.find(p => p.ruleName === r.rule_name);
            return {
                ...r,
                probability: probData ? probData.probability.toFixed(2) + '%' : '计算中'
            };
        });

        // 🔥 不再添加动态生成的组合规则，只显示配置的规则的真实概率

        const punishmentsWithProb = punishments.filter(p => p.is_active).map(p => {
            const probData = probabilityData?.punishments.find(pr => pr.ruleName === `律师函×${p.lsh_count}`);
            return {
                ...p,
                probability: probData ? probData.probability.toFixed(2) + '%' : lshAtLeastOneProb.toFixed(2) + '%'
            };
        });

        // 🔥 获取高级场或初级场的配置信息
        let advancedConfig = null;
        let normalConfig = null;

        if (inAdvancedMode) {
            // 高级场配置
            const advConfig = getAdvancedSlotConfig();
            advancedConfig = {
                bet_min: advConfig.bet_min,
                bet_max: advConfig.bet_max,
                reward_multiplier: advConfig.reward_multiplier,
                daily_bet_limit: advConfig.daily_bet_limit,
                session_valid_hours: advConfig.session_valid_hours
            };
        } else {
            // 初级场配置
            const normalSlotConfig = getSlotConfig();
            normalConfig = {
                bet_amount: normalSlotConfig.bet_amount,
                max_spins: normalSlotConfig.max_daily_spins,
                min_quota_required: normalSlotConfig.min_quota_required,
                buy_spins_enabled: normalSlotConfig.buy_spins_enabled === 1
            };
        }

        return c.json({
            success: true,
            data: {
                mode: inAdvancedMode ? 'advanced' : 'normal',
                in_advanced_mode: inAdvancedMode,  // 🔥 添加场次状态标识
                rules: rulesWithProb,
                punishments: punishmentsWithProb,
                noWinProbability: probabilityData ? probabilityData.noWin.probability.toFixed(2) + '%' : null,
                rtp: probabilityData ? probabilityData.rtp.toFixed(2) + '%' : null,
                weightConfig: weightConfig,
                totalWeight: totalWeight,
                // 🔥 添加场次配置信息
                advancedConfig: advancedConfig,
                normalConfig: normalConfig
            }
        });
    } catch (error: any) {
        logger.error('游戏规则', '获取失败', error);
        return c.json({ success: false, message: '获取规则失败' }, 500);
    }
});

export default slot;

