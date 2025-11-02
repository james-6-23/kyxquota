/**
 * 成就系统API路由
 */

import { Hono } from 'hono';
import { sessionMiddleware } from '../utils';
import {
    getUserAchievements,
    getUserAchievementStats,
    claimAchievementReward,
    claimAllRewards,
    getAchievementLeaderboard,
    setUserBadges,
} from '../services/achievement';
import { userQueries } from '../database';
import logger from '../utils/logger';

const achievement = new Hono();

/**
 * 获取用户所有成就及进度
 * GET /api/achievement/user
 */
achievement.get('/user', sessionMiddleware, async (c) => {
    try {
        const session = c.get('session');
        const linuxDoId = session.linux_do_id;

        const achievements = getUserAchievements(linuxDoId);

        return c.json({
            success: true,
            data: achievements
        });
    } catch (error: any) {
        logger.error('成就API', `获取成就失败: ${error.message}`);
        return c.json({
            success: false,
            message: '获取成就失败'
        }, 500);
    }
});

/**
 * 获取用户成就统计
 * GET /api/achievement/stats
 */
achievement.get('/stats', sessionMiddleware, async (c) => {
    try {
        const session = c.get('session');
        const linuxDoId = session.linux_do_id;

        const stats = getUserAchievementStats(linuxDoId);

        return c.json({
            success: true,
            data: stats
        });
    } catch (error: any) {
        logger.error('成就API', `获取统计失败: ${error.message}`);
        return c.json({
            success: false,
            message: '获取统计失败'
        }, 500);
    }
});

/**
 * 领取单个成就奖励
 * POST /api/achievement/claim
 * Body: { achievement_key: string }
 */
achievement.post('/claim', sessionMiddleware, async (c) => {
    try {
        const session = c.get('session');
        const linuxDoId = session.linux_do_id;

        const { achievement_key } = await c.req.json();

        if (!achievement_key) {
            return c.json({
                success: false,
                message: '缺少成就标识'
            }, 400);
        }

        // 获取用户信息
        const user = userQueries.get.get(linuxDoId);
        if (!user) {
            return c.json({
                success: false,
                message: '用户不存在'
            }, 404);
        }

        const result = await claimAchievementReward(linuxDoId, user.kyx_user_id, achievement_key);

        return c.json(result);
    } catch (error: any) {
        logger.error('成就API', `领取奖励失败: ${error.message}`);
        return c.json({
            success: false,
            message: '领取失败'
        }, 500);
    }
});

/**
 * 批量领取所有未领取的奖励
 * POST /api/achievement/claim-all
 */
achievement.post('/claim-all', sessionMiddleware, async (c) => {
    try {
        const session = c.get('session');
        const linuxDoId = session.linux_do_id;

        // 获取用户信息
        const user = userQueries.get.get(linuxDoId);
        if (!user) {
            return c.json({
                success: false,
                message: '用户不存在'
            }, 404);
        }

        const result = await claimAllRewards(linuxDoId, user.kyx_user_id);

        return c.json(result);
    } catch (error: any) {
        logger.error('成就API', `批量领取失败: ${error.message}`);
        return c.json({
            success: false,
            message: '批量领取失败'
        }, 500);
    }
});

/**
 * 获取成就排行榜
 * GET /api/achievement/leaderboard?limit=100
 */
achievement.get('/leaderboard', async (c) => {
    try {
        const limit = parseInt(c.req.query('limit') || '100');

        const leaderboard = getAchievementLeaderboard(limit);

        return c.json({
            success: true,
            data: leaderboard
        });
    } catch (error: any) {
        logger.error('成就API', `获取排行榜失败: ${error.message}`);
        return c.json({
            success: false,
            message: '获取排行榜失败'
        }, 500);
    }
});

/**
 * 设置用户徽章
 * POST /api/achievement/badges
 * Body: { badge1?: string, badge2?: string, badge3?: string }
 */
achievement.post('/badges', sessionMiddleware, async (c) => {
    try {
        const session = c.get('session');
        const linuxDoId = session.linux_do_id;

        const { badge1, badge2, badge3 } = await c.req.json();

        const result = setUserBadges(linuxDoId, badge1, badge2, badge3);

        return c.json(result);
    } catch (error: any) {
        logger.error('成就API', `设置徽章失败: ${error.message}`);
        return c.json({
            success: false,
            message: '设置失败'
        }, 500);
    }
});

export default achievement;
