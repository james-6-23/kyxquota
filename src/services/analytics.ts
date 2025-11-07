/**
 * 游戏数据分析服务
 */

import { db } from '../database';
import { getTodayDate as getSlotTodayDate } from './slot';
import logger from '../utils/logger';

// 导出getTodayDate供其他模块使用
export { getTodayDate } from './slot';

/**
 * 创建空统计对象
 */
function createEmptyStats() {
    return {
        spins: 0,
        active_users: 0,
        total_bet: 0,
        total_win: 0,
        profit: 0,
        free_spins: 0,
        rtp: 0
    };
}

/**
 * 获取指定日期的游戏统计
 */
export function getGameStatsByDate(date: string) {
    try {
        // 查询初级场和高级场统计
        const normalAdvancedQuery = db.query(`
            SELECT 
                COALESCE(slot_mode, 'normal') as slot_mode,
                COUNT(*) as spins,
                COUNT(DISTINCT linux_do_id) as active_users,
                COALESCE(SUM(bet_amount), 0) as total_bet,
                COALESCE(SUM(win_amount), 0) as total_win,
                COALESCE(SUM(bet_amount) - SUM(win_amount), 0) as profit,
                SUM(CASE WHEN is_free_spin = 1 THEN 1 ELSE 0 END) as free_spins
            FROM slot_machine_records
            WHERE date = ?
            GROUP BY COALESCE(slot_mode, 'normal')
        `);
        
        const normalAdvancedStats = normalAdvancedQuery.all(date) as any[];

        // 查询至尊场统计
        const supremeQuery = db.query(`
            SELECT 
                COUNT(*) as spins,
                COUNT(DISTINCT linux_do_id) as active_users,
                COALESCE(SUM(bet_amount), 0) as total_bet,
                COALESCE(SUM(win_amount), 0) as total_win,
                COALESCE(SUM(bet_amount) - SUM(win_amount), 0) as profit
            FROM supreme_slot_records
            WHERE date = ?
        `);
        
        const supremeStats = supremeQuery.get(date) as any;

        // 整理数据
        const normal = normalAdvancedStats.find((s: any) => s.slot_mode === 'normal') || createEmptyStats();
        const advanced = normalAdvancedStats.find((s: any) => s.slot_mode === 'advanced') || createEmptyStats();
        const supreme = supremeStats ? {
            spins: supremeStats.spins || 0,
            activeUsers: supremeStats.active_users || 0,
            totalBet: supremeStats.total_bet || 0,
            totalWin: supremeStats.total_win || 0,
            profit: supremeStats.profit || 0,
            rtp: 0
        } : createEmptyStats();

        // 计算RTP
        normal.rtp = normal.total_bet > 0 ? (normal.total_win / normal.total_bet) * 100 : 0;
        advanced.rtp = advanced.total_bet > 0 ? (advanced.total_win / advanced.total_bet) * 100 : 0;
        supreme.rtp = supreme.totalBet > 0 ? (supreme.totalWin / supreme.totalBet) * 100 : 0;
        
        console.log('至尊场统计:', supreme);

        // 计算占比
        const totalSpins = normal.spins + advanced.spins + supreme.spins;
        normal.percentage = totalSpins > 0 ? (normal.spins / totalSpins) * 100 : 0;
        advanced.percentage = totalSpins > 0 ? (advanced.spins / totalSpins) * 100 : 0;
        supreme.percentage = totalSpins > 0 ? (supreme.spins / totalSpins) * 100 : 0;

        // 获取唯一活跃用户数
        const uniqueUsersQuery = db.query(`
            SELECT COUNT(DISTINCT linux_do_id) as count
            FROM (
                SELECT linux_do_id FROM slot_machine_records WHERE date = ?
                UNION
                SELECT linux_do_id FROM supreme_slot_records WHERE date = ?
            )
        `);
        
        const uniqueUsers = uniqueUsersQuery.get(date, date) as any;

        // 总计
        const total = {
            spins: totalSpins,
            activeUsers: uniqueUsers?.count || 0,
            totalBet: (normal.total_bet || 0) + (advanced.total_bet || 0) + (supreme.totalBet || 0),
            totalWin: (normal.total_win || 0) + (advanced.total_win || 0) + (supreme.totalWin || 0),
            profit: (normal.profit || 0) + (advanced.profit || 0) + (supreme.profit || 0),
            rtp: 0,
            avgBetPerSpin: 0,
            avgBetPerUser: 0
        };

        total.rtp = total.totalBet > 0 ? (total.totalWin / total.totalBet) * 100 : 0;
        total.avgBetPerSpin = total.spins > 0 ? total.totalBet / total.spins : 0;
        total.avgBetPerUser = total.activeUsers > 0 ? total.totalBet / total.activeUsers : 0;

        console.log('统计汇总:', {
            总游玩: totalSpins,
            初级场: normal.spins,
            高级场: advanced.spins,
            至尊场: supreme.spins
        });

        return {
            date,
            total,
            normal,
            advanced,
            supreme
        };
    } catch (error: any) {
        logger.error('数据分析', `获取统计失败 - 日期: ${date}, 错误: ${error.message}`);
        throw error;
    }
}

/**
 * 获取今日游戏统计
 */
export function getTodayGameStats() {
    const today = getSlotTodayDate();
    return getGameStatsByDate(today);
}

/**
 * 获取昨日对比数据
 */
export function getYesterdayComparison() {
    try {
        const today = getSlotTodayDate();
        
        // 计算昨日日期
        const now = new Date();
        const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
        const beijingTime = new Date(utcTime + 8 * 3600000);
        beijingTime.setDate(beijingTime.getDate() - 1);
        const yesterday = beijingTime.toISOString().split('T')[0];

        const todayStats = getGameStatsByDate(today);
        const yesterdayStats = getGameStatsByDate(yesterday);

        // 计算变化百分比
        const calculateChange = (today: number, yesterday: number) => {
            if (yesterday === 0) return { change: 0, trend: 'neutral' };
            const change = ((today - yesterday) / yesterday) * 100;
            return {
                change: Math.abs(change),
                trend: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral'
            };
        };

        return {
            spins: calculateChange(todayStats.total.spins, yesterdayStats.total.spins),
            activeUsers: calculateChange(todayStats.total.activeUsers, yesterdayStats.total.activeUsers),
            profit: calculateChange(todayStats.total.profit, yesterdayStats.total.profit),
            totalBet: calculateChange(todayStats.total.totalBet, yesterdayStats.total.totalBet),
            totalWin: calculateChange(todayStats.total.totalWin, yesterdayStats.total.totalWin)
        };
    } catch (error: any) {
        logger.error('数据分析', `获取昨日对比失败: ${error.message}`);
        return {
            spins: { change: 0, trend: 'neutral' },
            activeUsers: { change: 0, trend: 'neutral' },
            profit: { change: 0, trend: 'neutral' },
            totalBet: { change: 0, trend: 'neutral' },
            totalWin: { change: 0, trend: 'neutral' }
        };
    }
}

/**
 * 获取历史趋势数据
 */
export function getGameTrendStats(days: number = 7) {
    try {
        const dates: string[] = [];
        const now = new Date();
        const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
        const beijingTime = new Date(utcTime + 8 * 3600000);

        // 生成日期列表（倒序：最旧到最新）
        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(beijingTime);
            date.setDate(beijingTime.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        // 初始化数据结构
        const trendData = {
            dates,
            total: { spins: [] as number[], profit: [] as number[], activeUsers: [] as number[] },
            normal: { spins: [] as number[], profit: [] as number[] },
            advanced: { spins: [] as number[], profit: [] as number[] },
            supreme: { spins: [] as number[], profit: [] as number[] }
        };

        // 查询每天的数据
        dates.forEach(date => {
            const dayStats = getGameStatsByDate(date);

            trendData.total.spins.push(dayStats.total.spins);
            trendData.total.profit.push(dayStats.total.profit);
            trendData.total.activeUsers.push(dayStats.total.activeUsers);

            trendData.normal.spins.push(dayStats.normal.spins);
            trendData.normal.profit.push(dayStats.normal.profit);

            trendData.advanced.spins.push(dayStats.advanced.spins);
            trendData.advanced.profit.push(dayStats.advanced.profit);

            trendData.supreme.spins.push(dayStats.supreme.spins);
            trendData.supreme.profit.push(dayStats.supreme.profit);
        });

        return trendData;
    } catch (error: any) {
        logger.error('数据分析', `获取趋势数据失败: ${error.message}`);
        throw error;
    }
}

/**
 * 获取场次详情
 */
export function getModeDetails(mode: 'normal' | 'advanced' | 'supreme', date?: string) {
    const targetDate = date || getSlotTodayDate();

    try {
        if (mode === 'supreme') {
            // 至尊场
            const query = db.query(`
                SELECT 
                    COUNT(*) as spins,
                    COUNT(DISTINCT linux_do_id) as active_users,
                    COALESCE(SUM(bet_amount), 0) as total_bet,
                    COALESCE(SUM(win_amount), 0) as total_win,
                    COALESCE(SUM(bet_amount) - SUM(win_amount), 0) as profit,
                    0 as free_spins,
                    MAX(win_amount) as biggest_win
                FROM supreme_slot_records
                WHERE date = ?
            `);

            const stats = query.get(targetDate) as any;
            if (stats) {
                stats.rtp = stats.total_bet > 0 ? (stats.total_win / stats.total_bet) * 100 : 0;
                stats.paid_spins = stats.spins;
            }
            return stats || createEmptyStats();
        } else {
            // 初级场或高级场
            const modeFilter = mode === 'normal' ? "COALESCE(slot_mode, 'normal') = 'normal'" : "slot_mode = 'advanced'";
            
            const query = db.query(`
                SELECT 
                    COUNT(*) as spins,
                    COUNT(DISTINCT linux_do_id) as active_users,
                    COALESCE(SUM(bet_amount), 0) as total_bet,
                    COALESCE(SUM(win_amount), 0) as total_win,
                    COALESCE(SUM(bet_amount) - SUM(win_amount), 0) as profit,
                    SUM(CASE WHEN is_free_spin = 1 THEN 1 ELSE 0 END) as free_spins,
                    MAX(win_amount) as biggest_win
                FROM slot_machine_records
                WHERE date = ? AND ${modeFilter}
            `);

            const stats = query.get(targetDate) as any;
            if (stats) {
                stats.rtp = stats.total_bet > 0 ? (stats.total_win / stats.total_bet) * 100 : 0;
                stats.paid_spins = stats.spins - stats.free_spins;
            }
            return stats || createEmptyStats();
        }
    } catch (error: any) {
        logger.error('数据分析', `获取场次详情失败 - 模式: ${mode}, 日期: ${targetDate}, 错误: ${error.message}`);
        return createEmptyStats();
    }
}

