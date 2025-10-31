/**
 * 坤呗借款系统服务层
 */

import { kunbeiQueries, userQueries, adminQueries } from '../database';
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

    // 如果额度为0，可能是缓存未命中，尝试获取梯度配置
    if (!userQuota || userQuota === 0) {
        // 获取所有激活的梯度配置
        const gradientConfigs = kunbeiQueries.getGradientConfigs.all();
        if (gradientConfigs && gradientConfigs.length > 0) {
            // 按阈值从低到高排序，返回最低档（阈值最小的）
            const sortedConfigs = [...gradientConfigs].sort((a, b) => a.quota_threshold - b.quota_threshold);
            return sortedConfigs[0].max_loan_amount;
        }
        // 如果没有梯度配置，使用默认配置
        const config = getKunbeiConfig();
        return config.max_loan_amount;
    }

    // 获取所有激活的梯度配置
    const gradientConfigs = kunbeiQueries.getGradientConfigs.all();
    if (!gradientConfigs || gradientConfigs.length === 0) {
        // 如果没有梯度配置，使用默认配置
        const config = getKunbeiConfig();
        return config.max_loan_amount;
    }

    // 按额度阈值从低到高排序
    const sortedGradients = [...gradientConfigs].sort((a, b) => a.quota_threshold - b.quota_threshold);

    // 找到适用的梯度
    // 从低到高遍历，找到用户额度能达到的最高档
    let applicableGradient = sortedGradients[0]; // 默认使用最低档

    for (const gradient of sortedGradients) {
        if (userQuota >= gradient.quota_threshold) {
            applicableGradient = gradient; // 更新为更高档
        } else {
            break; // 遇到第一个达不到的阈值就停止
        }
    }

    return applicableGradient.max_loan_amount;
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

    // 🔥 检查是否有活跃借款（必须先还款才能再借）
    const activeLoan = kunbeiQueries.getActiveLoan.get(linuxDoId);
    if (activeLoan) {
        return { success: false, message: '您有未还清的借款，请先还款后再借' };
    }

    // 🔥 检查是否有逾期借款（如果有逾期，今天不能借）
    const { getTodayDate } = await import('./slot');
    const today = getTodayDate();
    const overdueLoans = kunbeiQueries.getUserLoans.all(linuxDoId);
    const hasOverdueToday = overdueLoans.some(loan => {
        if (loan.status !== 'overdue') return false;
        // 检查逾期发生日期（到期日）是否是今天（使用北京时间）
        const dueDate = new Date(loan.due_at).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const [year, month, day] = dueDate.split('/');
        const dueDateStr = `${year}-${month}-${day}`;
        return dueDateStr === today;
    });
    
    if (hasOverdueToday) {
        return { success: false, message: '您今日有逾期记录，明天才能借款' };
    }

    // 🔥 检查今日借款次数
    const todayBorrowCount = kunbeiQueries.getTodayBorrowCount.get(linuxDoId, today);
    const borrowedToday = todayBorrowCount?.count || 0;
    const maxDaily = config.max_daily_borrows || 3;
    
    if (borrowedToday >= maxDaily) {
        return { success: false, message: `今日借款次数已达上限（${maxDaily}次）` };
    }

    // 🔥 检查是否是今日首次借款
    const stats = kunbeiQueries.getStats.get(linuxDoId);
    const isFirstToday = !stats || stats.last_borrow_date !== today;

    // 4. 计算还款金额、逾期扣除倍数和到期时间
    const repayAmount = Math.floor(amount * config.repay_multiplier);
    const dueAt = now + (config.loan_duration_hours * 3600000);
    const deductMultiplier = config.overdue_deduct_multiplier || 2.5;
    const deductAmount = Math.floor(repayAmount * deductMultiplier);

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

    console.log(`[坤呗] 用户 ${username} 借款记录已创建 - 金额: $${(amount / 500000).toFixed(2)}${isFirstToday ? '（今日首借，已获得抽奖buff×2.5）' : ''}`);
    
    // 7. 💰 增加用户额度（借款到账）
    // 注意：这里不能使用 async/await，因为函数签名是同步的
    // 额度增加在前端调用API成功后由前端代码处理（updateSlotUI）
    // 这里只记录借款关系，实际额度增加由调用方负责
    console.log(`[坤呗] 💡 提示：借款金额需要由调用方增加到用户额度`);
    console.log(`[坤呗] 📊 逾期警告：到期时将从用户额度中扣除 $${(deductAmount / 500000).toFixed(2)}（应还 $${(repayAmount / 500000).toFixed(2)} × ${deductMultiplier}倍）`);

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

            // 🔥 计算逾期扣款金额（欠款金额 * 倍数）
            const deductMultiplier = config.overdue_deduct_multiplier || 2.5;
            const deductAmount = Math.floor(loan.repay_amount * deductMultiplier);
            
            // 🔥 获取用户信息和管理员配置
            const user = userQueries.get.get(loan.linux_do_id);
            if (!user) {
                console.error(`[坤呗] 用户不存在: ${loan.linux_do_id}`);
                continue;
            }
            
            const adminConfig = adminQueries.get.get();
            if (!adminConfig) {
                console.error(`[坤呗] 管理员配置未找到`);
                continue;
            }
            
            // 🔥 获取用户当前额度（实时查询，与初级场/高级场/至尊场保持一致）
            console.log(`[坤呗逾期] 开始获取用户额度 - 用户: ${loan.username} (ID: ${user.kyx_user_id})`);
            const { getKyxUserById } = await import('./kyx-api');
            const kyxUserResult = await getKyxUserById(user.kyx_user_id, adminConfig.session, adminConfig.new_api_user);
            
            let userQuota = 0;
            if (kyxUserResult.success && kyxUserResult.user) {
                userQuota = kyxUserResult.user.quota;
                console.log(`[坤呗逾期] ✅ 获取用户额度成功 - 用户: ${loan.username}, 当前额度: $${(userQuota / 500000).toFixed(2)}`);
            } else {
                console.error(`[坤呗逾期] ❌ 获取用户额度失败 - 用户: ${loan.username}, kyx_user_id: ${user.kyx_user_id}`);
                console.error(`[坤呗逾期] 错误详情:`, kyxUserResult);
            }
            
            // 实际扣款金额：不超过用户额度，不扣为负数
            let actualDeductAmount = Math.min(deductAmount, Math.max(0, userQuota));
            let autoDeductedAmount = 0;
            
            console.log(`[坤呗逾期] 📊 扣款计算 - 用户: ${loan.username}`);
            console.log(`[坤呗逾期]   - 应还金额: $${(loan.repay_amount / 500000).toFixed(2)}`);
            console.log(`[坤呗逾期]   - 扣除倍数: ${deductMultiplier}x`);
            console.log(`[坤呗逾期]   - 应扣金额: $${(deductAmount / 500000).toFixed(2)}`);
            console.log(`[坤呗逾期]   - 用户额度: $${(userQuota / 500000).toFixed(2)}`);
            console.log(`[坤呗逾期]   - 实际扣款: $${(actualDeductAmount / 500000).toFixed(2)}`);
            
            // 如果有额度可扣，执行扣款
            if (actualDeductAmount > 0) {
                // 🔥 计算扣除后的新余额
                const newQuotaAfterDeduct = userQuota - actualDeductAmount;
                
                // 🔥 确保余额不会为负数（双重保险）
                if (newQuotaAfterDeduct < 0) {
                    console.error(`[坤呗] 计算错误：扣款后余额为负 - 用户: ${loan.username}, 当前: ${userQuota}, 扣除: ${actualDeductAmount}`);
                    actualDeductAmount = userQuota; // 只扣除可用余额
                }
                
                // 🔥 使用统一的扣款方式（与老虎机保持一致）
                const { updateKyxUserQuota } = await import('./kyx-api');
                const deductResult = await updateKyxUserQuota(
                    user.kyx_user_id,
                    Math.max(0, newQuotaAfterDeduct),  // 🔥 确保不为负数
                    adminConfig.session,
                    adminConfig.new_api_user,
                    user.username,  // 🔥 使用最新的公益站用户名（与初级场/至尊场保持一致）
                    kyxUserResult.user.group || 'default'
                );
                
                if (deductResult && deductResult.success) {
                    autoDeductedAmount = actualDeductAmount;
                    console.log(`[坤呗] 逾期扣款成功 - 用户: ${loan.username}, 应还: $${(loan.repay_amount / 500000).toFixed(2)}, 扣款倍数: ${deductMultiplier}x, 当前额度: $${(userQuota / 500000).toFixed(2)}, 自动扣除: $${(actualDeductAmount / 500000).toFixed(2)}, 剩余: $${(Math.max(0, newQuotaAfterDeduct) / 500000).toFixed(2)}`);
                    
                    // 🔥 将逾期扣款记录到老虎机亏损统计中（影响亏损榜排名）
                    try {
                        const { slotQueries } = await import('../database');
                        const { getTodayDate } = await import('./slot');
                        const today = getTodayDate();
                        
                        // 记录为今日亏损
                        slotQueries.upsertTodayStats.run(
                            loan.linux_do_id, 0, 0, -actualDeductAmount, 0, 0, today,
                            0, 0, -actualDeductAmount, 0, 0, now
                        );
                        
                        // 记录为总亏损
                        slotQueries.upsertTotalStats.run(
                            loan.linux_do_id, 0, 0, -actualDeductAmount, 0, 0,
                            0, 0, -actualDeductAmount, 0, 0, now
                        );
                        
                        console.log(`[坤呗] 已记录逾期扣款到亏损统计 - 用户: ${loan.username}, 金额: $${(actualDeductAmount / 500000).toFixed(2)}`);
                    } catch (error) {
                        console.error(`[坤呗] 记录亏损统计失败:`, error);
                    }
                } else {
                    console.error(`[坤呗] 逾期扣除额度失败 - 用户: ${loan.username}, 错误: ${deductResult?.message || '未知错误'}`);
                }
            } else {
                console.log(`[坤呗] 逾期但用户额度不足 - 用户: ${loan.username}, 当前额度: $${(userQuota / 500000).toFixed(2)}, 应扣: $${(deductAmount / 500000).toFixed(2)}`);
            }

            // 🔥 计算扣款后余额（不为负数）
            const balanceAfterDeduct = actualDeductAmount > 0 ? Math.max(0, userQuota - actualDeductAmount) : 0;
            
            // 更新借款状态（使用新的查询）
            kunbeiQueries.updateLoanOverdue.run(
                'overdue',
                penaltyUntil,
                autoDeductedAmount,
                balanceAfterDeduct,  // 🔥 记录扣款后余额
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
            console.log(`[坤呗] 借款逾期处理完成 - 用户: ${loan.username}, 借款ID: ${loan.id}, 惩罚至: ${new Date(penaltyUntil).toLocaleString()}, 自动扣款: $${(autoDeductedAmount / 500000).toFixed(2)}`);
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
 * 解除逾期惩罚（管理员功能）
 */
export function clearOverduePenalty(loanId: number): { success: boolean; message: string } {
    try {
        const loan = kunbeiQueries.getLoanById.get(loanId);
        
        if (!loan) {
            return { success: false, message: '借款记录不存在' };
        }
        
        if (!loan.overdue_penalty_until) {
            return { success: false, message: '该借款没有逾期惩罚' };
        }
        
        const now = Date.now();
        kunbeiQueries.clearOverduePenalty.run(now, loanId);
        
        console.log(`[坤呗] 管理员解除逾期惩罚 - 用户: ${loan.username}, 借款ID: ${loanId}`);
        
        return { 
            success: true, 
            message: `已解除用户 ${loan.username} 的逾期惩罚（高级场禁入已解除）` 
        };
    } catch (error: any) {
        console.error('[坤呗] 解除逾期惩罚失败:', error);
        return { success: false, message: '解除失败: ' + error.message };
    }
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
    const { getTodayDate } = require('./slot');
    const today = getTodayDate();

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

