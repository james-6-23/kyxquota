/**
 * 坤呗借款系统路由
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import type { SessionData } from '../types';
import {
    getKunbeiConfig,
    getUserKunbeiStatus,
    borrowLoan,
    repayLoan,
    checkOverdueLoans,
    getLoanDetails,
    forgiveLoan,
} from '../services/kunbei';
import { kunbeiQueries, userQueries } from '../database';
import { addQuota, deductQuota } from '../services/kyx-api';
import { adminQueries } from '../database';

const kunbei = new Hono();

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
                overdue_penalty_hours: config.overdue_penalty_hours
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
        const status = getUserKunbeiStatus(session.linux_do_id!);

        return c.json({
            success: true,
            data: status
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

        // 调用借款服务
        const result = borrowLoan(session.linux_do_id!, session.username!, amount);

        if (!result.success) {
            return c.json(result, 400);
        }

        // 增加用户额度
        const user = userQueries.get.get(session.linux_do_id!);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            return c.json({ success: false, message: '系统配置未找到' }, 500);
        }

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
 * 定时检查逾期借款（每小时执行）
 */
setInterval(() => {
    try {
        checkOverdueLoans();
    } catch (error) {
        console.error('[坤呗] 逾期检查失败:', error);
    }
}, 3600000);  // 每小时

export default kunbei;

