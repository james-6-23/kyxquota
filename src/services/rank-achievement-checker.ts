/**
 * 排行榜成就检查服务
 * 定期检查用户排名并解锁相应成就
 */

import logger from '../utils/logger';
import { checkAndUnlockAchievement } from './achievement';
import { getLeaderboard, getLossLeaderboard } from './slot';

/**
 * 检查所有排行榜成就
 */
export async function checkAllRankAchievements(): Promise<void> {
    try {
        logger.info('排行榜成就', '开始检查排行榜成就...');

        // 检查盈利榜成就
        await checkProfitRankAchievements();

        // 检查亏损榜成就
        await checkLossRankAchievements();

        logger.info('排行榜成就', '✅ 排行榜成就检查完成');
    } catch (error: any) {
        logger.error('排行榜成就', `检查失败: ${error.message}`);
    }
}

/**
 * 检查盈利榜成就
 */
async function checkProfitRankAchievements(): Promise<void> {
    try {
        // 获取盈利榜前10名
        const topUsers = getLeaderboard(10);

        for (let i = 0; i < topUsers.length; i++) {
            const user = topUsers[i];
            const rank = i + 1;

            // 坤圈首富（第1名）
            if (rank === 1) {
                await checkAndUnlockAchievement(user.linux_do_id, 'rank_1_profit');
            }

            // 名扬四海（前3名）
            if (rank <= 3) {
                await checkAndUnlockAchievement(user.linux_do_id, 'rank_top3');
            }

            // 榜上有名（前10名）
            if (rank <= 10) {
                await checkAndUnlockAchievement(user.linux_do_id, 'rank_top10');
            }
        }

        logger.info('排行榜成就', `✅ 盈利榜成就检查完成，检查了 ${topUsers.length} 位用户`);
    } catch (error: any) {
        logger.error('排行榜成就', `盈利榜检查失败: ${error.message}`);
    }
}

/**
 * 检查亏损榜成就
 */
async function checkLossRankAchievements(): Promise<void> {
    try {
        // 获取亏损榜第1名
        const topLosers = getLossLeaderboard(1);

        if (topLosers.length > 0) {
            const topLoser = topLosers[0];

            // 坤圈首负（亏损榜第1名）
            await checkAndUnlockAchievement(topLoser.linux_do_id, 'rank_1_loss');

            logger.info('排行榜成就', `✅ 亏损榜成就检查完成`);
        }
    } catch (error: any) {
        logger.error('排行榜成就', `亏损榜检查失败: ${error.message}`);
    }
}

/**
 * 启动定时检查（每小时执行一次）
 */
export function startRankAchievementChecker(): void {
    // 立即执行一次
    checkAllRankAchievements();

    // 每小时检查一次
    const intervalMs = 60 * 60 * 1000; // 1小时
    setInterval(async () => {
        await checkAllRankAchievements();
    }, intervalMs);

    logger.info('排行榜成就', `✅ 排行榜成就检查器已启动（每小时检查一次）`);
}
