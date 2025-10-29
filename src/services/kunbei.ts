/**
 * 坤呗借款系统服务层
 */

import { kunbeiQueries, userQueries } from '../database';
import type { KunbeiConfig, UserLoan, UserKunbeiStats, KunbeiGradientConfig } from '../types';
import { getUserQuota, deductQuota } from './kyx-api';

/**
 * 获取坤呗配置
 */
export function getKunbeiConfig(): KunbeiConfig {
    const config = kunbeiQueries.getConfig.get();

    if (!config) {
        // 返回默认配置
        return {
            id: 1,
            enabled: 1,
            max_loan_amount: 50000000,      // $100
            min_loan_amount: 5000000,       // $10
            repay_multiplier: 2.5,
            loan_duration_hours: 72,
            early_repay_discount: 0.025,    // 2.5%
            overdue_penalty_hours: 60,
            overdue_ban_advanced: 1,
            max_active_loans: 1,
            updated_at: Date.now()
        };
    }

    return config;
}

/**
 * 获取用户坤呗状态
 */
export function getUserKunbeiStatus(linuxDoId: string): {
    has_active_loan: boolean;
    active_loan: UserLoan | null;
    stats: UserKunbeiStats | null;
    can_borrow: boolean;
    ban_reason?: string;
    config: KunbeiConfig;
    max_loan_amount?: number;
} {
    const config = getKunbeiConfig();

    // 获取活跃借款
    const activeLoan = kunbeiQueries.getActiveLoan.get(linuxDoId);

    // 获取统计信息
    let stats = kunbeiQueries.getStats.get(linuxDoId);
    if (!stats) {
        stats = {
            linux_do_id: linuxDoId,
            total_borrowed: 0,
            total_repaid: 0,
            total_loans: 0,
            repaid_loans: 0,
            overdue_loans: 0,
            credit_score: 100,
            is_banned: 0,
            updated_at: Date.now()
        };
    }

    // 判断是否可以借款
    let can_borrow = true;
    let ban_reason: string | undefined;

    if (!config.enabled) {
        can_borrow = false;
        ban_reason = '坤呗功能已关闭';
    } else if (stats.is_banned) {
        can_borrow = false;
        ban_reason = '您已被禁用坤呗功能';
    } else if (stats.credit_score < 60) {
        can_borrow = false;
        ban_reason = '信用分过低，无法借款';
    } else if (activeLoan) {
        can_borrow = false;
        ban_reason = '您已有未还清的借款';
    }

    return {
        has_active_loan: !!activeLoan,
        active_loan: activeLoan,
        stats,
        can_borrow,
        ban_reason,
        config,
        max_loan_amount: calculateUserMaxLoanAmount(linuxDoId)
    };
}

/**
 * 计算用户的最大可借金额（基于梯度配置）
 */
export function calculateUserMaxLoanAmount(linuxDoId: string): number {
    // 获取用户当前额度
    const userQuota = getUserQuota(linuxDoId);
    if (!userQuota) return 0;
    
    // 获取所有激活的梯度配置
    const gradientConfigs = kunbeiQueries.getGradientConfigs.all();
    if (!gradientConfigs || gradientConfigs.length === 0) {
        // 如果没有梯度配置，使用默认配置
        const config = getKunbeiConfig();
        return config.max_loan_amount;
    }
    
    // 根据用户额度匹配梯度配置（从高优先级到低优先级）
    for (const gradient of gradientConfigs) {
        if (userQuota < gradient.quota_threshold) {
            return gradient.max_loan_amount;
        }
    }
    
    // 如果用户额度超过所有阈值，使用系统默认最大借款额度
    const config = getKunbeiConfig();
    return config.max_loan_amount;
}

/**
 * 获取所有梯度配置
 */
export function getAllGradientConfigs(): KunbeiGradientConfig[] {
    return kunbeiQueries.getAllGradientConfigs.all();
}

/**
 * 创建梯度配置
 */
export function createGradientConfig(config: {
    quota_threshold: number;
    max_loan_amount: number;
    priority: number;
    is_active: number;
}): { success: boolean; message: string; data?: any } {
    try {
        const now = Date.now();
        kunbeiQueries.insertGradientConfig.run(
            config.quota_threshold,
            config.max_loan_amount,
            config.priority,
            config.is_active,
            now,
            now
        );
        return { success: true, message: '梯度配置创建成功' };
    } catch (error) {
        console.error('[坤呗] 创建梯度配置失败:', error);
        return { success: false, message: '创建失败：' + error.message };
    }
}

/**
 * 更新梯度配置
 */
export function updateGradientConfig(
    id: number,
    config: {
        quota_threshold: number;
        max_loan_amount: number;
        priority: number;
        is_active: number;
    }
): { success: boolean; message: string } {
    try {
        kunbeiQueries.updateGradientConfig.run(
            config.quota_threshold,
            config.max_loan_amount,
            config.priority,
            config.is_active,
            Date.now(),
            id
        );
        return { success: true, message: '梯度配置更新成功' };
    } catch (error) {
        console.error('[坤呗] 更新梯度配置失败:', error);
        return { success: false, message: '更新失败：' + error.message };
    }
}

/**
 * 删除梯度配置
 */
export function deleteGradientConfig(id: number): { success: boolean; message: string } {
    try {
        kunbeiQueries.deleteGradientConfig.run(id);
        return { success: true, message: '梯度配置删除成功' };
    } catch (error) {
        console.error('[坤呗] 删除梯度配置失败:', error);
        return { success: false, message: '删除失败：' + error.message };
    }
}

/**
 * 申请借款
 */
export function borrowLoan(
    linuxDoId: string,
    username: string,
    amount: number
): { success: boolean; message: string; data?: any; is_first_today?: boolean } {
    const config = getKunbeiConfig();
    const now = Date.now();

    // 1. 检查系统是否启用
    if (!config.enabled) {
        return { success: false, message: '坤呗功能已关闭' };
    }

    // 2. 验证金额范围（使用梯度配置）
    const maxLoanAmount = calculateUserMaxLoanAmount(linuxDoId);
    if (amount < config.min_loan_amount || amount > maxLoanAmount) {
        return {
            success: false,
            message: `借款金额必须在 $${(config.min_loan_amount / 500000).toFixed(0)} - $${(maxLoanAmount / 500000).toFixed(0)} 之间`
        };
    }

    // 3. 检查用户状态
    const status = getUserKunbeiStatus(linuxDoId);
    if (!status.can_borrow) {
        return { success: false, message: status.ban_reason || '无法借款' };
    }

    // 🔥 检查是否是今日首次借款
    const today = new Date().toISOString().split('T')[0];
    const stats = kunbeiQueries.getStats.get(linuxDoId);
    const isFirstToday = !stats || stats.last_borrow_date !== today;

    // 4. 计算还款金额和到期时间
    const repayAmount = Math.floor(amount * config.repay_multiplier);
    const dueAt = now + (config.loan_duration_hours * 3600000);

    // 5. 创建借款记录
    kunbeiQueries.insertLoan.run(
        linuxDoId,
        username,
        amount,
        repayAmount,
        'active',
        now,
        dueAt,
        now,
        now
    );

    // 6. 更新统计 + 设置buff（如果是首次）
    kunbeiQueries.upsertStats.run(
        linuxDoId, amount, 0, 1, 0, 0,
        stats?.credit_score || 100, 0,
        today,                    // last_borrow_date
        isFirstToday ? 1 : 0,    // has_daily_buff
        2.5,                      // buff_multiplier
        0,                        // buff_used（未使用）
        now,
        // ON CONFLICT 部分
        amount, 0, 1, 0, 0,
        stats?.credit_score || 100,
        today,
        isFirstToday ? 1 : 0,
        2.5,
        0,
        now
    );

    console.log(`[坤呗] 用户 ${username} 借款 $${(amount / 500000).toFixed(2)}${isFirstToday ? '（今日首借，已获得抽奖buff×2.5）' : ''}`);

    return {
        success: true,
        message: isFirstToday
            ? '坤呗到账，祝您一发入魂 💸'
            : `借款成功！$${(amount / 500000).toFixed(2)} 已到账`,
        data: {
            loan_amount: amount,
            repay_amount: repayAmount,
            due_at: dueAt,
            early_repay_amount: Math.floor(repayAmount * (1 - config.early_repay_discount))
        },
        is_first_today: isFirstToday
    };
}

/**
 * 还款
 */
export function repayLoan(
    linuxDoId: string,
    loanId: number
): { success: boolean; message: string; data?: any } {
    const config = getKunbeiConfig();
    const now = Date.now();

    // 1. 获取借款信息
    const loan = kunbeiQueries.getLoanById.get(loanId);

    if (!loan) {
        return { success: false, message: '借款不存在' };
    }

    if (loan.linux_do_id !== linuxDoId) {
        return { success: false, message: '无权操作此借款' };
    }

    if (loan.status !== 'active' && loan.status !== 'overdue') {
        return { success: false, message: '该借款已处理' };
    }

    // 2. 计算实际还款金额
    let actualRepayAmount = loan.repay_amount;
    let cashback = 0;
    let isEarly = false;

    if (now < loan.due_at) {
        // 提前还款，享受优惠
        isEarly = true;
        cashback = Math.floor(loan.repay_amount * config.early_repay_discount);
        actualRepayAmount = loan.repay_amount - cashback;
    }

    // 3. 更新借款状态
    const overduePenaltyUntil = loan.status === 'overdue'
        ? now + (config.overdue_penalty_hours * 3600000)
        : null;

    kunbeiQueries.updateLoanStatus.run(
        'repaid',
        actualRepayAmount,
        now,
        overduePenaltyUntil,
        now,
        loanId
    );

    // 4. 更新统计和信用分
    const stats = kunbeiQueries.getStats.get(linuxDoId);
    const currentScore = stats?.credit_score || 100;
    let newScore = currentScore;

    if (isEarly) {
        newScore = Math.min(100, currentScore + 10);  // 提前还款+10分
    } else if (loan.status === 'overdue') {
        newScore = Math.max(0, currentScore - 5);     // 逾期还款-5分（已在逾期时扣过）
    } else {
        newScore = Math.min(100, currentScore + 5);   // 按时还款+5分
    }

    kunbeiQueries.upsertStats.run(
        linuxDoId, 0, actualRepayAmount, 0, 1, 0, newScore, 0,
        stats?.last_borrow_date || null,  // last_borrow_date
        0,                                 // has_daily_buff
        2.5,                               // buff_multiplier
        0,                                 // buff_used
        now,
        // ON CONFLICT 部分
        0, actualRepayAmount, 0, 1, 0, newScore,
        stats?.last_borrow_date || null,
        0,
        2.5,
        0,
        now
    );

    console.log(`[坤呗] 用户 ${loan.username} 还款 $${(actualRepayAmount / 500000).toFixed(2)}${cashback > 0 ? `（返现 $${(cashback / 500000).toFixed(2)}）` : ''}`);

    return {
        success: true,
        message: cashback > 0
            ? '讲信用的坤！返现已到账～'
            : loan.status === 'overdue'
                ? '还款成功！但仍需承受逾期惩罚'
                : '还款成功！',
        data: {
            original_amount: loan.repay_amount,
            actual_amount: actualRepayAmount,
            cashback: cashback,
            credit_score_change: newScore - currentScore,
            new_credit_score: newScore,
            overdue_penalty_until: overduePenaltyUntil
        }
    };
}

/**
 * 检查并处理逾期借款
 */
export async function checkOverdueLoans(): Promise<number> {
    const config = getKunbeiConfig();
    const now = Date.now();
    const activeLoans = kunbeiQueries.getActiveLoans.all();

    let overdueCount = 0;

    for (const loan of activeLoans) {
        if (loan.due_at < now && loan.status === 'active') {
            // 标记为逾期
            const penaltyUntil = now + (config.overdue_penalty_hours * 3600000);

            kunbeiQueries.updateLoanStatus.run(
                'overdue',
                null,
                null,
                penaltyUntil,
                now,
                loan.id
            );

            // 降低信用分
            kunbeiQueries.updateCreditScore.run(
                loan.linux_do_id,
                100,
                now,
                -10,
                now
            );

            // 更新逾期统计
            const overdueStats = kunbeiQueries.getStats.get(loan.linux_do_id);
            kunbeiQueries.upsertStats.run(
                loan.linux_do_id, 0, 0, 0, 0, 1, 90, 0,
                overdueStats?.last_borrow_date || null,  // last_borrow_date
                0,                                        // has_daily_buff
                2.5,                                      // buff_multiplier
                0,                                        // buff_used
                now,
                // ON CONFLICT 部分
                0, 0, 0, 0, 1, 90,
                overdueStats?.last_borrow_date || null,
                0,
                2.5,
                0,
                now
            );

            overdueCount++;
            console.log(`[坤呗] 借款逾期 - 用户: ${loan.username}, 借款ID: ${loan.id}, 惩罚至: ${new Date(penaltyUntil).toLocaleString()}`);
            
            // 🔥 如果配置启用了逾期扣除所有额度
            if (config.deduct_all_quota_on_overdue) {
                const userQuota = getUserQuota(loan.linux_do_id);
                if (userQuota > 0) {
                    const result = await deductQuota(loan.linux_do_id, userQuota);
                    if (result.success) {
                        console.log(`[坤呗] 逾期扣除用户 ${loan.username} 所有额度 $${(userQuota / 500000).toFixed(2)}`);
                    } else {
                        console.error(`[坤呗] 逾期扣除额度失败: ${result.message}`);
                    }
                }
            }
        }
    }

    if (overdueCount > 0) {
        console.log(`[坤呗] 本次检查处理了 ${overdueCount} 笔逾期借款`);
    }

    return overdueCount;
}

/**
 * 检查用户是否被逾期惩罚禁止进入高级场
 */
export function isBannedFromAdvanced(linuxDoId: string): { banned: boolean; until?: number } {
    const loans = kunbeiQueries.getUserLoans.all(linuxDoId);
    const now = Date.now();

    for (const loan of loans) {
        if (loan.overdue_penalty_until && loan.overdue_penalty_until > now) {
            return {
                banned: true,
                until: loan.overdue_penalty_until
            };
        }
    }

    return { banned: false };
}

/**
 * 获取借款详细信息
 */
export function getLoanDetails(loanId: number): UserLoan | null {
    return kunbeiQueries.getLoanById.get(loanId);
}

/**
 * 管理员豁免借款
 */
export function forgiveLoan(loanId: number): { success: boolean; message: string } {
    const loan = kunbeiQueries.getLoanById.get(loanId);

    if (!loan) {
        return { success: false, message: '借款不存在' };
    }

    if (loan.status === 'repaid') {
        return { success: false, message: '该借款已还清' };
    }

    const now = Date.now();

    // 标记为已还款（豁免）
    kunbeiQueries.updateLoanStatus.run(
        'repaid',
        0,  // 豁免，实际还款为0
        now,
        null,
        now,
        loanId
    );

    // 更新统计（不计入还款金额，但计入还款次数）
    const stats = kunbeiQueries.getStats.get(loan.linux_do_id);
    const today = new Date().toISOString().split('T')[0];

    kunbeiQueries.upsertStats.run(
        loan.linux_do_id, 0, 0, 0, 1, 0,
        stats?.credit_score || 100, 0,
        stats?.last_borrow_date || null,    // last_borrow_date
        0,                                   // has_daily_buff
        2.5,                                 // buff_multiplier  
        0,                                   // buff_used
        now,
        // ON CONFLICT 部分
        0, 0, 0, 1, 0,
        stats?.credit_score || 100,
        stats?.last_borrow_date || null,
        0,
        2.5,
        0,
        now
    );

    console.log(`[坤呗] 管理员豁免借款 - 用户: ${loan.username}, 借款ID: ${loanId}`);

    return { success: true, message: '已豁免该笔借款' };
}

/**
 * 获取并使用坤呗buff
 */
export function getAndUseBuff(linuxDoId: string): number {
    const stats = kunbeiQueries.checkBuff.get(linuxDoId);

    if (stats && stats.has_daily_buff === 1 && stats.buff_used === 0) {
        // 有buff且未使用，标记为已使用
        const now = Date.now();
        kunbeiQueries.useBuff.run(now, linuxDoId);

        console.log(`[坤呗Buff] 用户 ${linuxDoId} 使用坤呗buff×${stats.buff_multiplier}`);
        return stats.buff_multiplier;
    }

    return 1.0;  // 无buff，返回1倍
}

