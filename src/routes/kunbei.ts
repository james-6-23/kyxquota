/**
 * 坤呗借款系统路由
 */

import { Hono } from 'hono';
import { getCookie, getSession } from '../utils';
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

        // 调用借款服务
        const result = borrowLoan(session.linux_do_id!, session.username!, amount);

        if (!result.success) {
            return c.json(result, 400);
        }

        // 增加用户额度
        const quotaResult = await addQuota(
            user.kyx_user_id,
            amount,
            adminConfig.session,
            adminConfig.new_api_user,
            `坤呗借款-${session.username}`
        );

        if (!quotaResult.success) {
            return c.json({
                success: false,
                message: `借款失败: ${quotaResult.message}`
            }, 500);
        }

        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗] 借款失败:', error);
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
 * 定时检查逾期借款（每5分钟执行）
 */
setInterval(() => {
    try {
        checkOverdueLoans();
    } catch (error) {
        console.error('[坤呗] 逾期检查失败:', error);
    }
}, 300000);  // 每5分钟

export default kunbei;

