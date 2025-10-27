/**
 * 待发放奖金自动处理器
 * 定期扫描并尝试发放失败的奖金
 */

import { pendingRewardQueries, adminQueries } from '../database';
import { getKyxUserById, updateKyxUserQuota } from './kyx-api';

// 配置
const PROCESS_INTERVAL = 60000; // 每60秒处理一次
const MAX_RETRY_COUNT = 10; // 最大重试次数
const BATCH_SIZE = 10; // 每次处理的最大数量

let isProcessing = false;

/**
 * 处理单个待发放奖金
 */
async function processPendingReward(reward: any): Promise<boolean> {
    const context = `[奖金发放] ID: ${reward.id}, 用户: ${reward.username}`;

    try {
        console.log(`${context} - 开始处理 - 金额: $${(reward.reward_amount / 500000).toFixed(2)}, 重试次数: ${reward.retry_count}`);

        // 标记为处理中
        const now = Date.now();
        pendingRewardQueries.updateStatus.run('processing', now, null, reward.id);

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig) {
            throw new Error('系统配置未找到');
        }

        // 获取用户当前额度
        const userResult = await getKyxUserById(
            reward.kyx_user_id,
            adminConfig.session,
            adminConfig.new_api_user,
            3,
            true // 跳过缓存，获取最新数据
        );

        if (!userResult.success || !userResult.user) {
            throw new Error(`获取用户信息失败: ${userResult.message || '未知错误'}`);
        }

        const currentQuota = userResult.user.quota;
        const newQuota = currentQuota + reward.reward_amount;

        console.log(`${context} - 当前额度: ${currentQuota}, 奖金: ${reward.reward_amount}, 目标额度: ${newQuota}`);

        // 更新额度
        const updateResult = await updateKyxUserQuota(
            reward.kyx_user_id,
            newQuota,
            adminConfig.session,
            adminConfig.new_api_user,
            reward.username,
            userResult.user.group || 'default'
        );

        if (!updateResult || !updateResult.success) {
            throw new Error(`更新额度失败: ${updateResult?.message || '未知错误'}`);
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
            console.log(`${context} - 验证额度 - 期望: ${newQuota}, 实际: ${actualQuota}`);

            // 允许小范围误差
            if (Math.abs(actualQuota - newQuota) > reward.reward_amount) {
                throw new Error(`额度验证失败 - 期望: ${newQuota}, 实际: ${actualQuota}`);
            }
        }

        // 标记为成功
        pendingRewardQueries.markSuccess.run('success', now, now, reward.id);
        console.log(`${context} - ✅ 发放成功`);

        return true;
    } catch (error: any) {
        const errorMsg = error.message || '未知错误';
        console.error(`${context} - ❌ 处理失败: ${errorMsg}`);

        const now = Date.now();

        // 检查是否达到最大重试次数
        if (reward.retry_count + 1 >= MAX_RETRY_COUNT) {
            console.error(`${context} - 已达到最大重试次数 (${MAX_RETRY_COUNT})，标记为失败`);
            pendingRewardQueries.updateStatus.run('failed', now, `达到最大重试次数: ${errorMsg}`, reward.id);
        } else {
            // 增加重试次数
            pendingRewardQueries.incrementRetry.run('pending', errorMsg, now, reward.id);
        }

        return false;
    }
}

/**
 * 批量处理待发放奖金
 */
async function processPendingRewards() {
    if (isProcessing) {
        console.log('[奖金发放] 上一批次仍在处理中，跳过本次');
        return;
    }

    isProcessing = true;

    try {
        // 获取待处理的奖金
        const pendingRewards = pendingRewardQueries.getPending.all();

        if (pendingRewards.length === 0) {
            // 没有待处理的奖金，不输出日志
            return;
        }

        console.log(`[奖金发放] 🔄 发现 ${pendingRewards.length} 条待处理奖金记录`);

        // 批量处理（限制每次处理数量）
        const batch = pendingRewards.slice(0, BATCH_SIZE);
        let successCount = 0;
        let failedCount = 0;

        for (const reward of batch) {
            const success = await processPendingReward(reward);
            if (success) {
                successCount++;
            } else {
                failedCount++;
            }

            // 每次处理后等待一小段时间，避免过于频繁
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`[奖金发放] ✅ 本批次处理完成 - 成功: ${successCount}, 失败: ${failedCount}`);
    } catch (error) {
        console.error('[奖金发放] ❌ 处理过程出错:', error);
    } finally {
        isProcessing = false;
    }
}

/**
 * 启动自动发放服务
 */
export function startRewardProcessor() {
    console.log(`[奖金发放] 🚀 启动自动发放服务 - 间隔: ${PROCESS_INTERVAL / 1000}秒`);

    // 立即执行一次
    processPendingRewards();

    // 定期执行
    setInterval(() => {
        processPendingRewards();
    }, PROCESS_INTERVAL);
}

/**
 * 手动触发处理（用于测试或管理后台）
 */
export async function manualProcessRewards(): Promise<{ success: number; failed: number }> {
    const pendingRewards = pendingRewardQueries.getPending.all();

    let successCount = 0;
    let failedCount = 0;

    for (const reward of pendingRewards) {
        const success = await processPendingReward(reward);
        if (success) {
            successCount++;
        } else {
            failedCount++;
        }
    }

    return { success: successCount, failed: failedCount };
}
