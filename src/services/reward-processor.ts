/**
 * 待发放奖金自动处理器
 * 定期扫描并尝试发放失败的奖金
 */

import { pendingRewardQueries, adminQueries } from '../database';
import { getKyxUserById, updateKyxUserQuota } from './kyx-api';
import logger from '../utils/logger';

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
        logger.info('奖金发放', `${context} - 开始处理 - 金额: $${(reward.reward_amount / 500000).toFixed(2)}, 重试次数: ${reward.retry_count}`);

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

        logger.debug('奖金发放', `${context} - 当前额度: ${currentQuota}, 奖金: ${reward.reward_amount}, 目标额度: ${newQuota}`);

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
            logger.debug('奖金发放', `${context} - 验证额度 - 期望: ${newQuota}, 实际: ${actualQuota}`);

            // 允许小范围误差
            if (Math.abs(actualQuota - newQuota) > reward.reward_amount) {
                throw new Error(`额度验证失败 - 期望: ${newQuota}, 实际: ${actualQuota}`);
            }
        }

        // 标记为成功
        pendingRewardQueries.markSuccess.run('success', now, now, reward.id);
        logger.info('奖金发放', `${context} - ✅ 发放成功`);

        return true;
    } catch (error: any) {
        const errorMsg = error.message || '未知错误';
        logger.error('奖金发放', `${context} - ❌ 处理失败: ${errorMsg}`);

        const now = Date.now();

        // 检查是否达到最大重试次数
        if (reward.retry_count + 1 >= MAX_RETRY_COUNT) {
            logger.error('奖金发放', `${context} - 已达到最大重试次数 (${MAX_RETRY_COUNT})，标记为失败`);
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
        logger.debug('奖金发放', '上一批次仍在处理中，跳过本次');
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

        logger.info('奖金发放', `🔄 发现 ${pendingRewards.length} 条待处理奖金记录`);

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

        logger.info('奖金发放', `✅ 本批次处理完成 - 成功: ${successCount}, 失败: ${failedCount}`);
    } catch (error) {
        logger.error('奖金发放', `❌ 处理过程出错: ${error}`);
    } finally {
        isProcessing = false;
    }
}

/**
 * 启动自动发放服务
 */
export function startRewardProcessor() {
    logger.info('奖金发放', `🚀 启动自动发放服务 - 间隔: ${PROCESS_INTERVAL / 1000}秒`);

    // 立即执行一次
    processPendingRewards();

    // 定期执行
    setInterval(() => {
        processPendingRewards();
    }, PROCESS_INTERVAL);
}

/**
 * 手动触发处理（用于测试或管理后台）
 * 优化版：异步后台处理，立即返回，避免阻塞
 */
export async function manualProcessRewards(): Promise<{ success: number; failed: number; total: number; async: boolean }> {
    const pendingRewards = pendingRewardQueries.getPending.all();

    if (pendingRewards.length === 0) {
        return { success: 0, failed: 0, total: 0, async: false };
    }

    const total = pendingRewards.length;
    logger.info('一键发放', `🚀 开始异步处理 ${total} 条待发放记录`);

    // 立即返回，不等待处理完成
    // 后台异步处理
    processRewardsAsync(pendingRewards);

    return {
        success: 0,
        failed: 0,
        total,
        async: true // 标记为异步处理
    };
}

/**
 * 异步处理待发放奖金（后台执行）
 * 使用并发控制，避免过多API调用
 */
async function processRewardsAsync(rewards: any[]) {
    let successCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // 并发控制：每次最多处理3个（避免触发限流）
    const CONCURRENT_LIMIT = 3;

    for (let i = 0; i < rewards.length; i += CONCURRENT_LIMIT) {
        const batch = rewards.slice(i, i + CONCURRENT_LIMIT);

        // 并发处理这一批
        const results = await Promise.all(
            batch.map(reward => processPendingReward(reward))
        );

        // 统计结果
        results.forEach(success => {
            if (success) {
                successCount++;
            } else {
                failedCount++;
            }
        });

        // 输出进度
        const processed = Math.min(i + CONCURRENT_LIMIT, rewards.length);
        const percentage = ((processed / rewards.length) * 100).toFixed(1);
        logger.info('一键发放', `📊 进度: ${processed}/${rewards.length} (${percentage}%) - 成功: ${successCount}, 失败: ${failedCount}`);

        // 批次之间稍微延迟，避免压力过大
        if (i + CONCURRENT_LIMIT < rewards.length) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info('一键发放', `✅ 全部处理完成 - 总数: ${rewards.length}, 成功: ${successCount}, 失败: ${failedCount}, 耗时: ${duration}秒`);
}
