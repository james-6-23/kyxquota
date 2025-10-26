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
    getLossLeaderboard,
    getUserRank,
    getUserLossRank,
    getUserTotalStats,
    isUserBanned,
    banUserFromSlot,
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

        // 获取历史总统计
        const totalStats = getUserTotalStats(session.linux_do_id);

        // 检查是否被禁止抽奖
        const banStatus = isUserBanned(session.linux_do_id);

        // 计算剩余次数
        const remainingSpins = Math.max(0, config.max_daily_spins - todaySpins);

        // 是否可以游玩
        const canPlay = !banStatus.banned && (remainingSpins > 0 || freeSpins > 0) && quota >= config.min_quota_required;

        return c.json({
            success: true,
            data: {
                config: {
                    bet_amount: config.bet_amount,
                    max_daily_spins: config.max_daily_spins,
                    min_quota_required: config.min_quota_required,
                    enabled: config.enabled,
                    background_type: config.background_type || 'default'
                },
                user: {
                    quota,
                    today_spins: todaySpins,
                    free_spins: freeSpins,
                    remaining_spins: remainingSpins,
                    can_play: canPlay,
                    today_bet: todayStats.totalBet,
                    today_win: todayStats.totalWin,
                    today_count: todayStats.count,
                    // 历史总统计
                    total_spins: totalStats?.total_spins || 0,
                    total_bet: totalStats?.total_bet || 0,
                    total_win: totalStats?.total_win || 0,
                    // 禁止状态
                    is_banned: banStatus.banned,
                    banned_until: banStatus.bannedUntil
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

        // 检查是否被禁止抽奖（律师函惩罚）
        const banStatus = isUserBanned(session.linux_do_id);
        if (banStatus.banned) {
            const remainingTime = banStatus.bannedUntil - Date.now();
            const remainingHours = Math.ceil(remainingTime / 3600000);
            return c.json({
                success: false,
                message: `⚡ 您因收到过多律师函，已被禁止抽奖。解禁时间：${new Date(banStatus.bannedUntil).toLocaleString('zh-CN')}（剩余约${remainingHours}小时）`
            }, 403);
        }

        const config = getSlotConfig();
        if (!config || !config.enabled) {
            return c.json({ success: false, message: '老虎机功能已关闭' }, 403);
        }

        // 解析请求参数
        const body = await c.req.json().catch(() => ({}));
        const useFreeSpinn = body.useFreeSpinn === true;

        let isFreeSpin = false;
        let betAmount = config.bet_amount;
        let calculationBetAmount = config.bet_amount; // 用于计算奖金的金额

        if (useFreeSpinn) {
            console.log(`[免费次数] 开始处理 - 用户: ${user.username} (${session.linux_do_id})`);

            // 直接尝试扣除免费次数（原子操作）
            const used = useUserFreeSpin(session.linux_do_id);
            console.log(`[免费次数] 扣除免费次数结果: ${used}`);

            if (!used) {
                // 扣除失败，重新查询当前免费次数
                const actualFreeSpins = getUserFreeSpins(session.linux_do_id);
                console.error(`[免费次数] 扣除失败 - 用户: ${user.username}, 实际免费次数: ${actualFreeSpins}`);

                // 提供更详细的错误信息
                const errorMsg = actualFreeSpins > 0
                    ? `扣除免费次数失败，请重试（当前有${actualFreeSpins}次）`
                    : '没有免费次数';

                console.error(`[免费次数] 返回错误: ${errorMsg}`);
                return c.json({
                    success: false,
                    message: errorMsg
                }, 400);
            }

            console.log(`[免费次数] ✅ 用户 ${user.username} 成功使用1次免费机会`);
            isFreeSpin = true;
            betAmount = 0; // 免费游戏不扣费（用于记录）
            // calculationBetAmount 保持为 config.bet_amount（用于计算奖金）
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

            console.log(`[老虎机] 准备扣除投注 - 用户: ${user.username}, 当前: ${currentQuota}, 投注: ${betAmount}, 目标: ${newQuotaAfterBet}`);

            const deductResult = await updateKyxUserQuota(
                user.kyx_user_id,
                newQuotaAfterBet,
                adminConfig.session,
                adminConfig.new_api_user,
                user.username,
                kyxUserResult.user.group || 'default'
            );

            if (!deductResult || !deductResult.success) {
                console.error(`[老虎机] ❌ 扣除投注失败 - 用户: ${user.username}, 错误: ${deductResult?.message || '未知错误'}`);
                return c.json({
                    success: false,
                    message: `扣除投注额度失败: ${deductResult?.message || '未知错误'}，请稍后重试`
                }, 500);
            }

            console.log(`[老虎机] ✅ 扣除投注成功 - 用户: ${user.username}, 剩余: ${newQuotaAfterBet}`);
        }

        // 生成随机符号
        const symbols = generateSymbols();

        // 计算中奖结果
        const result = calculateWin(symbols);

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

            console.log(`[老虎机] 💰 中奖 - 用户: ${user.username}, 类型: ${WIN_TYPE_NAMES[result.winType]}, 奖金: $${(winAmount / 500000).toFixed(2)}`);

            // 增加额度
            const currentKyxUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
            if (!currentKyxUser.success || !currentKyxUser.user) {
                console.error(`[老虎机] ❌ 中奖后获取用户信息失败 - 用户: ${user.username}`);
                quotaUpdateFailed = true;
                quotaUpdateError = '获取用户信息失败，请联系管理员补发奖金';
            } else {
                const quotaBeforeWin = currentKyxUser.user.quota;
                const newQuotaAfterWin = quotaBeforeWin + winAmount;

                console.log(`[老虎机] 准备添加额度 - 当前: ${quotaBeforeWin}, 奖金: ${winAmount}, 目标: ${newQuotaAfterWin}`);

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
                    console.error(`[老虎机] ❌ 添加额度失败 - 用户: ${user.username}, 奖金: $${(winAmount / 500000).toFixed(2)}, 错误: ${updateResult?.message || '未知错误'}`);
                    quotaUpdateFailed = true;
                    quotaUpdateError = '额度添加失败，请联系管理员补发奖金';
                } else {
                    // 验证额度是否真的更新了
                    const verifyUser = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
                    if (verifyUser.success && verifyUser.user) {
                        const actualQuota = verifyUser.user.quota;
                        console.log(`[老虎机] ✅ 验证额度 - 期望: ${newQuotaAfterWin}, 实际: ${actualQuota}`);

                        // 允许小范围误差（可能有其他操作）
                        if (Math.abs(actualQuota - newQuotaAfterWin) > winAmount) {
                            console.error(`[老虎机] ⚠️ 额度验证异常 - 期望: ${newQuotaAfterWin}, 实际: ${actualQuota}, 差异过大`);
                            quotaUpdateFailed = true;
                            quotaUpdateError = '额度验证失败，请联系管理员';
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
                console.error(`[老虎机] ❌ 惩罚时获取用户信息失败 - 用户: ${user.username}`);
                // 惩罚失败不阻止游戏继续
            } else {
                // 计算扣除后的额度，确保不会为负数
                const currentQuota = currentKyxUser.user.quota;
                const actualDeduction = Math.min(punishmentAmount, currentQuota);  // 最多扣到0
                const newQuotaAfterPunishment = currentQuota - actualDeduction;

                console.log(`[老虎机] ⚡ 准备扣除惩罚 - 当前: ${currentQuota}, 惩罚: ${actualDeduction}, 目标: ${newQuotaAfterPunishment}`);

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
                    console.error(`[老虎机] ❌ 惩罚扣除失败 - 用户: ${user.username}, 应扣: $${(actualDeduction / 500000).toFixed(2)}, 错误: ${updateResult?.message || '未知错误'}`);
                    // 惩罚失败，记录为0
                    winAmount = 0;
                } else {
                    // winAmount 设为负数，用于记录
                    winAmount = -actualDeduction;
                    console.log(`[老虎机] ⚡ 惩罚成功 - 用户: ${user.username}, 律师函数量: ${result.punishmentCount}, 扣除: $${(actualDeduction / 500000).toFixed(2)}`);
                }
            }

            // 如果是严重惩罚（3个及以上），禁止抽奖2.5天
            if (result.shouldBan) {
                banUserFromSlot(session.linux_do_id, 60);  // 60小时 = 2.5天
                console.log(`[老虎机] 🚫 严重惩罚 - 用户: ${user.username}, 禁止抽奖60小时（2.5天）`);
            }
        }

        // 如果奖励免费次数
        if (result.freeSpinAwarded) {
            addUserFreeSpins(session.linux_do_id, 1);
        }

        // 保存游戏记录
        // 优先使用session中的LinuxDo用户名（最新），其次使用数据库中的
        const linuxDoUsername = session.username || user.linux_do_username || null;
        saveGameRecord(
            session.linux_do_id,
            user.username,
            linuxDoUsername,
            betAmount,
            symbols,
            result.winType,
            result.multiplier,
            winAmount,
            result.freeSpinAwarded,
            isFreeSpin
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

        // 获取更新后的状态
        const kyxUserAfterResult = await getKyxUserById(user.kyx_user_id, adminConfigForWin.session, adminConfigForWin.new_api_user);
        const quotaAfter = (kyxUserAfterResult.success && kyxUserAfterResult.user) ? kyxUserAfterResult.user.quota : 0;

        const todaySpinsAfter = getUserTodaySpins(session.linux_do_id);
        const freeSpinsAfter = getUserFreeSpins(session.linux_do_id);
        const remainingSpinsAfter = Math.max(0, config.max_daily_spins - todaySpinsAfter);

        // 构造响应消息
        let message = '';

        if (result.winType === WinType.PUNISHMENT) {
            // 惩罚消息
            const deductedAmount = Math.abs(winAmount);
            message = `⚡ 律师函警告！收到 ${result.punishmentCount} 份律师函，扣除 $${(deductedAmount / 500000).toFixed(2)} 额度`;
            if (result.shouldBan) {
                message += ' | 🚫 已被禁止抽奖60小时（2.5天）';
            }
        } else {
            // 正常中奖消息
            message = WIN_TYPE_NAMES[result.winType];
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
                free_spins_remaining: freeSpinsAfter,
                quota_update_failed: quotaUpdateFailed  // 新增：标记额度更新是否失败
            },
            message,
            warning: quotaUpdateFailed ? quotaUpdateError : undefined  // 新增：警告信息
        });
    } catch (error) {
        console.error('旋转老虎机失败:', error);
        console.error('错误堆栈:', error instanceof Error ? error.stack : '无堆栈信息');
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
        const leaderboard = getLeaderboard(20); // 盈利榜也取20名（侧边栏）
        const lossLeaderboard = getLossLeaderboard(20); // 亏损榜取20名

        // 调试：检查排行榜数据
        console.log('[盈利榜] 前3名数据:', leaderboard.slice(0, 3).map(u => ({
            username: u.username,
            profit: (u.total_win - u.total_bet) / 500000
        })));
        console.log('[亏损榜] 前3名数据:', lossLeaderboard.slice(0, 3).map(u => ({
            username: u.username,
            profit: (u.total_win - u.total_bet) / 500000
        })));

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
        console.error('获取排行榜失败:', error);
        return c.json({ success: false, message: '服务器错误' }, 500);
    }
});

export default slot;

