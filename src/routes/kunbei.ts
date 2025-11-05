/**
 * 坤呗借款系统路由
 */

import { Hono } from 'hono';
import { getCookie, getSession } from '../utils';
import logger from '../utils/logger';
import type { SessionData } from '../types';
import {
    getKunbeiConfig,
    getUserKunbeiStatus,
    getAllGradientConfigs,
    borrowLoan,
    repayLoan,
    checkOverdueLoans,
    getLoanDetails,
    forgiveLoan,
    clearOverduePenalty,
} from '../services/kunbei';
import { kunbeiQueries, userQueries, adminQueries } from '../database';
import { addQuota, deductQuota, getKyxUserById } from '../services/kyx-api';
import { checkAndUnlockAchievement, updateAchievementProgress } from '../services/achievement';

const kunbei = new Hono();

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
 * 获取坤呗配置
 */
kunbei.get('/config', requireAuth, async (c) => {
    try {
        const config = getKunbeiConfig();

        return c.json({
            success: true,
            data: {
                enabled: config.enabled === 1,
                max_loan_amount: config.max_loan_amount,
                min_loan_amount: config.min_loan_amount,
                max_loan_amount_usd: (config.max_loan_amount / 500000).toFixed(0),
                min_loan_amount_usd: (config.min_loan_amount / 500000).toFixed(0),
                repay_multiplier: config.repay_multiplier,
                loan_duration_hours: config.loan_duration_hours,
                early_repay_discount: config.early_repay_discount,
                overdue_penalty_hours: config.overdue_penalty_hours,
                overdue_deduct_multiplier: config.overdue_deduct_multiplier || 2.5,
                max_daily_borrows: config.max_daily_borrows || 3
            }
        });
    } catch (error: any) {
        console.error('[坤呗] 获取配置失败:', error);
        return c.json({ success: false, message: '获取配置失败' }, 500);
    }
});

/**
 * 获取用户坤呗状态
 */
kunbei.get('/status', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;

        // 立即检查逾期状态（确保及时更新）
        await checkOverdueLoans();

        // 获取用户信息
        const user = userQueries.get.get(session.linux_do_id!);
        if (user) {
            // 获取管理员配置
            const adminConfig = adminQueries.get.get();
            if (adminConfig) {
                // 尝试加载用户额度信息到缓存（不阻塞主流程）
                getKyxUserById(
                    user.kyx_user_id,
                    adminConfig.session,
                    adminConfig.new_api_user
                ).catch(err => {
                    console.warn('[坤呗] 预加载用户额度信息失败:', err.message);
                });
            }
        }

        const status = getUserKunbeiStatus(session.linux_do_id!);

        // 获取梯度配置
        const gradientConfigs = getAllGradientConfigs();

        return c.json({
            success: true,
            data: {
                ...status,
                gradient_configs: gradientConfigs
            }
        });
    } catch (error: any) {
        console.error('[坤呗] 获取状态失败:', error);
        return c.json({ success: false, message: '获取状态失败' }, 500);
    }
});

/**
 * 申请借款
 */
kunbei.post('/borrow', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const { amount } = await c.req.json();

        if (!amount || typeof amount !== 'number') {
            return c.json({ success: false, message: '参数错误' }, 400);
        }

        // 立即检查逾期状态（确保借款前系统状态最新）
        await checkOverdueLoans();

        // 获取用户信息
        const user = userQueries.get.get(session.linux_do_id!);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 确保用户额度信息已加载到缓存（解决缓存未命中问题）
        const kyxUserResult = await getKyxUserById(
            user.kyx_user_id,
            adminConfig.session,
            adminConfig.new_api_user
        );

        if (!kyxUserResult.success || !kyxUserResult.user) {
            console.error('[坤呗] 无法获取用户额度信息:', kyxUserResult.message);
            return c.json({
                success: false,
                message: '获取用户额度信息失败，请稍后重试'
            }, 500);
        }

        // 🔥 关键优化：先验证借款资格，但不创建记录
        console.log('[坤呗] 步骤1：验证借款资格...');
        const validationResult = await borrowLoan(session.linux_do_id!, session.username!, amount);

        if (!validationResult.success) {
            console.error('[坤呗] 借款资格验证失败:', validationResult.message);
            return c.json(validationResult, 400);
        }

        // 🔥 步骤2：先增加用户额度（关键操作，使用增强重试）
        console.log('[坤呗] 步骤2：增加用户额度...');
        const quotaResult = await addQuota(
            user.kyx_user_id,
            amount,
            adminConfig.session,
            adminConfig.new_api_user,
            `坤呗借款-${session.username}`,
            5  // 使用5次重试，确保成功率
        );

        // 🔥 如果额度增加失败，需要回滚借款记录
        if (!quotaResult.success) {
            console.error('[坤呗] 额度增加失败，准备回滚借款记录:', quotaResult.message);

            // 查找刚刚创建的借款记录并删除
            const activeLoan = kunbeiQueries.getActiveLoan.get(session.linux_do_id!);
            if (activeLoan) {
                console.log('[坤呗] 回滚：删除借款记录 ID =', activeLoan.id);
                kunbeiQueries.deleteLoan.run(activeLoan.id);

                // 回滚统计数据：减少借款次数和总借款金额
                const stats = kunbeiQueries.getStats.get(session.linux_do_id!);
                if (stats) {
                    // 如果这是第一笔借款，重置所有统计
                    if (stats.total_loans === 1) {
                        kunbeiQueries.upsertStats.run(
                            session.linux_do_id!,
                            0, 0, 0, 0, 0,  // 重置所有计数
                            stats.credit_score,
                            0,
                            null,  // 清除今日借款日期
                            0,     // 清除buff
                            2.5,
                            0,
                            Date.now(),
                            // ON CONFLICT 部分：直接设置为0
                            -stats.total_borrowed,  // 回滚到0
                            0,
                            -stats.total_loans,     // 回滚到0
                            0,
                            0,
                            stats.credit_score,
                            null,
                            0,
                            2.5,
                            0,
                            Date.now()
                        );
                    } else {
                        // 否则只减少相应的计数
                        kunbeiQueries.upsertStats.run(
                            session.linux_do_id!,
                            0, 0, 0, 0, 0,
                            stats.credit_score,
                            0,
                            stats.last_borrow_date,  // 保持原有日期
                            validationResult.is_first_today ? 0 : stats.has_daily_buff,  // 如果是首次借款才清除buff
                            2.5,
                            0,
                            Date.now(),
                            // ON CONFLICT 部分
                            -amount,  // 减少借款金额
                            0,
                            -1,       // 减少借款次数
                            0,
                            0,
                            stats.credit_score,
                            stats.last_borrow_date,
                            validationResult.is_first_today ? 0 : stats.has_daily_buff,
                            2.5,
                            0,
                            Date.now()
                        );
                    }
                }

                console.log('[坤呗] ✅ 借款记录和统计数据已回滚');
            }

            // 返回更友好的错误信息
            const errorMsg = quotaResult.message || '未知错误';
            if (errorMsg.includes('429') || errorMsg.includes('繁忙')) {
                return c.json({
                    success: false,
                    message: '系统繁忙，请稍后再试（建议30秒后重试）'
                }, 503);
            } else if (errorMsg.includes('超时')) {
                return c.json({
                    success: false,
                    message: '网络超时，请检查网络连接后重试'
                }, 504);
            } else {
                return c.json({
                    success: false,
                    message: `借款失败：${errorMsg}。如多次失败，请联系管理员。`
                }, 500);
            }
        }

        console.log('[坤呗] ✅ 借款成功 - 用户:', session.username, '金额: $', (amount / 500000).toFixed(2));

        // 🏆 坤呗借款成就
        try {
            await checkAndUnlockAchievement(session.linux_do_id!, 'first_kunbei');
        } catch (achievementError) {
            console.error('[成就系统] 检查借款成就时出错:', achievementError);
        }

        return c.json(validationResult);
    } catch (error: any) {
        console.error('[坤呗] 借款异常:', error);
        return c.json({ success: false, message: '借款失败: ' + error.message }, 500);
    }
});

/**
 * 还款
 */
kunbei.post('/repay/:loanId', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const loanId = parseInt(c.req.param('loanId'));

        if (!loanId) {
            return c.json({ success: false, message: '参数错误' }, 400);
        }

        // 获取借款信息
        const loan = getLoanDetails(loanId);
        if (!loan || loan.linux_do_id !== session.linux_do_id!) {
            return c.json({ success: false, message: '借款不存在或无权操作' }, 404);
        }

        // 计算实际还款金额
        const config = getKunbeiConfig();
        const now = Date.now();
        let actualRepayAmount = loan.repay_amount;

        if (now < loan.due_at) {
            // 提前还款优惠
            const cashback = Math.floor(loan.repay_amount * config.early_repay_discount);
            actualRepayAmount = loan.repay_amount - cashback;
        }

        // 检查用户额度
        const user = userQueries.get.get(session.linux_do_id!);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

        // 扣除用户额度
        const deductResult = await deductQuota(
            user.kyx_user_id,
            actualRepayAmount,
            adminConfig.session,
            adminConfig.new_api_user,
            `坤呗还款-${session.username}`
        );

        if (!deductResult.success) {
            return c.json({
                success: false,
                message: `额度不足: 需要 $${(actualRepayAmount / 500000).toFixed(2)}`
            }, 400);
        }

        // 执行还款
        const result = repayLoan(session.linux_do_id!, loanId);

        // 🏆 坤呗还款成就（只在成功时触发）
        if (result.success) {
            try {
                // 按时还款成就
                await updateAchievementProgress(session.linux_do_id!, 'repay_5_times', 1);

                // 提前还款成就（判断是否提前）
                if (now < loan.due_at) {
                    await updateAchievementProgress(session.linux_do_id!, 'early_repay_3', 1);
                }

                // 信用卡神成就（信用分达到100）
                if (result.data && result.data.new_credit_score >= 100) {
                    await checkAndUnlockAchievement(session.linux_do_id!, 'credit_100');
                }
            } catch (achievementError) {
                console.error('[成就系统] 检查还款成就时出错:', achievementError);
            }
        }

        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗] 还款失败:', error);
        return c.json({ success: false, message: '还款失败: ' + error.message }, 500);
    }
});

/**
 * 获取我的借款记录
 */
kunbei.get('/my-loans', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const loans = kunbeiQueries.getUserLoans.all(session.linux_do_id!);
        const stats = kunbeiQueries.getStats.get(session.linux_do_id!);

        return c.json({
            success: true,
            data: {
                loans: loans.map(loan => ({
                    ...loan,
                    loan_amount_usd: (loan.loan_amount / 500000).toFixed(2),
                    repay_amount_usd: (loan.repay_amount / 500000).toFixed(2),
                    actual_repay_amount_usd: loan.actual_repay_amount
                        ? (loan.actual_repay_amount / 500000).toFixed(2)
                        : null
                })),
                stats: stats || {
                    total_borrowed: 0,
                    total_repaid: 0,
                    total_loans: 0,
                    repaid_loans: 0,
                    overdue_loans: 0,
                    credit_score: 100
                }
            }
        });
    } catch (error: any) {
        console.error('[坤呗] 获取借款记录失败:', error);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 定时检查逾期借款（每6小时执行，作为兜底机制）
 * 主要依赖用户操作时的实时检查（借款、还款、游戏等）
 */
setInterval(() => {
    try {
        logger.info('定时任务', '🕐 执行坤呗逾期检查（兜底机制）...');
        checkOverdueLoans();
    } catch (error: any) {
        logger.error('定时任务', `❌ 坤呗逾期检查失败: ${error.message}`);
    }
}, 21600000);  // 每6小时（从1小时延长，减少日志频率）

/**
 * 检查用户是否有buff
 */
kunbei.get('/check-buff', requireAuth, async (c) => {
    try {
        const session = c.get('session') as SessionData;
        const stats = kunbeiQueries.checkBuff.get(session.linux_do_id!);
        
        const hasBuff = stats && stats.has_daily_buff === 1 && stats.buff_used === 0;
        
        return c.json({
            success: true,
            data: {
                has_buff: hasBuff,
                buff_multiplier: hasBuff ? stats.buff_multiplier : 1.0
            }
        });
    } catch (error: any) {
        console.error('[坤呗] 检查buff失败:', error);
        return c.json({ success: false, message: '检查buff失败' }, 500);
    }
});

export default kunbei;

