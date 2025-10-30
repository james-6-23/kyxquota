/**
 * 至尊场系统路由
 */

import { Hono } from 'hono';
import { getCookie, getSession } from '../utils';
import type { SessionData } from '../types';
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
    calculateSupremeWin,
    recordSupremeGame,
    getTodaySupremeBet
} from '../services/supreme-slot';
import { supremeSlotQueries, userQueries, adminQueries } from '../database';
import { updateKyxUserQuota } from '../services/kyx-api';

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

        // 获取今日进入记录
        const today = new Date().toISOString().split('T')[0];
        const todayEntry = supremeSlotQueries.getTodayEntry.get(session.linux_do_id!, today);
        const todayGrant = supremeSlotQueries.getTodayGrant.get(session.linux_do_id!, today);

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
                config: {
                    daily_entry_limit: config.daily_entry_limit,
                    daily_token_grant_limit: config.daily_token_grant_limit,
                    session_valid_hours: config.session_valid_hours
                }
            }
        });
    } catch (error: any) {
        console.error('[至尊场] 获取令牌信息失败:', error);
        return c.json({ success: false, message: '获取令牌信息失败' }, 500);
    }
});

/**
 * 合成至尊令牌
 */
supreme.post('/tokens/synthesize', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const result = synthesizeSupremeToken(session.linux_do_id!);

        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        console.error('[至尊场] 合成令牌失败:', error);
        return c.json({ success: false, message: '合成失败' }, 500);
    }
});

/**
 * 进入至尊场
 */
supreme.post('/enter', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 检查用户是否在高级场中（前置条件）
        // 这个检查应该在前端和后端都做
        const result = enterSupremeMode(session.linux_do_id!);

        return c.json(result, result.success ? 200 : 400);
    } catch (error: any) {
        console.error('[至尊场] 进入失败:', error);
        return c.json({ success: false, message: '进入失败' }, 500);
    }
});

/**
 * 退出至尊场
 */
supreme.post('/exit', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        exitSupremeMode(session.linux_do_id!);

        return c.json({
            success: true,
            message: '已退出至尊场'
        });
    } catch (error: any) {
        console.error('[至尊场] 退出失败:', error);
        return c.json({ success: false, message: '退出失败' }, 500);
    }
});

/**
 * 至尊场旋转
 */
supreme.post('/spin', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const { betAmount } = await c.req.json();

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

        // 检查每日投注限额
        const todayBet = getTodaySupremeBet(session.linux_do_id!);
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

        // 🔥 获取用户当前额度
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        const { getUserQuota } = await import('../services/kyx-api');
        const userQuota = getUserQuota(user.kyx_user_id);

        // 检查额度是否足够
        if (userQuota < betAmount) {
            return c.json({
                success: false,
                message: `额度不足，当前额度: $${(userQuota / 500000).toFixed(2)}，需要: $${(betAmount / 500000).toFixed(2)}`
            }, 400);
        }

        // 生成符号
        const symbols = generateSupremeSymbols();

        // 计算中奖
        const winResult = calculateSupremeWin(symbols);

        // 计算赢得金额
        let winAmount = 0;
        if (winResult.multiplier > 0) {
            // 中奖
            winAmount = Math.floor(betAmount * winResult.multiplier);
        } else if (winResult.multiplier < 0) {
            // 惩罚（律师函）
            winAmount = Math.floor(betAmount * winResult.multiplier);
        }

        // 🔥 先扣除投注（投注必须成功才能记录游戏）
        const deductResult = await updateKyxUserQuota(
            user.kyx_user_id,
            -betAmount,
            adminConfig.session,
            adminConfig.new_api_user,
            session.username || user.username,
            'default'
        );

        if (!deductResult.success) {
            return c.json({
                success: false,
                message: '扣除投注失败: ' + deductResult.message
            }, 500);
        }

        // 记录游戏
        recordSupremeGame(
            session.linux_do_id!,
            session.username || user.username,
            session.username || null,
            betAmount,
            symbols,
            winResult.winType,
            winResult.multiplier,
            winAmount
        );

        let quotaAfter = deductResult.quota;

        // 如果中奖，增加额度
        if (winAmount > 0) {
            const addResult = await updateKyxUserQuota(
                user.kyx_user_id,
                winAmount,
                adminConfig.session,
                adminConfig.new_api_user,
                session.username || user.username,
                'default'
            );

            if (addResult.success) {
                quotaAfter = addResult.quota;
            }
        }

        // 处理律师函惩罚禁止
        if (winResult.punishmentCount && winResult.banHours && winResult.banHours > 0) {
            // TODO: 实现禁止抽奖逻辑（需要在 user_free_spins 表中设置）
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
                quota_after: quotaAfter,
                grant_free_spin: winResult.grantFreeSpin
            }
        });
    } catch (error: any) {
        console.error('[至尊场] 旋转失败:', error);
        return c.json({ success: false, message: '旋转失败: ' + error.message }, 500);
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
        console.error('[至尊场] 获取记录失败:', error);
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

        // 🔥 使用快速计算获取概率
        const { calculateProbabilityFast } = await import('../services/probability-calculator');
        let probabilityData;
        try {
            probabilityData = calculateProbabilityFast(weightConfigId, schemeId);
        } catch (e) {
            console.error('[至尊场规则概率] 计算失败:', e);
            probabilityData = null;
        }

        // 计算权重总和
        const totalWeight = weightConfig
            ? (weightConfig.weight_m + weightConfig.weight_t + weightConfig.weight_n + weightConfig.weight_j +
                weightConfig.weight_lq + weightConfig.weight_bj + weightConfig.weight_zft + weightConfig.weight_bdk + weightConfig.weight_lsh)
            : 825;

        // 计算律师函概率
        const lshWeight = weightConfig?.weight_lsh || 25;
        const lshSingleProb = lshWeight / totalWeight;
        const lshAtLeastOneProb = (1 - Math.pow(1 - lshSingleProb, 4)) * 100;

        // 🔥 将概率数据附加到规则上
        const rulesWithProb = rules.filter(r => r.is_active).map(r => {
            const probData = probabilityData?.rules.find(p => p.ruleName === r.rule_name);
            return {
                ...r,
                probability: probData ? probData.probability.toFixed(2) + '%' : '计算中'
            };
        });
        
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
        console.error('[至尊场规则] 获取失败:', error);
        return c.json({ success: false, message: '获取规则失败' }, 500);
    }
});

export default supreme;

