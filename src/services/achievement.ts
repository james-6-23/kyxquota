/**
 * 成就系统服务
 * 处理成就的检查、解锁、进度更新和奖励发放
 */

import { achievementQueries, userQueries, adminQueries } from '../database';
import { addQuota } from './kyx-api';
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
        logger.debug('成就检查', `开始检查成就 [${achievementKey}] - 用户: ${linuxDoId}`);

        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (userAchievement) {
            logger.debug('成就检查', `成就 [${achievementKey}] 已解锁，跳过检查`);
            return { unlocked: false };
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            logger.error('成就系统', `❌ 成就不存在: ${achievementKey}`);
            return { unlocked: false };
        }

        logger.debug('成就检查', `检查成就 [${achievement.achievement_name}] 条件: ${achievement.condition_type}`);

        // 检查条件
        const conditionMet = await checkAchievementCondition(linuxDoId, achievement, eventData);
        if (!conditionMet) {
            logger.debug('成就检查', `成就 [${achievement.achievement_name}] 条件未满足`);
            return { unlocked: false };
        }

        logger.info('成就解锁', `✅ 条件满足，准备解锁成就 [${achievement.achievement_name}]`);

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

        logger.info('成就系统', `🏆 用户 ${linuxDoId} 成功解锁成就: ${achievement.achievement_name} [${achievement.rarity}] +${achievement.reward_quota}`);

        return { unlocked: true, achievement };
    } catch (error: any) {
        logger.error('成就系统', `❌ 检查成就失败 [${achievementKey}]: ${error.message}`, error.stack);
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
        logger.debug('条件检查', `计数型成就 [${achievementKey}] 无进度记录`);
        return false;
    }
    
    const met = progress.current_value >= progress.target_value;
    logger.debug('条件检查', `计数型成就 [${achievementKey}] 进度: ${progress.current_value}/${progress.target_value} - ${met ? '✅达成' : '❌未达成'}`);
    
    return met;
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
        const value = eventData[condition.field];
        const met = value >= condition.threshold;
        logger.debug('条件检查', `阈值型条件 [${condition.field}] 值: ${value}, 阈值: ${condition.threshold} - ${met ? '✅达成' : '❌未达成'}`);
        return met;
    }
    logger.debug('条件检查', `阈值型条件缺少必要数据`);
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
        logger.debug('成就进度', `更新进度 [${achievementKey}] +${increment} - 用户: ${linuxDoId}`);

        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (userAchievement) {
            logger.debug('成就进度', `成就 [${achievementKey}] 已解锁，跳过进度更新`);
            return; // 已解锁，不需要更新进度
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            logger.warn('成就进度', `成就 [${achievementKey}] 不存在，无法更新进度`);
            return;
        }

        // 获取条件
        const condition = JSON.parse(achievement.condition_value);
        const targetValue = condition.target || condition.count || 1;

        // 获取当前进度
        const progress = achievementQueries.getProgress.get(linuxDoId, achievementKey);
        const oldValue = progress ? progress.current_value : 0;
        const currentValue = oldValue + increment;

        // 更新进度
        const now = Date.now();
        achievementQueries.updateProgress.run(
            linuxDoId,
            achievementKey,
            currentValue,
            targetValue,
            now
        );

        const percentage = ((currentValue / targetValue) * 100).toFixed(1);
        logger.info('成就进度', `📊 用户 ${linuxDoId} 成就 [${achievement.achievement_name}] 进度: ${oldValue} → ${currentValue}/${targetValue} (${percentage}%)`);

        // 检查是否达成
        if (currentValue >= targetValue) {
            logger.info('成就进度', `🎯 成就 [${achievement.achievement_name}] 进度已达成，触发解锁检查`);
            await checkAndUnlockAchievement(linuxDoId, achievementKey);
        }
    } catch (error: any) {
        logger.error('成就系统', `❌ 更新进度失败 [${achievementKey}]: ${error.message}`, error.stack);
    }
}

/**
 * 领取成就奖励
 * @param linuxDoId 用户ID
 * @param kyxUserId 公益站用户ID
 * @param achievementKey 成就标识
 * @param session 管理员session
 * @param newApiUser 新API用户标识
 */
export async function claimAchievementReward(
    linuxDoId: string,
    kyxUserId: number,
    achievementKey: string,
    session: string,
    newApiUser: string = '1'
): Promise<{ success: boolean; message: string; reward?: number }> {
    try {
        logger.info('成就奖励', `用户 ${linuxDoId} 请求领取成就奖励: ${achievementKey}`);

        // 检查成就是否已解锁
        const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, achievementKey);
        if (!userAchievement) {
            logger.warn('成就奖励', `❌ 成就 [${achievementKey}] 未解锁`);
            return { success: false, message: '成就未解锁' };
        }

        // 检查是否已领取
        if (userAchievement.reward_claimed) {
            logger.warn('成就奖励', `❌ 成就 [${achievementKey}] 奖励已领取`);
            return { success: false, message: '奖励已领取' };
        }

        // 获取成就定义
        const achievement = achievementQueries.getByKey.get(achievementKey);
        if (!achievement) {
            logger.error('成就奖励', `❌ 成就 [${achievementKey}] 不存在`);
            return { success: false, message: '成就不存在' };
        }

        logger.info('成就奖励', `正在发放奖励: ${achievement.achievement_name} - ${achievement.reward_quota} quota`);

        // 发放奖励
        const rechargeResult = await addQuota(
            kyxUserId,
            achievement.reward_quota,
            session,
            newApiUser,
            '成就奖励'
        );
        if (!rechargeResult.success) {
            logger.error('成就奖励', `❌ 奖励发放失败: ${rechargeResult.message}`);
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

        logger.info('成就奖励', `💰 用户 ${linuxDoId} 成功领取成就奖励: ${achievement.achievement_name} (+${achievement.reward_quota})`);

        return {
            success: true,
            message: '奖励已发放',
            reward: achievement.reward_quota
        };
    } catch (error: any) {
        logger.error('成就系统', `❌ 领取奖励失败 [${achievementKey}]: ${error.message}`, error.stack);
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
    kyxUserId: number,
    session: string,
    newApiUser: string = '1'
): Promise<{ success: boolean; message: string; totalReward?: number; count?: number }> {
    try {
        logger.info('批量领取', `用户 ${linuxDoId} 请求批量领取所有成就奖励`);

        const unclaimedAchievements = achievementQueries.getUnclaimedRewards.all(linuxDoId);

        if (unclaimedAchievements.length === 0) {
            logger.info('批量领取', `用户 ${linuxDoId} 没有可领取的奖励`);
            return { success: false, message: '没有可领取的奖励' };
        }

        logger.info('批量领取', `发现 ${unclaimedAchievements.length} 个待领取奖励，开始批量发放`);

        let totalReward = 0;
        let successCount = 0;
        let failedCount = 0;

        for (const userAchievement of unclaimedAchievements) {
            const result = await claimAchievementReward(linuxDoId, kyxUserId, userAchievement.achievement_key, session, newApiUser);
            if (result.success && result.reward) {
                totalReward += result.reward;
                successCount++;
            } else {
                failedCount++;
                logger.warn('批量领取', `领取失败: ${userAchievement.achievement_key} - ${result.message}`);
            }
        }

        logger.info('批量领取', `✅ 批量领取完成: 成功 ${successCount}/${unclaimedAchievements.length}, 总奖励 ${totalReward} quota`);

        if (failedCount > 0) {
            logger.warn('批量领取', `⚠️ 部分奖励领取失败: ${failedCount} 个`);
        }

        return {
            success: true,
            message: `成功领取 ${successCount} 个成就奖励`,
            totalReward,
            count: successCount
        };
    } catch (error: any) {
        logger.error('成就系统', `❌ 批量领取失败: ${error.message}`, error.stack);
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
 * 获取所有成就及全局统计（包括达成率）
 */
export function getAllAchievementsWithStats(linuxDoId?: string) {
    try {
        logger.debug('成就数据', `获取所有成就及统计数据${linuxDoId ? ` - 用户: ${linuxDoId}` : ''}`);

        const allAchievements = achievementQueries.getAll.all();
        const achievementStats = achievementQueries.getAchievementStats.all();
        const totalUsersResult = achievementQueries.getTotalUsers.get();
        const totalUsers = totalUsersResult?.total || 1; // 避免除以0

        logger.debug('成就数据', `加载 ${allAchievements.length} 个成就，总用户数: ${totalUsers}`);

        // 构建达成人数映射
        const statsMap = new Map(achievementStats.map(s => [s.achievement_key, s.unlock_count]));

        // 如果提供了用户ID，获取用户的成就数据
        let unlockedMap = new Map();
        let progressMap = new Map();
        
        if (linuxDoId) {
            const userAchievements = achievementQueries.getUserAchievements.all(linuxDoId);
            const userProgress = achievementQueries.getUserProgress.all(linuxDoId);
            unlockedMap = new Map(userAchievements.map(ua => [ua.achievement_key, ua]));
            progressMap = new Map(userProgress.map(p => [p.achievement_key, p]));
            logger.debug('成就数据', `用户已解锁 ${userAchievements.length} 个成就，${userProgress.length} 个进度中`);
        }

        // 合并数据
        const result = allAchievements.map(achievement => {
            const unlockCount = statsMap.get(achievement.achievement_key) || 0;
            const unlockRate = totalUsers > 0 ? (unlockCount / totalUsers) * 100 : 0;
            
            const unlocked = unlockedMap.get(achievement.achievement_key);
            const progress = progressMap.get(achievement.achievement_key);

            return {
                ...achievement,
                // 全局统计
                unlock_count: unlockCount,
                unlock_rate: parseFloat(unlockRate.toFixed(2)),
                total_users: totalUsers,
                // 用户数据（如果提供了linuxDoId）
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

        logger.info('成就数据', `✅ 成就数据加载成功: ${allAchievements.length} 个成就`);
        return result;
    } catch (error: any) {
        logger.error('成就系统', `❌ 获取成就数据失败: ${error.message}`, error.stack);
        return [];
    }
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
        logger.debug('统计更新', `开始更新用户 ${linuxDoId} 成就统计`);

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

        logger.debug('统计更新', `✅ 用户 ${linuxDoId} 统计更新完成: ${unlockedAchievements}/${totalAchievements} (${completionRate.toFixed(1)}%), 已领奖励: ${claimedRewards}/${totalRewards}`);
    } catch (error: any) {
        logger.error('成就系统', `❌ 更新统计失败 [${linuxDoId}]: ${error.message}`, error.stack);
    }
}

/**
 * 获取成就排行榜
 */
export function getAchievementLeaderboard(limit: number = 100) {
    logger.debug('排行榜', `获取成就排行榜 (前 ${limit} 名)`);
    const leaderboard = achievementQueries.getLeaderboard.all(limit);
    logger.info('排行榜', `✅ 成就排行榜加载成功，共 ${leaderboard.length} 名玩家`);
    return leaderboard;
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
        logger.info('徽章设置', `用户 ${linuxDoId} 设置徽章: [${badge1 || '-'}, ${badge2 || '-'}, ${badge3 || '-'}]`);

        // 验证徽章是否已解锁
        const badges = [badge1, badge2, badge3].filter(b => b);
        for (const badgeKey of badges) {
            const userAchievement = achievementQueries.getUserAchievement.get(linuxDoId, badgeKey);
            if (!userAchievement) {
                logger.warn('徽章设置', `❌ 成就 [${badgeKey}] 未解锁，无法设置为徽章`);
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

        logger.info('徽章设置', `✅ 用户 ${linuxDoId} 徽章设置成功`);
        return { success: true, message: '徽章设置成功' };
    } catch (error: any) {
        logger.error('成就系统', `❌ 设置徽章失败 [${linuxDoId}]: ${error.message}`, error.stack);
        return { success: false, message: `设置失败: ${error.message}` };
    }
}
