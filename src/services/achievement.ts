/**
 * 成就系统服务
 * 处理成就的检查、解锁、进度更新和奖励发放
 */

import { achievementQueries } from '../database';
import { rechargeQuota } from './kyx-api';
import logger from '../utils/logger';
import type { Achievement, AchievementProgress, UserAchievement } from '../types';

/**
 * 检查并解锁成就
 * @param linuxDoId 用户ID
 * @param achievementKey 成就标识
 * @param eventData 事件数据
 * @returns 是否解锁成功
 */
export async function checkAndUnlockAchievement(
    linuxDoId: string,
    achievementKey: string,
    eventData?: any
): Promise<{ unlocked: boolean; achievement?: Achievement }> {
    try {
        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (userAchievement) {
            return { unlocked: false };
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            logger.error('成就系统', `成就不存在: ${achievementKey}`);
            return { unlocked: false };
        }

        // 检查条件
        const conditionMet = await checkAchievementCondition(linuxDoId, achievement, eventData);
        if (!conditionMet) {
            return { unlocked: false };
        }

        // 解锁成就
        const now = Date.now();
        achievementQueries.insertUserAchievement.run(
            linuxDoId,
            achievementKey,
            now,
            null  // progress字段
        );

        // 更新用户统计
        await updateUserAchievementStats(linuxDoId);

        logger.info('成就系统', `🏆 用户 ${linuxDoId} 解锁成就: ${achievement.achievement_name}`);

        return { unlocked: true, achievement };
    } catch (error: any) {
        logger.error('成就系统', `检查成就失败: ${error.message}`);
        return { unlocked: false };
    }
}

/**
 * 检查成就条件是否满足
 */
async function checkAchievementCondition(
    linuxDoId: string,
    achievement: Achievement,
    eventData?: any
): Promise<boolean> {
    try {
        const condition = JSON.parse(achievement.condition_value);

        switch (achievement.condition_type) {
            case 'once':
                // 一次性成就，触发即解锁
                return true;

            case 'count':
                // 计数型成就
                return await checkCountCondition(linuxDoId, achievement.achievement_key, condition);

            case 'threshold':
                // 阈值型成就
                return await checkThresholdCondition(linuxDoId, condition, eventData);

            case 'rate':
                // 比率型成就
                return await checkRateCondition(linuxDoId, condition);

            case 'combo':
                // 连续型成就
                return await checkComboCondition(linuxDoId, condition, eventData);

            case 'collection':
                // 收集型成就
                return await checkCollectionCondition(linuxDoId, condition);

            case 'rank':
                // 排名型成就
                return await checkRankCondition(linuxDoId, condition);

            default:
                logger.error('成就系统', `未知条件类型: ${achievement.condition_type}`);
                return false;
        }
    } catch (error: any) {
        logger.error('成就系统', `检查条件失败: ${error.message}`);
        return false;
    }
}

/**
 * 检查计数条件
 */
async function checkCountCondition(
    linuxDoId: string,
    achievementKey: string,
    condition: any
): Promise<boolean> {
    const progress = achievementQueries.getProgress.get(linuxDoId, achievementKey);
    if (!progress) {
        return false;
    }
    return progress.current_value >= progress.target_value;
}

/**
 * 检查阈值条件
 */
async function checkThresholdCondition(
    linuxDoId: string,
    condition: any,
    eventData?: any
): Promise<boolean> {
    // 根据condition.field和condition.threshold检查
    // 例如: { field: 'quota', threshold: 50000 }
    if (eventData && condition.field) {
        return eventData[condition.field] >= condition.threshold;
    }
    return false;
}

/**
 * 检查比率条件
 */
async function checkRateCondition(linuxDoId: string, condition: any): Promise<boolean> {
    // 例如: { field: 'win_rate', rate: 0.3 }
    // 需要从数据库查询用户统计数据
    return false;
}

/**
 * 检查连续条件
 */
async function checkComboCondition(
    linuxDoId: string,
    condition: any,
    eventData?: any
): Promise<boolean> {
    // 例如: { count: 3 } 连续3次
    // 需要维护连续计数器
    return false;
}

/**
 * 检查收集条件
 */
async function checkCollectionCondition(linuxDoId: string, condition: any): Promise<boolean> {
    // 例如: { items: ['m', 't', 'n', 'j', 'lq', 'bj', 'zft', 'bdk', 'lsh'] }
    // 需要检查用户是否收集了所有指定项目
    return false;
}

/**
 * 检查排名条件
 */
async function checkRankCondition(linuxDoId: string, condition: any): Promise<boolean> {
    // 例如: { rank: 10, type: 'profit' }
    // 需要从排行榜查询用户排名
    return false;
}

/**
 * 更新成就进度
 * @param linuxDoId 用户ID
 * @param achievementKey 成就标识
 * @param increment 增量（默认1）
 */
export async function updateAchievementProgress(
    linuxDoId: string,
    achievementKey: string,
    increment: number = 1
): Promise<void> {
    try {
        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (userAchievement) {
            return; // 已解锁，不需要更新进度
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            return;
        }

        // 获取条件
        const condition = JSON.parse(achievement.condition_value);
        const targetValue = condition.target || condition.count || 1;

        // 获取当前进度
        const progress = achievementQueries.getProgress.get(linuxDoId, achievementKey);
        const currentValue = progress ? progress.current_value + increment : increment;

        // 更新进度
        const now = Date.now();
        achievementQueries.updateProgress.run(
            linuxDoId,
            achievementKey,
            currentValue,
            targetValue,
            now
        );

        logger.info('成就进度', `用户 ${linuxDoId} 成就 ${achievementKey} 进度: ${currentValue}/${targetValue}`);

        // 检查是否达成
        if (currentValue >= targetValue) {
            await checkAndUnlockAchievement(linuxDoId, achievementKey);
        }
    } catch (error: any) {
        logger.error('成就系统', `更新进度失败: ${error.message}`);
    }
}

/**
 * 领取成就奖励
 * @param linuxDoId 用户ID
 * @param kyxUserId 公益站用户ID
 * @param achievementKey 成就标识
 */
export async function claimAchievementReward(
    linuxDoId: string,
    kyxUserId: number,
    achievementKey: string
): Promise<{ success: boolean; message: string; reward?: number }> {
    try {
        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (!userAchievement) {
            return { success: false, message: '成就未解锁' };
        }

        // 检查是否已领取
        if (userAchievement.reward_claimed) {
            return { success: false, message: '奖励已领取' };
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            return { success: false, message: '成就不存在' };
        }

        // 发放奖励
        const rechargeResult = await rechargeQuota(kyxUserId, achievement.reward_quota);
        if (!rechargeResult.success) {
            return {
                success: false,
                message: `奖励发放失败: ${rechargeResult.message}`
            };
        }

        // 标记为已领取
        const now = Date.now();
        achievementQueries.claimReward.run(now, linuxDoId, achievementKey);

        // 更新用户统计
        await updateUserAchievementStats(linuxDoId);

        logger.info('成就奖励', `✅ 用户 ${linuxDoId} 领取成就奖励: ${achievement.achievement_name} (+${achievement.reward_quota})`);

        return {
            success: true,
            message: '奖励已发放',
            reward: achievement.reward_quota
        };
    } catch (error: any) {
        logger.error('成就系统', `领取奖励失败: ${error.message}`);
        return {
            success: false,
            message: `领取失败: ${error.message}`
        };
    }
}

/**
 * 批量领取所有未领取的奖励
 */
export async function claimAllRewards(
    linuxDoId: string,
    kyxUserId: number
): Promise<{ success: boolean; message: string; totalReward?: number; count?: number }> {
    try {
        const unclaimedAchievements = achievementQueries.getUnclaimedRewards.all(linuxDoId);

        if (unclaimedAchievements.length === 0) {
            return { success: false, message: '没有可领取的奖励' };
        }

        let totalReward = 0;
        let successCount = 0;

        for (const userAchievement of unclaimedAchievements) {
            const result = await claimAchievementReward(linuxDoId, kyxUserId, userAchievement.achievement_key);
            if (result.success && result.reward) {
                totalReward += result.reward;
                successCount++;
            }
        }

        return {
            success: true,
            message: `成功领取 ${successCount} 个成就奖励`,
            totalReward,
            count: successCount
        };
    } catch (error: any) {
        logger.error('成就系统', `批量领取失败: ${error.message}`);
        return {
            success: false,
            message: `批量领取失败: ${error.message}`
        };
    }
}

/**
 * 获取用户所有成就及进度
 */
export function getUserAchievements(linuxDoId: string) {
    const allAchievements = achievementQueries.getAll.all();
    const userAchievements = achievementQueries.getUserAchievements.all(linuxDoId);
    const userProgress = achievementQueries.getUserProgress.all(linuxDoId);

    // 构建映射
    const unlockedMap = new Map(userAchievements.map(ua => [ua.achievement_key, ua]));
    const progressMap = new Map(userProgress.map(p => [p.achievement_key, p]));

    // 合并数据
    return allAchievements.map(achievement => {
        const unlocked = unlockedMap.get(achievement.achievement_key);
        const progress = progressMap.get(achievement.achievement_key);

        return {
            ...achievement,
            unlocked: !!unlocked,
            unlocked_at: unlocked?.unlocked_at,
            reward_claimed: unlocked?.reward_claimed || 0,
            progress: progress ? {
                current: progress.current_value,
                target: progress.target_value,
                percentage: Math.min(100, (progress.current_value / progress.target_value) * 100)
            } : null
        };
    });
}

/**
 * 获取用户成就统计
 */
export function getUserAchievementStats(linuxDoId: string) {
    let stats = achievementQueries.getStats.get(linuxDoId);

    if (!stats) {
        // 如果没有统计数据，创建初始数据
        const now = Date.now();
        achievementQueries.updateStats.run(linuxDoId, 0, 0, 0, 0, 0, now);
        stats = achievementQueries.getStats.get(linuxDoId);
    }

    return stats;
}

/**
 * 更新用户成就统计
 */
async function updateUserAchievementStats(linuxDoId: string): Promise<void> {
    try {
        const allAchievements = achievementQueries.getAll.all();
        const userAchievements = achievementQueries.getUserAchievements.all(linuxDoId);

        const totalAchievements = allAchievements.length;
        const unlockedAchievements = userAchievements.length;
        const completionRate = totalAchievements > 0
            ? (unlockedAchievements / totalAchievements) * 100
            : 0;

        // 计算总奖励和已领取奖励
        let totalRewards = 0;
        let claimedRewards = 0;

        for (const userAchievement of userAchievements) {
            const achievement = achievementQueries.getByKey.get(userAchievement.achievement_key);
            if (achievement) {
                totalRewards += achievement.reward_quota;
                if (userAchievement.reward_claimed) {
                    claimedRewards += achievement.reward_quota;
                }
            }
        }

        const now = Date.now();
        achievementQueries.updateStats.run(
            linuxDoId,
            totalAchievements,
            unlockedAchievements,
            completionRate,
            totalRewards,
            claimedRewards,
            now
        );
    } catch (error: any) {
        logger.error('成就系统', `更新统计失败: ${error.message}`);
    }
}

/**
 * 获取成就排行榜
 */
export function getAchievementLeaderboard(limit: number = 100) {
    return achievementQueries.getLeaderboard.all(limit);
}

/**
 * 设置用户徽章
 */
export function setUserBadges(
    linuxDoId: string,
    badge1?: string,
    badge2?: string,
    badge3?: string
): { success: boolean; message: string } {
    try {
        // 验证徽章是否已解锁
        const badges = [badge1, badge2, badge3].filter(b => b);
        for (const badgeKey of badges) {
            const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, badgeKey);
            if (!userAchievement) {
                return { success: false, message: `成就 ${badgeKey} 未解锁` };
            }
        }

        const now = Date.now();
        achievementQueries.updateBadges.run(
            badge1 || null,
            badge2 || null,
            badge3 || null,
            now,
            linuxDoId
        );

        return { success: true, message: '徽章设置成功' };
    } catch (error: any) {
        logger.error('成就系统', `设置徽章失败: ${error.message}`);
        return { success: false, message: `设置失败: ${error.message}` };
    }
}
