import { Hono } from 'hono';
import { getCookie, getSession, saveSession, generateSessionId, setCookie } from '../utils';
import {
    adminQueries,
    claimQueries,
    donateQueries,
    keyQueries,
    userQueries,
    slotQueries,
    pendingRewardQueries,
    db,
} from '../database';
import { cacheManager } from '../cache';
import { CONFIG } from '../config';
import { searchAndFindExactUser, pushKeysToGroup } from '../services/kyx-api';
import { validateModelScopeKey } from '../services/keys';
import { manualProcessRewards } from '../services/reward-processor';
import type { DonateRecord } from '../types';

const app = new Hono();

/**
 * 管理员认证中间件
 */
async function requireAdmin(c: any, next: any) {
    const sessionId = getCookie(c.req.raw.headers, 'admin_session');
    if (!sessionId) {
        return c.json({ success: false, message: '未授权' }, 401);
    }

    const session = await getSession(sessionId);
    if (!session?.admin) {
        return c.json({ success: false, message: '未授权' }, 401);
    }

    await next();
}

/**
 * 管理员登录
 */
app.post('/login', async (c) => {
    const { password } = await c.req.json();
    if (password !== CONFIG.ADMIN_PASSWORD) {
        console.log('[管理员] ❌ 登录失败 - 密码错误');
        return c.json({ success: false, message: '密码错误' }, 401);
    }

    const sessionId = generateSessionId();
    await saveSession(sessionId, { admin: true });

    console.log('[管理员] ✅ 管理员登录成功');
    c.header('Set-Cookie', setCookie('admin_session', sessionId));
    return c.json({ success: true });
});

/**
 * 获取系统配置
 */
app.get('/config', requireAdmin, async (c) => {
    const config = adminQueries.get.get();
    const cacheStats = cacheManager.getStats();

    return c.json({
        success: true,
        data: {
            claim_quota: config!.claim_quota,
            max_daily_claims: config!.max_daily_claims || 1,
            session: config!.session || '',  // 返回实际的 session 值
            session_configured: !!config!.session,
            new_api_user: config!.new_api_user || '1',  // 返回 new_api_user 值
            keys_api_url: config!.keys_api_url,
            keys_authorization: config!.keys_authorization || '',  // 返回实际值
            keys_authorization_configured: !!config!.keys_authorization,
            modelscope_group_id: config!.modelscope_group_id,
            iflow_group_id: config!.iflow_group_id || 26,
            max_daily_donate_modelscope: config!.max_daily_donate_modelscope || 1,
            max_daily_donate_iflow: config!.max_daily_donate_iflow || 1,
            updated_at: config!.updated_at,
        },
        cache_stats: {
            ...cacheStats,
            memory_mb: (cacheStats.memoryUsage / 1024 / 1024).toFixed(2),
        },
    });
});

/**
 * 更新领取额度
 */
app.put('/config/quota', requireAdmin, async (c) => {
    const { claim_quota } = await c.req.json();

    if (typeof claim_quota !== 'number' || claim_quota <= 0) {
        return c.json({ success: false, message: '额度必须为正数' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新领取额度配置 - 新值: $${(claim_quota / 500000).toFixed(2)}`);
    return c.json({ success: true, message: '配置已更新' });
});

/**
 * 更新每日领取次数
 */
app.put('/config/max-daily-claims', requireAdmin, async (c) => {
    const { max_daily_claims } = await c.req.json();

    if (typeof max_daily_claims !== 'number' || max_daily_claims <= 0) {
        return c.json({ success: false, message: '每日领取次数必须为正数' }, 400);
    }

    if (max_daily_claims > 10) {
        return c.json({ success: false, message: '每日领取次数不能超过10次' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        max_daily_claims,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新每日领取次数 - 新值: ${max_daily_claims} 次`);
    return c.json({ success: true, message: '每日领取次数已更新' });
});

/**
 * 更新 Session
 */
app.put('/config/session', requireAdmin, async (c) => {
    const { session: newSession } = await c.req.json();

    if (!newSession) {
        return c.json({ success: false, message: 'Session 不能为空' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        newSession,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log('[管理员] ⚙️ 更新 Session 配置');
    return c.json({ success: true, message: 'Session 已更新' });
});

/**
 * 更新 new-api-user
 */
app.put('/config/new-api-user', requireAdmin, async (c) => {
    const { new_api_user } = await c.req.json();

    if (!new_api_user) {
        return c.json({ success: false, message: 'new-api-user 不能为空' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    return c.json({ success: true, message: 'new-api-user 已更新' });
});

/**
 * 更新 Keys API URL
 */
app.put('/config/keys-api-url', requireAdmin, async (c) => {
    const { keys_api_url } = await c.req.json();

    if (!keys_api_url) {
        return c.json({ success: false, message: 'Keys API URL 不能为空' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    return c.json({ success: true, message: 'Keys API URL 已更新' });
});

/**
 * 更新 Keys Authorization
 */
app.put('/config/keys-authorization', requireAdmin, async (c) => {
    const { keys_authorization } = await c.req.json();

    if (!keys_authorization) {
        return c.json(
            { success: false, message: 'Keys Authorization 不能为空' },
            400
        );
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    return c.json({ success: true, message: 'Keys Authorization 已更新' });
});

/**
 * 更新 ModelScope Group ID
 */
app.put('/config/modelscope-group-id', requireAdmin, async (c) => {
    const { modelscope_group_id } = await c.req.json();

    if (modelscope_group_id === undefined || modelscope_group_id === null) {
        return c.json({ success: false, message: 'ModelScope Group ID 不能为空' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        parseInt(modelscope_group_id),
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新 ModelScope Group ID - 新值: ${modelscope_group_id}`);
    return c.json({ success: true, message: 'ModelScope Group ID 已更新' });
});

/**
 * 更新 iFlow Group ID
 */
app.put('/config/iflow-group-id', requireAdmin, async (c) => {
    const { iflow_group_id } = await c.req.json();

    if (iflow_group_id === undefined || iflow_group_id === null) {
        return c.json({ success: false, message: 'iFlow Group ID 不能为空' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        parseInt(iflow_group_id),
        config.max_daily_donate_modelscope || 1,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新 iFlow Group ID - 新值: ${iflow_group_id}`);
    return c.json({ success: true, message: 'iFlow Group ID 已更新' });
});

/**
 * 更新 ModelScope 每日投喂限制
 */
app.put('/config/max-daily-donate-modelscope', requireAdmin, async (c) => {
    const { max_daily_donate_modelscope } = await c.req.json();

    if (typeof max_daily_donate_modelscope !== 'number' || max_daily_donate_modelscope <= 0) {
        return c.json({ success: false, message: 'ModelScope 每日投喂限制必须为正数' }, 400);
    }

    if (max_daily_donate_modelscope > 10) {
        return c.json({ success: false, message: 'ModelScope 每日投喂限制不能超过10次' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        max_daily_donate_modelscope,
        config.max_daily_donate_iflow || 1,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新 ModelScope 每日投喂限制 - 新值: ${max_daily_donate_modelscope} 次`);
    return c.json({ success: true, message: 'ModelScope 每日投喂限制已更新' });
});

/**
 * 更新 iFlow 每日投喂限制
 */
app.put('/config/max-daily-donate-iflow', requireAdmin, async (c) => {
    const { max_daily_donate_iflow } = await c.req.json();

    if (typeof max_daily_donate_iflow !== 'number' || max_daily_donate_iflow <= 0) {
        return c.json({ success: false, message: 'iFlow 每日投喂限制必须为正数' }, 400);
    }

    if (max_daily_donate_iflow > 10) {
        return c.json({ success: false, message: 'iFlow 每日投喂限制不能超过10次' }, 400);
    }

    const config = adminQueries.get.get()!;
    adminQueries.update.run(
        config.session,
        config.new_api_user,
        config.claim_quota,
        config.max_daily_claims || 1,
        config.keys_api_url,
        config.keys_authorization,
        config.modelscope_group_id,
        config.iflow_group_id || 26,
        config.max_daily_donate_modelscope || 1,
        max_daily_donate_iflow,
        Date.now()
    );

    cacheManager.clear('admin_config');

    console.log(`[管理员] ⚙️ 更新 iFlow 每日投喂限制 - 新值: ${max_daily_donate_iflow} 次`);
    return c.json({ success: true, message: 'iFlow 每日投喂限制已更新' });
});

/**
 * 获取所有领取记录（支持分页）
 */
app.get('/records/claim', requireAdmin, async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '50');

    const offset = (page - 1) * pageSize;
    const records = claimQueries.getAllPaginated.all(pageSize, offset);
    const totalCount = claimQueries.count.get()!.count;
    const totalPages = Math.ceil(totalCount / pageSize);

    return c.json({
        success: true,
        data: records,
        pagination: {
            page,
            pageSize,
            total: totalCount,
            totalPages,
            hasMore: page < totalPages,
        },
    });
});

/**
 * 获取所有投喂记录（支持分页）
 */
app.get('/records/donate', requireAdmin, async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '50');

    const offset = (page - 1) * pageSize;
    const records = donateQueries.getAllPaginated.all(pageSize, offset);
    const totalCount = donateQueries.count.get()!.count;
    const totalPages = Math.ceil(totalCount / pageSize);

    // 解析 failed_keys JSON
    const processedRecords = records.map((r) => ({
        ...r,
        failed_keys: r.failed_keys ? JSON.parse(r.failed_keys) : [],
    }));

    return c.json({
        success: true,
        data: processedRecords,
        pagination: {
            page,
            pageSize,
            total: totalCount,
            totalPages,
            hasMore: page < totalPages,
        },
    });
});

/**
 * 获取老虎机记录（分页）
 */
app.get('/records/slot', requireAdmin, async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '50');

    const offset = (page - 1) * pageSize;
    const records = slotQueries.getAllRecordsPaginated.all(pageSize, offset);
    const totalCount = slotQueries.countRecords.get()!.count;
    const totalPages = Math.ceil(totalCount / pageSize);

    return c.json({
        success: true,
        data: records,
        pagination: {
            page,
            pageSize,
            total: totalCount,
            totalPages,
            hasMore: page < totalPages,
        },
    });
});

/**
 * 获取老虎机配置
 */
app.get('/slot/config', requireAdmin, async (c) => {
    const config = slotQueries.getConfig.get();
    return c.json({
        success: true,
        data: config
    });
});

/**
 * 更新老虎机配置
 */
app.post('/slot/config', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();
        const { bet_amount, max_daily_spins, min_quota_required, enabled, background_type } = body;

        // 验证参数
        if (bet_amount !== undefined && (typeof bet_amount !== 'number' || bet_amount < 0)) {
            return c.json({ success: false, message: '投注金额必须是非负数' }, 400);
        }
        if (max_daily_spins !== undefined && (typeof max_daily_spins !== 'number' || max_daily_spins < 0)) {
            return c.json({ success: false, message: '每日次数必须是非负数' }, 400);
        }
        if (min_quota_required !== undefined && (typeof min_quota_required !== 'number' || min_quota_required < 0)) {
            return c.json({ success: false, message: '最低额度必须是非负数' }, 400);
        }
        if (enabled !== undefined && typeof enabled !== 'number') {
            return c.json({ success: false, message: '启用状态必须是数字' }, 400);
        }
        if (background_type !== undefined && !['default', 'gif'].includes(background_type)) {
            return c.json({ success: false, message: '背景类型必须是 default 或 gif' }, 400);
        }

        const now = Date.now();
        const currentConfig = slotQueries.getConfig.get();

        slotQueries.updateConfig.run(
            bet_amount !== undefined ? bet_amount : currentConfig!.bet_amount,
            max_daily_spins !== undefined ? max_daily_spins : currentConfig!.max_daily_spins,
            min_quota_required !== undefined ? min_quota_required : currentConfig!.min_quota_required,
            enabled !== undefined ? enabled : currentConfig!.enabled,
            background_type !== undefined ? background_type : currentConfig!.background_type,
            now
        );

        return c.json({
            success: true,
            message: '老虎机配置已更新',
            data: slotQueries.getConfig.get()
        });
    } catch (error: any) {
        console.error('更新老虎机配置失败:', error);
        return c.json({ success: false, message: '更新失败' }, 500);
    }
});

/**
 * 获取符号权重配置
 */
app.get('/slot/weights', requireAdmin, async (c) => {
    try {
        const weights = slotQueries.getWeights.get();
        return c.json({
            success: true,
            data: weights || {
                weight_m: 100,
                weight_t: 100,
                weight_n: 100,
                weight_j: 100,
                weight_lq: 100,
                weight_bj: 100,
                weight_zft: 100,
                weight_bdk: 100,
                weight_lsh: 25
            }
        });
    } catch (error: any) {
        console.error('获取符号权重失败:', error);
        return c.json({ success: false, message: '获取符号权重失败' }, 500);
    }
});

/**
 * 更新符号权重配置
 */
app.post('/slot/weights', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();
        const { weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh } = body;

        // 验证所有权重都是正整数
        const weights = [weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh];
        for (const weight of weights) {
            if (weight !== undefined && (typeof weight !== 'number' || weight < 1 || weight > 1000)) {
                return c.json({ success: false, message: '权重必须是1-1000之间的整数' }, 400);
            }
        }

        const now = Date.now();
        const currentWeights = slotQueries.getWeights.get();

        slotQueries.updateWeights.run(
            weight_m !== undefined ? weight_m : currentWeights!.weight_m,
            weight_t !== undefined ? weight_t : currentWeights!.weight_t,
            weight_n !== undefined ? weight_n : currentWeights!.weight_n,
            weight_j !== undefined ? weight_j : currentWeights!.weight_j,
            weight_lq !== undefined ? weight_lq : currentWeights!.weight_lq,
            weight_bj !== undefined ? weight_bj : currentWeights!.weight_bj,
            weight_zft !== undefined ? weight_zft : currentWeights!.weight_zft,
            weight_bdk !== undefined ? weight_bdk : currentWeights!.weight_bdk,
            weight_lsh !== undefined ? weight_lsh : currentWeights!.weight_lsh,
            now
        );

        console.log('[管理员] 符号权重已更新:', body);

        return c.json({
            success: true,
            message: '符号权重已更新',
            data: slotQueries.getWeights.get()
        });
    } catch (error: any) {
        console.error('更新符号权重失败:', error);
        return c.json({ success: false, message: '更新失败' }, 500);
    }
});

/**
 * 获取老虎机抽奖分析数据
 */
app.get('/slot/analytics', requireAdmin, async (c) => {
    try {
        // 获取所有老虎机记录
        const allRecords = slotQueries.getAllRecords.all();

        // 基础统计
        const totalCount = allRecords.length;
        const totalBet = allRecords.reduce((sum, r) => sum + r.bet_amount, 0);
        const totalWin = allRecords.reduce((sum, r) => sum + r.win_amount, 0);
        const netProfit = totalWin - totalBet;

        // 按中奖类型统计
        const winTypes: Record<string, { count: number; totalWin: number; avgWin: number }> = {
            'super_jackpot': { count: 0, totalWin: 0, avgWin: 0 },
            'special_combo': { count: 0, totalWin: 0, avgWin: 0 },
            'quad': { count: 0, totalWin: 0, avgWin: 0 },
            'triple': { count: 0, totalWin: 0, avgWin: 0 },
            'double': { count: 0, totalWin: 0, avgWin: 0 },
            'punishment': { count: 0, totalWin: 0, avgWin: 0 },
            'none': { count: 0, totalWin: 0, avgWin: 0 }
        };

        allRecords.forEach(r => {
            if (winTypes[r.win_type]) {
                winTypes[r.win_type].count++;
                winTypes[r.win_type].totalWin += r.win_amount;
            }
        });

        // 计算平均值和概率
        Object.keys(winTypes).forEach(key => {
            const type = winTypes[key];
            type.avgWin = type.count > 0 ? type.totalWin / type.count : 0;
        });

        const winCount = allRecords.filter(r => r.win_amount > 0).length;
        const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;

        // 获取最近的游戏记录（最多100条）
        const recentRecords = allRecords.slice(0, 100).map(r => ({
            ...r,
            result_symbols: JSON.parse(r.result_symbols),
            timestamp: r.timestamp,
            date: r.date
        }));

        // 按用户统计
        const userStats = slotQueries.getLeaderboard.all(100);

        // 每日统计（最近7天）
        const dailyStats: Record<string, { count: number; bet: number; win: number; profit: number }> = {};
        const today = new Date();

        for (let i = 0; i < 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            dailyStats[dateStr] = { count: 0, bet: 0, win: 0, profit: 0 };
        }

        allRecords.forEach(r => {
            if (dailyStats[r.date]) {
                dailyStats[r.date].count++;
                dailyStats[r.date].bet += r.bet_amount;
                dailyStats[r.date].win += r.win_amount;
                dailyStats[r.date].profit = dailyStats[r.date].win - dailyStats[r.date].bet;
            }
        });

        return c.json({
            success: true,
            data: {
                summary: {
                    totalCount,
                    totalBet,
                    totalWin,
                    netProfit,
                    winCount,
                    winRate
                },
                winTypes,
                recentRecords,
                userStats: userStats.slice(0, 100), // 增加到100名用于排行榜
                allRecords, // 添加所有记录（用于筛选）
                dailyStats
            }
        });
    } catch (error: any) {
        console.error('获取抽奖分析数据失败:', error);
        return c.json({ success: false, message: '获取分析数据失败' }, 500);
    }
});

/**
 * 导出所有 Keys
 */
app.get('/keys/export', requireAdmin, async (c) => {
    const keys = keyQueries.getAll.all();
    return c.json({ success: true, data: keys });
});

/**
 * 测试 Keys
 */
app.post('/keys/test', requireAdmin, async (c) => {
    const { keys } = await c.req.json();

    if (!Array.isArray(keys) || keys.length === 0) {
        return c.json({ success: false, message: 'Keys 不能为空' }, 400);
    }

    const { validateIFlowKey } = await import('../services/keys');

    const results: any[] = [];
    for (const keyItem of keys) {
        let keyValue: string;
        let keyType: string;

        // 支持两种格式
        if (typeof keyItem === 'string') {
            keyValue = keyItem;
            keyType = 'modelscope';  // 默认
        } else {
            keyValue = keyItem.key;
            keyType = keyItem.key_type || 'modelscope';
        }

        // 根据类型调用不同的验证函数
        const isValid = keyType === 'iflow'
            ? await validateIFlowKey(keyValue)
            : await validateModelScopeKey(keyValue);

        results.push({
            key: keyValue,
            key_type: keyType,
            valid: isValid
        });
    }

    return c.json({ success: true, data: results });
});

/**
 * 删除 Keys
 */
app.post('/keys/delete', requireAdmin, async (c) => {
    const { keys } = await c.req.json();

    if (!Array.isArray(keys) || keys.length === 0) {
        return c.json({ success: false, message: 'Keys 不能为空' }, 400);
    }

    for (const keyItem of keys) {
        // 支持两种格式：字符串（旧格式）或对象（新格式带 key_type）
        if (typeof keyItem === 'string') {
            // 旧格式：删除所有类型的该 key
            keyQueries.delete.run(keyItem, 'modelscope');
            keyQueries.delete.run(keyItem, 'iflow');
        } else if (keyItem.key && keyItem.key_type) {
            // 新格式：只删除指定类型的 key
            keyQueries.delete.run(keyItem.key, keyItem.key_type);
        }
    }

    console.log(`[管理员] 🗑️ 删除 Keys - 数量: ${keys.length}`);
    return c.json({
        success: true,
        message: `成功删除 ${keys.length} 个Key`,
    });
});

/**
 * 获取用户列表（支持分页）
 */
app.get('/users', requireAdmin, async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '20');

    // 获取所有用户
    const users = userQueries.getAll.all();

    // 获取所有领取和投喂记录
    const claimRecords = claimQueries.getAll.all();
    const donateRecords = donateQueries.getAll.all();

    // 统计每个用户的数据
    const userStats = users.map((user) => {
        const userClaims = claimRecords.filter(
            (r) => r.linux_do_id === user.linux_do_id
        );
        const userDonates = donateRecords.filter(
            (r) => r.linux_do_id === user.linux_do_id
        );

        const totalClaimCount = userClaims.length;
        const totalClaimQuota = userClaims.reduce(
            (sum, r) => sum + r.quota_added,
            0
        );
        const totalDonateCount = userDonates.reduce(
            (sum, r) => sum + r.keys_count,
            0
        );
        const totalDonateQuota = userDonates.reduce(
            (sum, r) => sum + r.total_quota_added,
            0
        );

        return {
            username: user.username,
            linux_do_id: user.linux_do_id,
            created_at: user.created_at,
            is_banned: user.is_banned || 0,
            banned_at: user.banned_at,
            banned_reason: user.banned_reason,
            claim_count: totalClaimCount,
            claim_quota: totalClaimQuota,
            donate_count: totalDonateCount,
            donate_quota: totalDonateQuota,
            total_quota: totalClaimQuota + totalDonateQuota,
        };
    });

    // 按总额度排序
    userStats.sort((a, b) => b.total_quota - a.total_quota);

    // 分页
    const totalCount = userStats.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedData = userStats.slice(offset, offset + pageSize);

    return c.json({
        success: true,
        data: paginatedData,
        pagination: {
            page,
            pageSize,
            total: totalCount,
            totalPages,
            hasMore: page < totalPages,
        },
    });
});

/**
 * 导出用户数据
 */
app.get('/export/users', requireAdmin, async (c) => {
    try {
        // 获取所有用户
        const users = userQueries.getAll.all();

        // 获取所有领取和投喂记录
        const claimRecords = claimQueries.getAll.all();
        const donateRecords = donateQueries.getAll.all();

        // 构建导出数据
        const exportData = {
            export_time: new Date().toISOString(),
            total_users: users.length,
            users: users
                .map((user) => {
                    const userClaims = claimRecords.filter(
                        (r) => r.linux_do_id === user.linux_do_id
                    );
                    const userDonates = donateRecords.filter(
                        (r) => r.linux_do_id === user.linux_do_id
                    );

                    const totalClaimCount = userClaims.length;
                    const totalClaimQuota = userClaims.reduce(
                        (sum, r) => sum + r.quota_added,
                        0
                    );
                    const totalDonateCount = userDonates.reduce(
                        (sum, r) => sum + r.keys_count,
                        0
                    );
                    const totalDonateQuota = userDonates.reduce(
                        (sum, r) => sum + r.total_quota_added,
                        0
                    );

                    return {
                        username: user.username,
                        linux_do_id: user.linux_do_id,
                        kyx_user_id: user.kyx_user_id,
                        created_at: user.created_at,
                        created_date: new Date(user.created_at).toLocaleString('zh-CN'),
                        statistics: {
                            claim_count: totalClaimCount,
                            claim_quota: totalClaimQuota,
                            claim_quota_cny: (totalClaimQuota / 500000).toFixed(2),
                            donate_count: totalDonateCount,
                            donate_quota: totalDonateQuota,
                            donate_quota_cny: (totalDonateQuota / 500000).toFixed(2),
                            total_quota: totalClaimQuota + totalDonateQuota,
                            total_quota_cny: (
                                (totalClaimQuota + totalDonateQuota) /
                                500000
                            ).toFixed(2),
                        },
                    };
                })
                .sort((a, b) => b.statistics.total_quota - a.statistics.total_quota),
        };

        // 返回 JSON 文件
        const filename = `users_export_${new Date().toISOString().split('T')[0]}.json`;

        return c.json(exportData, 200, {
            'Content-Disposition': `attachment; filename="${filename}"`,
        });
    } catch (e: any) {
        console.error('导出用户数据失败:', e);
        return c.json(
            {
                success: false,
                message: '导出失败: ' + (e.message || '未知错误'),
            },
            500
        );
    }
});

/**
 * 重新绑定用户
 */
app.post('/rebind-user', requireAdmin, async (c) => {
    const { linux_do_id, new_username } = await c.req.json();

    if (!linux_do_id || !new_username) {
        return c.json({ success: false, message: '参数错误' }, 400);
    }

    // 获取当前用户
    const currentUser = userQueries.get.get(linux_do_id);
    if (!currentUser) {
        return c.json({ success: false, message: '用户不存在' }, 404);
    }

    const adminConfig = adminQueries.get.get();
    if (!adminConfig || !adminConfig.session) {
        return c.json(
            {
                success: false,
                message: '系统配置错误，请联系管理员',
            },
            500
        );
    }

    // 搜索新用户名
    const searchResult = await searchAndFindExactUser(
        new_username,
        adminConfig.session,
        adminConfig.new_api_user,
        '管理员重新绑定'
    );

    if (!searchResult.success) {
        return c.json(
            {
                success: false,
                message: searchResult.message || '未找到该用户',
            },
            404
        );
    }

    const kyxUser = searchResult.user!;

    // 验证 Linux Do ID 是否匹配
    if (kyxUser.linux_do_id !== linux_do_id) {
        return c.json(
            {
                success: false,
                message: `Linux Do ID 不匹配，当前用户的 Linux Do ID 是 ${linux_do_id}，但搜索到的用户 ${new_username} 的 Linux Do ID 是 ${kyxUser.linux_do_id}`,
            },
            400
        );
    }

    // 更新用户绑定
    userQueries.update.run(kyxUser.username, kyxUser.id, linux_do_id);

    // 清除缓存
    cacheManager.delete(`user:${linux_do_id}`);

    console.log(`[管理员] 🔄 重新绑定用户 - 从 ${currentUser.username} → ${kyxUser.username}, Linux Do ID: ${linux_do_id}`);
    return c.json({
        success: true,
        message: `用户重新绑定成功，从 ${currentUser.username} 更新为 ${kyxUser.username}`,
    });
});

/**
 * 重试推送失败的 Keys
 */
app.post('/retry-push', requireAdmin, async (c) => {
    const { linux_do_id, timestamp } = await c.req.json();

    if (!linux_do_id || !timestamp) {
        return c.json({ success: false, message: '参数错误' }, 400);
    }

    // 获取投喂记录
    const record = donateQueries.getByTimestamp.get(linux_do_id, timestamp);

    if (!record) {
        return c.json({ success: false, message: '未找到投喂记录' }, 404);
    }

    const failedKeys = record.failed_keys ? JSON.parse(record.failed_keys) : [];

    if (!failedKeys || failedKeys.length === 0) {
        return c.json({ success: false, message: '没有失败的 Keys' }, 400);
    }

    const adminConfig = adminQueries.get.get();
    if (!adminConfig || !adminConfig.keys_authorization) {
        return c.json({ success: false, message: '未配置推送授权' }, 500);
    }

    // 重新推送（使用 ModelScope Group ID，因为旧记录默认是 ModelScope）
    const pushResult = await pushKeysToGroup(
        failedKeys,
        adminConfig.keys_api_url,
        adminConfig.keys_authorization,
        adminConfig.modelscope_group_id
    );

    // 更新记录
    donateQueries.update.run(
        pushResult.success ? 'success' : 'failed',
        pushResult.message || (pushResult.success ? '推送成功' : '推送失败'),
        pushResult.success ? null : JSON.stringify(pushResult.failedKeys || failedKeys),
        linux_do_id,
        timestamp
    );

    return c.json({
        success: pushResult.success,
        message:
            pushResult.message ||
            (pushResult.success ? '重新推送成功' : '重新推送失败'),
    });
});

/**
 * 封禁用户
 */
app.post('/users/:linuxDoId/ban', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');
    const { reason } = await c.req.json();

    try {
        const user = userQueries.get.get(linuxDoId);
        userQueries.ban.run(Date.now(), reason || '违规行为', linuxDoId);
        console.log(`[管理员] 🚫 封禁用户 - 用户: ${user?.username || linuxDoId}, 原因: ${reason || '违规行为'}`);
        return c.json({ success: true, message: '用户已被封禁' });
    } catch (e: any) {
        console.error(`[管理员] ❌ 封禁用户失败 - Linux Do ID: ${linuxDoId}, 错误:`, e);
        return c.json({ success: false, message: '封禁失败' }, 500);
    }
});

/**
 * 解封用户
 */
app.post('/users/:linuxDoId/unban', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');

    try {
        const user = userQueries.get.get(linuxDoId);
        userQueries.unban.run(linuxDoId);
        console.log(`[管理员] ✅ 解封用户 - 用户: ${user?.username || linuxDoId}`);
        return c.json({ success: true, message: '用户已解封' });
    } catch (e: any) {
        console.error(`[管理员] ❌ 解封用户失败 - Linux Do ID: ${linuxDoId}, 错误:`, e);
        return c.json({ success: false, message: '解封失败' }, 500);
    }
});

/**
 * 解除用户绑定
 */
app.post('/users/:linuxDoId/unbind', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');

    try {
        const user = userQueries.get.get(linuxDoId);
        // 删除用户记录
        userQueries.delete.run(linuxDoId);

        // 清除缓存
        cacheManager.delete(`user:${linuxDoId}`);

        console.log(`[管理员] 🔓 解除用户绑定 - 用户: ${user?.username || linuxDoId}, Linux Do ID: ${linuxDoId}`);
        return c.json({ success: true, message: '用户绑定已解除' });
    } catch (e: any) {
        console.error(`[管理员] ❌ 解绑用户失败 - Linux Do ID: ${linuxDoId}, 错误:`, e);
        return c.json({ success: false, message: `解绑失败: ${e.message}` }, 500);
    }
});

/**
 * 搜索用户（支持用户名和Linux Do ID）
 */
app.get('/search-users', requireAdmin, async (c) => {
    const keyword = c.req.query('keyword') || '';
    
    if (!keyword || keyword.length < 2) {
        return c.json({ success: false, message: '搜索关键词至少2个字符' }, 400);
    }
    
    try {
        let users: any[] = [];
        
        // 如果是纯数字，按 Linux Do ID 搜索
        if (/^\d+$/.test(keyword)) {
            const user = userQueries.get.get(keyword);
            if (user) {
                users = [user];
            }
        } else {
            // 按用户名模糊搜索
            const searchPattern = `%${keyword}%`;
            users = userQueries.searchByUsername.all(searchPattern, searchPattern);
        }
        
        return c.json({
            success: true,
            data: users.map(u => ({
                linux_do_id: u.linux_do_id,
                username: u.username,
                linux_do_username: u.linux_do_username,
                kyx_user_id: u.kyx_user_id,
                is_banned: u.is_banned
            }))
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 搜索用户失败:', e);
        return c.json({ success: false, message: `搜索失败: ${e.message}` }, 500);
    }
});

/**
 * 发放免费次数（支持用户名或Linux Do ID）
 */
app.post('/grant-free-spins', requireAdmin, async (c) => {
    const { identifier, spins, reason } = await c.req.json();

    if (!identifier || !spins || typeof spins !== 'number' || spins <= 0) {
        return c.json({ success: false, message: '参数错误：请提供有效的用户标识和免费次数' }, 400);
    }

    if (spins > 100) {
        return c.json({ success: false, message: '单次发放次数不能超过100次' }, 400);
    }

    try {
        // 根据identifier类型查找用户
        let user = null;
        
        if (/^\d+$/.test(identifier)) {
            // 纯数字，按 Linux Do ID 查找
            user = userQueries.get.get(identifier);
        } else {
            // 按用户名查找（优先 linux_do_username，其次 username）
            user = userQueries.getByLinuxDoUsername.get(identifier);
            if (!user) {
                user = userQueries.getByUsername.get(identifier);
            }
        }
        
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取当前免费次数
        const currentFreeSpin = slotQueries.getFreeSpin.get(user.linux_do_id);
        const currentSpins = currentFreeSpin?.free_spins || 0;
        const now = Date.now();

        // 增加免费次数
        const newSpins = currentSpins + spins;
        slotQueries.setFreeSpin.run(
            user.linux_do_id,
            newSpins,
            currentFreeSpin?.banned_until || 0,
            now
        );

        console.log(`[管理员] 🎁 发放免费次数 - 用户: ${user.username} (${user.linux_do_id}), 发放次数: ${spins}, 原次数: ${currentSpins}, 新次数: ${newSpins}, 原因: ${reason || '管理员发放'}`);

        return c.json({
            success: true,
            message: `成功为用户 ${user.username} 发放 ${spins} 次免费抽奖机会`,
            data: {
                linux_do_id: user.linux_do_id,
                username: user.username,
                granted_spins: spins,
                previous_spins: currentSpins,
                total_spins: newSpins,
                reason: reason || '管理员发放'
            }
        });
    } catch (e: any) {
        console.error(`[管理员] ❌ 发放免费次数失败 - 标识: ${identifier}, 错误:`, e);
        return c.json({ success: false, message: `发放失败: ${e.message}` }, 500);
    }
});

/**
 * 批量发放免费次数（优化版，支持大批量）
 */
app.post('/grant-free-spins-batch', requireAdmin, async (c) => {
    const { identifiers, spins, reason } = await c.req.json();

    if (!Array.isArray(identifiers) || identifiers.length === 0) {
        return c.json({ success: false, message: '请提供有效的用户列表' }, 400);
    }

    if (!spins || typeof spins !== 'number' || spins <= 0) {
        return c.json({ success: false, message: '请提供有效的免费次数' }, 400);
    }

    if (spins > 100) {
        return c.json({ success: false, message: '单次发放次数不能超过100次' }, 400);
    }

    if (identifiers.length > 5000) {
        return c.json({ success: false, message: '单次批量发放用户不能超过5000个' }, 400);
    }

    const results = {
        success: 0,
        failed: 0,
        skipped: 0,
        details: [] as any[]
    };

    const now = Date.now();
    const batchSize = 100; // 每100个用户使用一次事务
    
    try {
        // 分批处理，避免单个事务太大
        for (let i = 0; i < identifiers.length; i += batchSize) {
            const batch = identifiers.slice(i, i + batchSize);
            
            // 使用事务批量处理
            db.exec('BEGIN TRANSACTION');
            
            try {
                for (const identifier of batch) {
                    try {
                        // 根据identifier类型查找用户
                        let user = null;
                        
                        if (/^\d+$/.test(identifier)) {
                            // 纯数字，按 Linux Do ID 查找
                            user = userQueries.get.get(identifier);
                        } else {
                            // 按用户名查找
                            user = userQueries.getByLinuxDoUsername.get(identifier);
                            if (!user) {
                                user = userQueries.getByUsername.get(identifier);
                            }
                        }
                        
                        if (!user) {
                            results.failed++;
                            results.details.push({
                                identifier,
                                success: false,
                                message: '用户不存在'
                            });
                            continue;
                        }

                        // 跳过已封禁用户
                        if (user.is_banned === 1) {
                            results.skipped++;
                            results.details.push({
                                identifier,
                                linux_do_id: user.linux_do_id,
                                username: user.username,
                                success: false,
                                message: '用户已封禁，跳过'
                            });
                            continue;
                        }

                        // 获取当前免费次数
                        const currentFreeSpin = slotQueries.getFreeSpin.get(user.linux_do_id);
                        const currentSpins = currentFreeSpin?.free_spins || 0;

                        // 增加免费次数
                        const newSpins = currentSpins + spins;
                        slotQueries.setFreeSpin.run(
                            user.linux_do_id,
                            newSpins,
                            currentFreeSpin?.banned_until || 0,
                            now
                        );

                        results.success++;
                        
                        // 只保存前100条详细信息（避免返回数据过大）
                        if (results.details.length < 100) {
                            results.details.push({
                                identifier,
                                linux_do_id: user.linux_do_id,
                                username: user.username,
                                success: true,
                                granted_spins: spins,
                                previous_spins: currentSpins,
                                total_spins: newSpins
                            });
                        }

                    } catch (e: any) {
                        results.failed++;
                        if (results.details.length < 100) {
                            results.details.push({
                                identifier,
                                success: false,
                                message: e.message
                            });
                        }
                    }
                }
                
                db.exec('COMMIT');
                
                // 每批处理后输出进度
                const progress = Math.min(i + batchSize, identifiers.length);
                console.log(`[管理员] 🎁 批量发放进度: ${progress}/${identifiers.length} (${((progress/identifiers.length)*100).toFixed(1)}%)`);
                
            } catch (e: any) {
                db.exec('ROLLBACK');
                console.error('[管理员] ❌ 批量发放事务失败:', e);
            }
        }
        
        console.log(`[管理员] 📊 批量发放免费次数完成 - 成功: ${results.success}, 失败: ${results.failed}, 跳过: ${results.skipped}, 原因: ${reason || '管理员批量发放'}`);

        return c.json({
            success: true,
            message: `批量发放完成：成功 ${results.success} 个，失败 ${results.failed} 个，跳过 ${results.skipped} 个`,
            data: {
                ...results,
                total: identifiers.length,
                details: results.details.length < identifiers.length 
                    ? results.details.concat([{ message: `...还有 ${identifiers.length - results.details.length} 条记录未显示` }])
                    : results.details
            }
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 批量发放免费次数失败:', e);
        return c.json({ success: false, message: `批量发放失败: ${e.message}` }, 500);
    }
});

/**
 * 给所有用户发放免费次数
 */
app.post('/grant-free-spins-all', requireAdmin, async (c) => {
    const { spins, reason } = await c.req.json();

    if (!spins || typeof spins !== 'number' || spins <= 0) {
        return c.json({ success: false, message: '请提供有效的免费次数' }, 400);
    }

    if (spins > 100) {
        return c.json({ success: false, message: '单次发放次数不能超过100次' }, 400);
    }

    try {
        // 获取所有未封禁用户的 Linux Do ID
        const allUsers = userQueries.getAllLinuxDoIds.all();
        
        if (allUsers.length === 0) {
            return c.json({ success: false, message: '没有可发放的用户' }, 404);
        }

        console.log(`[管理员] 🎁 开始给所有用户发放免费次数 - 用户数: ${allUsers.length}, 每人次数: ${spins}, 原因: ${reason || '全员发放'}`);

        const results = {
            success: 0,
            failed: 0,
            total: allUsers.length
        };

        const now = Date.now();
        const batchSize = 200; // 每200个用户一个事务
        
        // 分批处理
        for (let i = 0; i < allUsers.length; i += batchSize) {
            const batch = allUsers.slice(i, i + batchSize);
            
            db.exec('BEGIN TRANSACTION');
            
            try {
                for (const { linux_do_id } of batch) {
                    try {
                        const currentFreeSpin = slotQueries.getFreeSpin.get(linux_do_id);
                        const currentSpins = currentFreeSpin?.free_spins || 0;
                        const newSpins = currentSpins + spins;
                        
                        slotQueries.setFreeSpin.run(
                            linux_do_id,
                            newSpins,
                            currentFreeSpin?.banned_until || 0,
                            now
                        );
                        
                        results.success++;
                    } catch (e: any) {
                        results.failed++;
                        console.error(`[管理员] ❌ 发放失败 - Linux Do ID: ${linux_do_id}, 错误:`, e);
                    }
                }
                
                db.exec('COMMIT');
                
                // 输出进度
                const progress = Math.min(i + batchSize, allUsers.length);
                const percentage = ((progress / allUsers.length) * 100).toFixed(1);
                console.log(`[管理员] 🎁 全员发放进度: ${progress}/${allUsers.length} (${percentage}%)`);
                
            } catch (e: any) {
                db.exec('ROLLBACK');
                console.error('[管理员] ❌ 批量事务失败:', e);
            }
        }

        console.log(`[管理员] ✅ 全员发放完成 - 总数: ${results.total}, 成功: ${results.success}, 失败: ${results.failed}`);

        return c.json({
            success: true,
            message: `全员发放完成：成功 ${results.success} 个，失败 ${results.failed} 个`,
            data: results
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 全员发放免费次数失败:', e);
        return c.json({ success: false, message: `全员发放失败: ${e.message}` }, 500);
    }
});

/**
 * 查询用户免费次数（支持用户名或Linux Do ID）
 */
app.get('/users/:identifier/free-spins', requireAdmin, async (c) => {
    const identifier = c.req.param('identifier');

    try {
        // 根据identifier类型查找用户
        let user = null;
        
        if (/^\d+$/.test(identifier)) {
            user = userQueries.get.get(identifier);
        } else {
            user = userQueries.getByLinuxDoUsername.get(identifier);
            if (!user) {
                user = userQueries.getByUsername.get(identifier);
            }
        }
        
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        const freeSpin = slotQueries.getFreeSpin.get(user.linux_do_id);
        
        return c.json({
            success: true,
            data: {
                linux_do_id: user.linux_do_id,
                username: user.username,
                linux_do_username: user.linux_do_username,
                free_spins: freeSpin?.free_spins || 0,
                banned_until: freeSpin?.banned_until || 0,
                updated_at: freeSpin?.updated_at || 0
            }
        });
    } catch (e: any) {
        console.error(`[管理员] ❌ 查询用户免费次数失败 - 标识: ${identifier}, 错误:`, e);
        return c.json({ success: false, message: `查询失败: ${e.message}` }, 500);
    }
});

/**
 * 获取所有待发放奖金记录
 */
app.get('/pending-rewards', requireAdmin, async (c) => {
    try {
        const { pendingRewardQueries } = await import('../database');

        // 获取所有待发放的奖金（pending 或 failed 状态）
        const pendingRewards = pendingRewardQueries.getPending.all();

        // 统计信息
        const stats = {
            total: pendingRewards.length,
            totalAmount: pendingRewards.reduce((sum: number, r: any) => sum + r.reward_amount, 0),
            byStatus: {
                pending: pendingRewards.filter((r: any) => r.status === 'pending').length,
                failed: pendingRewards.filter((r: any) => r.status === 'failed').length,
                processing: pendingRewards.filter((r: any) => r.status === 'processing').length,
            }
        };

        // 格式化数据
        const formattedRewards = pendingRewards.map((r: any) => ({
            id: r.id,
            linux_do_id: r.linux_do_id,
            kyx_user_id: r.kyx_user_id,
            username: r.username,
            reward_amount: r.reward_amount,
            reward_amount_cny: (r.reward_amount / 500000).toFixed(2),
            reason: r.reason,
            status: r.status,
            retry_count: r.retry_count,
            error_message: r.error_message,
            created_at: r.created_at,
            updated_at: r.updated_at,
            processed_at: r.processed_at,
            created_date: new Date(r.created_at).toLocaleString('zh-CN'),
            updated_date: new Date(r.updated_at).toLocaleString('zh-CN'),
        }));

        console.log(`[管理员] 📋 查询待发放奖金 - 总数: ${stats.total}, 总金额: $${(stats.totalAmount / 500000).toFixed(2)}`);

        return c.json({
            success: true,
            data: formattedRewards,
            stats: {
                ...stats,
                totalAmountCny: (stats.totalAmount / 500000).toFixed(2)
            }
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 获取待发放奖金失败:', e);
        return c.json({ success: false, message: `获取失败: ${e.message}` }, 500);
    }
});

/**
 * 手动触发发放待发放奖金（一键发放）
 */
app.post('/pending-rewards/process', requireAdmin, async (c) => {
    try {
        console.log('[管理员] 🎁 手动触发待发放奖金处理');

        const result = await manualProcessRewards();

        console.log(`[管理员] ✅ 待发放奖金处理完成 - 成功: ${result.success}, 失败: ${result.failed}`);

        return c.json({
            success: true,
            message: `处理完成：成功 ${result.success} 条，失败 ${result.failed} 条`,
            data: result
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 处理待发放奖金失败:', e);
        return c.json({ success: false, message: `处理失败: ${e.message}` }, 500);
    }
});

/**
 * 删除待发放奖金记录（谨慎操作）
 */
app.delete('/pending-rewards/:id', requireAdmin, async (c) => {
    const id = parseInt(c.req.param('id'));

    try {
        const { pendingRewardQueries, db } = await import('../database');

        // 获取记录信息
        const reward = pendingRewardQueries.getById.get(id);
        if (!reward) {
            return c.json({ success: false, message: '记录不存在' }, 404);
        }

        // 删除记录
        const deleteStmt = db.prepare('DELETE FROM pending_rewards WHERE id = ?');
        deleteStmt.run(id);

        console.log(`[管理员] 🗑️ 删除待发放奖金记录 - ID: ${id}, 用户: ${reward.username}, 金额: $${(reward.reward_amount / 500000).toFixed(2)}`);

        return c.json({
            success: true,
            message: '记录已删除'
        });
    } catch (e: any) {
        console.error(`[管理员] ❌ 删除待发放奖金记录失败 - ID: ${id}, 错误:`, e);
        return c.json({ success: false, message: `删除失败: ${e.message}` }, 500);
    }
});

/**
 * 重置待发放奖金状态（将 failed 改为 pending 以便重试）
 */
app.post('/pending-rewards/:id/retry', requireAdmin, async (c) => {
    const id = parseInt(c.req.param('id'));

    try {
        const { pendingRewardQueries } = await import('../database');

        // 获取记录信息
        const reward = pendingRewardQueries.getById.get(id);
        if (!reward) {
            return c.json({ success: false, message: '记录不存在' }, 404);
        }

        // 重置状态为 pending，清空错误信息
        const now = Date.now();
        pendingRewardQueries.updateStatus.run('pending', now, null, id);

        console.log(`[管理员] 🔄 重置待发放奖金状态 - ID: ${id}, 用户: ${reward.username}`);

        return c.json({
            success: true,
            message: '已重置为待发放状态，将在下次自动处理'
        });
    } catch (e: any) {
        console.error(`[管理员] ❌ 重置待发放奖金状态失败 - ID: ${id}, 错误:`, e);
        return c.json({ success: false, message: `重置失败: ${e.message}` }, 500);
    }
});

export default app;

