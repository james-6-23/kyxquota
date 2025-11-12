/**
 * 至尊场系统路由
 */

import { Hono } from 'hono';
import { getCookie, getSession } from '../utils';
import type { SessionData } from '../types';
import { createRateLimiter, RateLimits } from '../middleware/user-rate-limit';
import {
    getSupremeTokens,
    getSupremeSlotConfig,
    synthesizeSupremeToken,
    enterSupremeMode,
    exitSupremeMode,
    checkTokenExpiry,
    checkSupremeModeExpiry,
    isInSupremeMode,
    generateSupremeSymbols,
    recordSupremeGame,
    getTodaySupremeBet
} from '../services/supreme-slot';
import { updateUserTotalStats, updateUserDailyStats, updateUserWeeklyStats, isUserBanned } from '../services/slot';
import { calculateWinByScheme } from '../services/reward-calculator';
import { supremeSlotQueries, userQueries, adminQueries } from '../database';
import { updateKyxUserQuota } from '../services/kyx-api';
import { db } from '../database';
import { checkAndUnlockAchievement, updateAchievementProgress, recordSymbols, updateProfitTracking } from '../services/achievement';
import logger from '../utils/logger';

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

const supreme = new Hono();

/**
 * 中间件：验证用户登录
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

    c.set('session', session);
    await next();
}

/**
 * 获取至尊令牌信息
 */
supreme.get('/tokens', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 🔥 先获取原始数据，再检查过期（避免刚发放就被清除）
        const tokensBeforeCheck = getSupremeTokens(session.linux_do_id!);
        const config = getSupremeSlotConfig();

        // 检查并清理过期
        checkTokenExpiry(session.linux_do_id!);
        checkSupremeModeExpiry(session.linux_do_id!);

        // 🔥 重新获取（可能已被清理）
        const tokens = getSupremeTokens(session.linux_do_id!);

        const canSynthesize = tokens && tokens.fragments >= config.fragments_to_token && tokens.tokens < config.max_tokens_hold;
        const inSupremeMode = isInSupremeMode(session.linux_do_id!);

        // 获取今日进入记录（使用北京时间）
        const { getTodayDate } = await import('../services/slot');
        const today = getTodayDate();
        const todayEntry = supremeSlotQueries.getTodayEntry.get(session.linux_do_id!, today);
        const todayGrant = supremeSlotQueries.getTodayGrant.get(session.linux_do_id!, today);

        // 🔥 获取今日已投注金额（用于显示限额进度条）
        const todayBetAmount = getTodaySupremeBet(session.linux_do_id!);

        return c.json({
            success: true,
            data: {
                tokens: tokens?.tokens || 0,
                fragments: tokens?.fragments || 0,
                fragments_needed: config.fragments_to_token,
                can_synthesize: canSynthesize,
                max_tokens_hold: config.max_tokens_hold,
                tokens_expires_at: tokens?.tokens_expires_at || null,
                supreme_mode_until: tokens?.supreme_mode_until || null,
                in_supreme_mode: inSupremeMode,
                today_entry_count: todayEntry?.entry_count || 0,
                today_tokens_granted: todayGrant?.tokens_granted || 0,
                today_bet_amount: todayBetAmount,  // 🔥 今日已投注金额
                config: {
                    daily_entry_limit: config.daily_entry_limit,
                    daily_token_grant_limit: config.daily_token_grant_limit,
                    session_valid_hours: config.session_valid_hours,
                    min_bet_amount: config.min_bet_amount,
                    max_bet_amount: config.max_bet_amount,
                    bet_step: config.bet_step,
                    daily_bet_limit: config.daily_bet_limit  // 🔥 每日投注限额
                }
            }
        });
    } catch (error: any) {
        logger.error('至尊场', `获取令牌信息失败: ${error.message}`);
        return c.json({ success: false, message: '获取令牌信息失败' }, 500);
    }
});

/**
 * 合成至尊令牌
 */
supreme.post('/tokens/synthesize', requireAuth, createRateLimiter(RateLimits.PURCHASE), async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const result = await synthesizeSupremeToken(session.linux_do_id!);

        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        logger.error('至尊场', `合成令牌失败: ${error.message}`);
        return c.json({ success: false, message: '合成失败' }, 500);
    }
});

/**
 * 进入至尊场
 */
supreme.post('/enter', requireAuth, createRateLimiter(RateLimits.MODE_SWITCH), async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查用户是否在高级场中（前置条件）
        // 这个检查应该在前端和后端都做
        const result = await enterSupremeMode(session.linux_do_id!);

        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        logger.error('至尊场', `进入失败: ${error.message}`);
        return c.json({ success: false, message: '进入失败' }, 500);
    }
});

/**
 * 退出至尊场
 */
supreme.post('/exit', requireAuth, createRateLimiter(RateLimits.MODE_SWITCH), async (c) => {
    try {
        const session = c.get('session') as SessionData;

        exitSupremeMode(session.linux_do_id!);

        return c.json({
            success: true,
            message: '已退出至尊场'
        });
    } catch (error: any) {
        logger.error('至尊场', `退出失败: ${error.message}`);
        return c.json({ success: false, message: '退出失败' }, 500);
    }
});

/**
 * 至尊场旋转
 */
supreme.post('/spin', requireAuth, createRateLimiter(RateLimits.SUPREME_SPIN), async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const { betAmount } = await c.req.json();

        // 🔥 检查坤呗逾期状态（确保用户玩游戏时及时扣款）
        try {
            const { checkOverdueLoans } = await import('../services/kunbei');
            await checkOverdueLoans();
        } catch (err: any) {
            logger.warn('至尊场', `坤呗逾期检查失败: ${err.message}`);
        }

        // 验证参数
        if (!betAmount || typeof betAmount !== 'number') {
            return c.json({ success: false, message: '参数错误' }, 400);
        }

        const config = getSupremeSlotConfig();

        // 验证投注金额范围
        if (betAmount < config.min_bet_amount || betAmount > config.max_bet_amount) {
            return c.json({
                success: false,
                message: `投注金额必须在 $${(config.min_bet_amount / 500000).toFixed(0)} - $${(config.max_bet_amount / 500000).toFixed(0)} 之间`
            }, 400);
        }

        // 检查是否在至尊场中
        if (!isInSupremeMode(session.linux_do_id!)) {
            return c.json({
                success: false,
                message: '您不在至尊场中，请先进入至尊场'
            }, 400);
        }

        // 检查是否被禁止使用至尊场（律师函惩罚）
        const banStatus = isUserBanned(session.linux_do_id!);
        if (banStatus.banned) {
            const remainingTime = banStatus.bannedUntil - Date.now();
            const remainingHours = Math.ceil(remainingTime / 3600000);
            return c.json({
                success: false,
                message: `⚡ 您因收到过多律师函，已被禁止使用至尊场。解禁时间：${new Date(banStatus.bannedUntil).toLocaleString('zh-CN')}（剩余约${remainingHours}小时）。您可以继续使用初级场。`
            }, 403);
        }

        // 检查每日投注限额
        const todayBet = getTodaySupremeBet(session.linux_do_id!);
        logger.info('至尊场检查', `用户: ${getUserDisplayName(session.linux_do_id)}, 今日已投注: $${(todayBet / 500000).toFixed(2)}, 本次投注: $${(betAmount / 500000).toFixed(2)}, 投注后总计: $${((todayBet + betAmount) / 500000).toFixed(2)}, 限额: $${(config.daily_bet_limit / 500000).toFixed(2)}`);
        if (todayBet + betAmount > config.daily_bet_limit) {
            return c.json({
                success: false,
                message: `今日投注额度已达上限 $${(config.daily_bet_limit / 500000).toFixed(2)}`
            }, 400);
        }

        // 获取用户信息
        const user = userQueries.get.get(session.linux_do_id!);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 🔥 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 使用本地钱包余额
        const walletRow = db.query('SELECT balance_quota FROM user_wallets WHERE linux_do_id = ?').get(session.linux_do_id) as any;
        const currentQuota = walletRow ? (walletRow.balance_quota as number) : 0;

        // 检查额度是否足够
        if (currentQuota < betAmount) {
            return c.json({
                success: false,
                message: `额度不足，当前额度: $${(currentQuota / 500000).toFixed(2)}，需要: $${(betAmount / 500000).toFixed(2)}`
            }, 400);
        }

        // 生成符号
        const symbols = generateSupremeSymbols();

        // 🔥 计算中奖（使用统一的配置方案系统）
        // 至尊场使用严格连续判定（与高级场一致）
        const winResult = calculateWinByScheme(symbols, config.reward_scheme_id, true);

        // 🔥 检查并应用坤呗buff（只对正向中奖生效，不放大惩罚）
        const { getAndUseBuff } = await import('../services/kunbei');
        const kunbeiBuff = getAndUseBuff(session.linux_do_id!);
        if (kunbeiBuff > 1 && winResult.multiplier > 0) {
            logger.info('坤呗Buff', `应用buff×${kunbeiBuff}，原倍率: ${winResult.multiplier}，新倍率: ${winResult.multiplier * kunbeiBuff}`);
            winResult.multiplier = winResult.multiplier * kunbeiBuff;
        }

        // 计算赢得金额
        let winAmount = 0;
        if (winResult.multiplier > 0) {
            // 中奖
            winAmount = Math.floor(betAmount * winResult.multiplier);
        } else if (winResult.multiplier < 0) {
            // 惩罚（律师函）
            winAmount = Math.floor(betAmount * winResult.multiplier);
        }

        // 🔥 扣除投注额度（计算新额度 = 当前额度 - 投注金额，与初级场/高级场保持一致）
        const newQuotaAfterBet = currentQuota - betAmount;

        logger.info('至尊场', `准备扣除投注(本地钱包) - 用户: ${getUserDisplayName(session.linux_do_id)}, 当前: ${currentQuota}, 投注: ${betAmount}, 目标: ${newQuotaAfterBet}`);
        if (newQuotaAfterBet < 0) {
            return c.json({ success: false, message: '额度不足以支付投注金额' }, 400);
        }
        const now = Date.now();
        db.query('INSERT INTO user_wallets (linux_do_id, balance_quota, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(linux_do_id) DO UPDATE SET balance_quota = ?, updated_at = ?')
          .run(session.linux_do_id, newQuotaAfterBet, now, now, newQuotaAfterBet, now);
        logger.info('至尊场', `✅ 扣除投注成功(本地钱包) - 用户: ${getUserDisplayName(session.linux_do_id)}, 剩余: ${newQuotaAfterBet}`);

        // 🔥 显示中奖判定符号（与高级场保持一致）
        logger.info('中奖判定', `符号: ${symbols.join(',')}, 规则: ${winResult.ruleName}, 倍率: ${winResult.multiplier}`);

        // 记录游戏
        recordSupremeGame(
            session.linux_do_id!,
            user.username,  // 🔥 使用公益站用户名（linuxdo_xxx格式），与初级场/高级场保持一致
            session.username || null,  // LinuxDo论坛用户名（用于显示）
            betAmount,
            symbols,
            winResult.winType,
            winResult.multiplier,
            winAmount,
            winResult.ruleName  // 🔥 记录规则名称
        );

        // 🔥 更新用户总统计（用于排行榜）- 修复至尊场盈利未计入排行榜的问题
        const displayUsername = session.username || user.linux_do_username || user.username;
        updateUserTotalStats(
            session.linux_do_id!,
            displayUsername,
            session.avatar_url || '',
            betAmount,
            winAmount,
            winResult.winType
        );

        // 更新用户日榜统计
        updateUserDailyStats(
            session.linux_do_id!,
            displayUsername,
            session.avatar_url || '',
            betAmount,
            winAmount,
            winResult.winType
        );

        // 更新用户周榜统计
        updateUserWeeklyStats(
            session.linux_do_id!,
            displayUsername,
            session.avatar_url || '',
            betAmount,
            winAmount,
            winResult.winType
        );

        let quotaAfter = newQuotaAfterBet;

        // 如果中奖，增加额度
        if (winAmount > 0) {
            const addRes = addWallet(session.linux_do_id!, winAmount);
            quotaAfter = addRes.newBalance;
            logger.info('至尊场', `✅ 添加奖金成功(本地) - 用户: ${getUserDisplayName(session.linux_do_id)}, 新余额: ${quotaAfter}`);
        } else if (winAmount < 0) {
            // 🔥 惩罚扣除（律师函）
            const punishmentAmount = Math.abs(winAmount);

            const dres = deductUpTo(session.linux_do_id!, punishmentAmount);
            quotaAfter = dres.newBalance;
            winAmount = -dres.actualDeducted;
            logger.info('至尊场', `✅ 惩罚扣除成功(本地) - 用户: ${getUserDisplayName(session.linux_do_id)}, 扣除: 🥚${(actualDeduction / 500000).toFixed(2)}, 新余额: ${quotaAfter}`);
        }

        // 🔥 处理律师函惩罚封禁（与初级场/高级场保持一致）
        if (winResult.punishmentCount && winResult.banHours && winResult.banHours > 0) {
            const { banUserFromSlot } = await import('../services/slot');
            banUserFromSlot(session.linux_do_id!, winResult.banHours, 'supreme');
            logger.info('至尊场', `🚫 严重惩罚 - 用户: ${user.username}, 在【至尊场】律师函数量: ${winResult.punishmentCount}, 禁止抽奖${winResult.banHours}小时`);
        }

        // ========== 成就系统检查 ==========
        // 🏆 收集本次解锁的成就
        const unlockedAchievements: any[] = [];

        try {
            const { checkAndUnlockAchievement, updateAchievementProgress } = await import('../services/achievement');

            // 1. 首次游戏成就（至尊场也算游戏）
            const result1 = await checkAndUnlockAchievement(session.linux_do_id!, 'first_game');
            if (result1.unlocked && result1.achievement) {
                unlockedAchievements.push(result1.achievement);
            }

            // 🔥 2. 游玩次数成就（并发检查，避免深度调用链）
            const playProgressResults = await Promise.allSettled([
                updateAchievementProgress(session.linux_do_id!, 'play_10_games', 1),
                updateAchievementProgress(session.linux_do_id!, 'play_50_games', 1),
                updateAchievementProgress(session.linux_do_id!, 'play_200_games', 1),
                updateAchievementProgress(session.linux_do_id!, 'play_1000_games', 1)
            ]);

            // 收集解锁的成就
            playProgressResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value.unlocked && result.value.achievement) {
                    unlockedAchievements.push(result.value.achievement);
                }
            });

            // 3. 中奖相关成就
            if (winResult.multiplier > 0) {
                // 首次中奖
                const result2 = await checkAndUnlockAchievement(session.linux_do_id!, 'first_win');
                if (result2.unlocked && result2.achievement) {
                    unlockedAchievements.push(result2.achievement);
                }

                // 🔥 中奖次数成就（并发检查）
                const winProgressResults = await Promise.allSettled([
                    updateAchievementProgress(session.linux_do_id!, 'win_10_times', 1),
                    updateAchievementProgress(session.linux_do_id!, 'win_50_times', 1),
                    updateAchievementProgress(session.linux_do_id!, 'win_100_times', 1)
                ]);

                // 收集解锁的成就
                winProgressResults.forEach(result => {
                    if (result.status === 'fulfilled' && result.value.unlocked && result.value.achievement) {
                        unlockedAchievements.push(result.value.achievement);
                    }
                });

                // 🔥 连击计数器（连续中奖）
                const streakResult = userQueries.getWinStreak.get(session.linux_do_id!);
                const currentStreak = (streakResult?.win_streak || 0) + 1;
                userQueries.updateWinStreak.run(currentStreak, session.linux_do_id!);

                // 🔥 连续中奖成就（收集解锁信息）
                if (currentStreak >= 3) {
                    const result3 = await checkAndUnlockAchievement(session.linux_do_id!, 'combo_3_wins');
                    if (result3.unlocked && result3.achievement) {
                        unlockedAchievements.push(result3.achievement);
                    }
                }
                if (currentStreak >= 5) {
                    const result4 = await checkAndUnlockAchievement(session.linux_do_id!, 'combo_5_wins');
                    if (result4.unlocked && result4.achievement) {
                        unlockedAchievements.push(result4.achievement);
                    }
                }

                // 🔥 单次大额中奖成就（收集解锁信息）
                if (winAmount >= 2500000) {
                    const result5 = await checkAndUnlockAchievement(session.linux_do_id!, 'single_win_5k');
                    if (result5.unlocked && result5.achievement) {
                        unlockedAchievements.push(result5.achievement);
                    }
                }
            } else {
                // 未中奖或惩罚，重置连击计数器
                userQueries.updateWinStreak.run(0, session.linux_do_id!);
            }

            // 🔥 4. Man符号相关成就（所有情况都检查）
            const manCount = symbols.filter((s: string) => s === 'man').length;
            if (manCount > 0) {
                // 累计抽到25个Man符号
                const manProgress = await updateAchievementProgress(session.linux_do_id!, 'man_25_times', manCount);
                if (manProgress.unlocked && manProgress.achievement) {
                    unlockedAchievements.push(manProgress.achievement);
                }
            }

            // 🔥 5. 偶像练习生成就（按顺序抽到 BJ→ZFT→BDK→LQ）
            if (symbols.length === 4 &&
                symbols[0] === 'bj' &&
                symbols[1] === 'zft' &&
                symbols[2] === 'bdk' &&
                symbols[3] === 'lq') {
                const idolResult = await checkAndUnlockAchievement(session.linux_do_id!, 'idol_trainee');
                if (idolResult.unlocked && idolResult.achievement) {
                    unlockedAchievements.push(idolResult.achievement);
                }
            }

            // 🔥 6. 符号收集者成就 - 记录本次抽到的符号（与高级场保持一致）
            await recordSymbols(session.linux_do_id!, symbols);

            // 🔥 7. 财富成就 - 余额达标（余额达到50k）
            if (quotaAfter >= 25000000) { // 50000 * 500000 = 25000000
                const balanceResult = await checkAndUnlockAchievement(session.linux_do_id!, 'balance_50k');
                if (balanceResult.unlocked && balanceResult.achievement) {
                    unlockedAchievements.push(balanceResult.achievement);
                }
            }

            // 🔥 8. 财富成就 - 累计盈利（从用户总统计获取）
            const { getUserTotalStats } = await import('../services/slot');
            const userTotalStats = getUserTotalStats(session.linux_do_id!);
            if (userTotalStats) {
                const totalProfit = userTotalStats.total_win - userTotalStats.total_bet;

                // 累计盈利10k
                if (totalProfit >= 5000000) { // 10000 * 500000 = 5000000
                    const earn10kResult = await checkAndUnlockAchievement(session.linux_do_id!, 'earn_10k');
                    if (earn10kResult.unlocked && earn10kResult.achievement) {
                        unlockedAchievements.push(earn10kResult.achievement);
                    }
                }
                // 累计盈利100k
                if (totalProfit >= 50000000) { // 100000 * 500000 = 50000000
                    const earn100kResult = await checkAndUnlockAchievement(session.linux_do_id!, 'earn_100k');
                    if (earn100kResult.unlocked && earn100kResult.achievement) {
                        unlockedAchievements.push(earn100kResult.achievement);
                    }
                }
                // 累计盈利1m
                if (totalProfit >= 500000000) { // 1000000 * 500000 = 500000000
                    const earn1mResult = await checkAndUnlockAchievement(session.linux_do_id!, 'earn_1m');
                    if (earn1mResult.unlocked && earn1mResult.achievement) {
                        unlockedAchievements.push(earn1mResult.achievement);
                    }
                }

                // 🔥 9. 逆风翻盘成就 - 更新盈利追踪
                const currentProfit = totalProfit;
                await updateProfitTracking(session.linux_do_id!, currentProfit);
            }

        } catch (achievementError) {
            logger.warn('至尊场', `成就检查失败: ${achievementError}`);
        }

        // 构建响应消息
        let message = '';
        if (winResult.multiplier > 0) {
            message = `🎉 ${winResult.ruleName}！赢得 $${(winAmount / 500000).toFixed(2)} (${winResult.multiplier}x)`;
        } else if (winResult.multiplier < 0) {
            message = `⚖️ ${winResult.ruleName}！扣除 $${(Math.abs(winAmount) / 500000).toFixed(2)}`;
            if (winResult.banHours && winResult.banHours > 0) {
                message += `，禁止抽奖 ${winResult.banHours} 小时`;
            }
        } else {
            message = '未中奖';
        }

        // 使用本地钱包余额
        const afterRow = db.query('SELECT balance_quota FROM user_wallets WHERE linux_do_id = ?').get(session.linux_do_id) as any;
        const quotaAfterLocal = afterRow ? (afterRow.balance_quota as number) : 0;

        return c.json({
            success: true,
            message,
            data: {
                symbols,
                win_type: winResult.winType,
                win_type_name: winResult.ruleName,
                multiplier: winResult.multiplier,
                bet_amount: betAmount,
                win_amount: winAmount,
                quota_after: quotaAfterLocal,
                grant_free_spin: winResult.grantFreeSpin,
                // 🏆 本次解锁的成就列表
                unlocked_achievements: unlockedAchievements
            }
        });
    } catch (error: any) {
        logger.error('至尊场', '旋转失败', error);
        if (error instanceof Error && error.stack) {
            logger.error('至尊场', '错误堆栈', error.stack);
        }
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        return c.json({
            success: false,
            message: `旋转失败: ${errorMessage}`
        }, 500);
    }
});

/**
 * 获取至尊场游戏记录
 */
supreme.get('/records', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const records = supremeSlotQueries.getRecordsByUser.all(session.linux_do_id!);

        return c.json({
            success: true,
            data: records
        });
    } catch (error: any) {
        logger.error('至尊场', `获取记录失败: ${error.message}`);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 获取至尊场游戏规则（用于前端展示）
 */
supreme.get('/rules', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查是否在至尊场
        const inSupremeMode = isInSupremeMode(session.linux_do_id!);

        // 获取配置
        const config = getSupremeSlotConfig();
        const schemeId = config.reward_scheme_id || 1;
        const weightConfigId = config.weight_config_id || 1;

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
            logger.warn('至尊场规则', `概率数据未缓存 (权重配置ID:${weightConfigId}, 奖励方案ID:${schemeId})，需要管理员在后台保存配置方案以自动计算并缓存（缓存为永久有效）`);
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

        return c.json({
            success: true,
            data: {
                mode: 'supreme',
                in_supreme_mode: inSupremeMode,
                rules: rulesWithProb,
                punishments: punishmentsWithProb,
                noWinProbability: probabilityData ? probabilityData.noWin.probability.toFixed(2) + '%' : null,
                rtp: probabilityData ? probabilityData.rtp.toFixed(2) + '%' : null,
                weightConfig: weightConfig,
                totalWeight: totalWeight,
                config: {
                    min_bet: config.min_bet_amount / 500000,
                    max_bet: config.max_bet_amount / 500000,
                    daily_entry_limit: config.daily_entry_limit,
                    session_valid_hours: config.session_valid_hours
                }
            }
        });
    } catch (error: any) {
        logger.error('至尊场规则', `获取失败: ${error.message}`);
        return c.json({ success: false, message: '获取规则失败' }, 500);
    }
});

export default supreme;

