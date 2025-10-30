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
    advancedSlotQueries,
    kunbeiQueries,
    db,
} from '../database';
import { cacheManager } from '../cache';
import { CONFIG } from '../config';
import { searchAndFindExactUser, pushKeysToGroup } from '../services/kyx-api';
import { validateModelScopeKey } from '../services/keys';
import { manualProcessRewards } from '../services/reward-processor';
import { checkOverdueLoans } from '../services/kunbei';
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
    // 只获取初级场记录（slot_mode = 'normal' 或 NULL）
    const records = slotQueries.getNormalRecordsPaginated.all(pageSize, offset);
    const totalCount = slotQueries.countNormalRecords.get()!.count;
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
        const { bet_amount, max_daily_spins, min_quota_required, enabled, background_type, buy_spins_enabled, buy_spins_price, max_daily_buy_spins } = body;

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
        if (buy_spins_enabled !== undefined && typeof buy_spins_enabled !== 'number') {
            return c.json({ success: false, message: '购买次数启用状态必须是数字' }, 400);
        }
        if (buy_spins_price !== undefined && (typeof buy_spins_price !== 'number' || buy_spins_price < 0)) {
            return c.json({ success: false, message: '购买价格必须是非负数' }, 400);
        }
        if (max_daily_buy_spins !== undefined && (typeof max_daily_buy_spins !== 'number' || max_daily_buy_spins < 0)) {
            return c.json({ success: false, message: '每日最大购买次数必须是非负数' }, 400);
        }

        const now = Date.now();
        const currentConfig = slotQueries.getConfig.get();

        slotQueries.updateConfig.run(
            bet_amount !== undefined ? bet_amount : currentConfig!.bet_amount,
            max_daily_spins !== undefined ? max_daily_spins : currentConfig!.max_daily_spins,
            min_quota_required !== undefined ? min_quota_required : currentConfig!.min_quota_required,
            enabled !== undefined ? enabled : currentConfig!.enabled,
            background_type !== undefined ? background_type : currentConfig!.background_type,
            buy_spins_enabled !== undefined ? buy_spins_enabled : currentConfig!.buy_spins_enabled,
            buy_spins_price !== undefined ? buy_spins_price : currentConfig!.buy_spins_price,
            max_daily_buy_spins !== undefined ? max_daily_buy_spins : currentConfig!.max_daily_buy_spins,
            now
        );

        console.log(`[管理员] ✅ 老虎机配置已更新 - 购买次数功能: ${buy_spins_enabled ? '开启' : '关闭'}`);

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
 * 获取奖励倍数配置
 */
app.get('/slot/multipliers', requireAdmin, async (c) => {
    try {
        const multipliers = slotQueries.getMultipliers.get();
        return c.json({
            success: true,
            data: multipliers || {
                super_jackpot_multiplier: 256,
                special_combo_multiplier: 16,
                quad_multiplier: 32,
                triple_multiplier: 8,
                double_multiplier: 4
            }
        });
    } catch (error: any) {
        console.error('获取奖励倍数失败:', error);
        return c.json({ success: false, message: '获取奖励倍数失败' }, 500);
    }
});

/**
 * 更新奖励倍数配置
 */
app.post('/slot/multipliers', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();
        const { super_jackpot_multiplier, special_combo_multiplier, quad_multiplier, triple_multiplier, double_multiplier } = body;

        // 验证所有倍数都是正整数
        const multipliers = [super_jackpot_multiplier, special_combo_multiplier, quad_multiplier, triple_multiplier, double_multiplier];
        for (const multiplier of multipliers) {
            if (multiplier !== undefined && (typeof multiplier !== 'number' || multiplier < 1 || multiplier > 10000)) {
                return c.json({ success: false, message: '倍数必须是1-10000之间的整数' }, 400);
            }
        }

        const now = Date.now();
        const currentMultipliers = slotQueries.getMultipliers.get();

        slotQueries.updateMultipliers.run(
            super_jackpot_multiplier !== undefined ? super_jackpot_multiplier : currentMultipliers!.super_jackpot_multiplier,
            special_combo_multiplier !== undefined ? special_combo_multiplier : currentMultipliers!.special_combo_multiplier,
            quad_multiplier !== undefined ? quad_multiplier : currentMultipliers!.quad_multiplier,
            triple_multiplier !== undefined ? triple_multiplier : currentMultipliers!.triple_multiplier,
            double_multiplier !== undefined ? double_multiplier : currentMultipliers!.double_multiplier,
            now
        );

        console.log('[管理员] 奖励倍数已更新:', body);

        return c.json({
            success: true,
            message: '奖励倍数已更新',
            data: slotQueries.getMultipliers.get()
        });
    } catch (error: any) {
        console.error('更新奖励倍数失败:', error);
        return c.json({ success: false, message: '更新失败' }, 500);
    }
});

/**
 * 获取老虎机抽奖分析数据
 */
app.get('/slot/analytics', requireAdmin, async (c) => {
    try {
        // 🔥 获取筛选参数
        const limit = parseInt(c.req.query('limit') || '500');  // 默认500条
        const mode = c.req.query('mode') || 'all';  // all, normal, advanced

        // 获取所有老虎机记录
        const allRecords = slotQueries.getAllRecords.all();

        // 🔥 根据模式筛选
        let filteredRecords = allRecords;
        if (mode === 'normal') {
            filteredRecords = allRecords.filter(r => r.slot_mode === 'normal' || r.slot_mode === null);
        } else if (mode === 'advanced') {
            filteredRecords = allRecords.filter(r => r.slot_mode === 'advanced');
        }

        // 🔥 限制记录数量（取最新的N条）
        const records = filteredRecords.slice(0, limit);

        // 基础统计
        const totalCount = records.length;
        const totalBet = records.reduce((sum, r) => sum + r.bet_amount, 0);
        const totalWin = records.reduce((sum, r) => sum + r.win_amount, 0);
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

        records.forEach(r => {
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

        const winCount = records.filter(r => r.win_amount > 0).length;
        const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;

        // 获取最近的游戏记录（最多100条）
        const recentRecords = records.slice(0, 100).map(r => ({
            ...r,
            result_symbols: JSON.parse(r.result_symbols),
            timestamp: r.timestamp,
            date: r.date
        }));

        // 按用户统计（盈利榜和亏损榜）
        const userStats = slotQueries.getLeaderboard.all(100);
        const lossStats = slotQueries.getLossLeaderboard.all(100);

        // 每日统计（最近7天）
        const dailyStats: Record<string, { count: number; bet: number; win: number; profit: number }> = {};
        const today = new Date();

        for (let i = 0; i < 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            dailyStats[dateStr] = { count: 0, bet: 0, win: 0, profit: 0 };
        }

        records.forEach(r => {
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
                userStats: userStats.slice(0, 100), // 盈利排行榜
                lossStats: lossStats.slice(0, 100), // 亏损排行榜
                dailyStats,
                filters: { limit, mode }  // 🔥 返回当前筛选条件
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
 * 获取封禁用户列表
 */
app.get('/users/banned', requireAdmin, async (c) => {
    try {
        // 获取用户表中的永久封禁用户
        const bannedUsers = userQueries.getBannedUsers.all();

        // 获取老虎机临时封禁（banned_until）
        const freeSpinsBans = slotQueries.getAllFreeSpin.all()
            .filter(fs => fs.banned_until && fs.banned_until > 0)
            .map(fs => {
                const user = userQueries.get.get(fs.linux_do_id);
                return {
                    linux_do_id: fs.linux_do_id,
                    username: user?.username || fs.linux_do_id,
                    linux_do_username: user?.linux_do_username || null,
                    banned_until: fs.banned_until
                };
            });

        return c.json({
            success: true,
            data: {
                users: bannedUsers,
                freeSpinsBans: freeSpinsBans
            }
        });
    } catch (error: any) {
        console.error('[管理员] 获取封禁用户列表失败:', error);
        return c.json({ success: false, message: '获取封禁列表失败' }, 500);
    }
});

/**
 * 解封用户（同时清除永久封禁和临时封禁）
 */
app.post('/users/:linuxDoId/unban', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');

    try {
        const user = userQueries.get.get(linuxDoId);

        // 清除用户表的封禁
        userQueries.unban.run(linuxDoId);

        // 🔥 同时清除老虎机临时封禁（banned_until）
        const now = Date.now();
        slotQueries.setFreeSpin.run(linuxDoId, 0, 0, now);  // 重置banned_until为0

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
                console.log(`[管理员] 🎁 批量发放进度: ${progress}/${identifiers.length} (${((progress / identifiers.length) * 100).toFixed(1)}%)`);

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
 * 发放入场券
 */
app.post('/grant-tickets', requireAdmin, async (c) => {
    const { linux_do_id, count, reason } = await c.req.json();

    if (!linux_do_id) {
        return c.json({ success: false, message: '参数错误：缺少用户ID' }, 400);
    }

    if (!count || typeof count !== 'number' || count <= 0 || count > 10) {
        return c.json({ success: false, message: '入场券数量必须在1-10之间' }, 400);
    }

    try {
        const user = userQueries.get.get(linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 调用添加入场券的服务函数
        const { addTicket } = await import('../services/advanced-slot');
        const result = addTicket(linux_do_id, count);

        if (result.success) {
            console.log(`[管理员] ✅ 发放入场券成功 - 用户: ${user.username}, 数量: ${result.granted || count}, 原因: ${reason || '管理员发放'}`);
            return c.json({
                success: true,
                message: result.message || `成功发放 ${result.granted || count} 张入场券`,
                data: { granted: result.granted || count }
            });
        } else {
            return c.json({ success: false, message: result.message || '发放失败' }, 400);
        }
    } catch (error: any) {
        console.error('[管理员] 发放入场券失败:', error);
        return c.json({ success: false, message: '发放失败: ' + error.message }, 500);
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
 * 获取所有待发放奖金记录（包括历史记录）
 */
app.get('/pending-rewards', requireAdmin, async (c) => {
    try {
        // 获取所有奖金记录（包括成功的）
        const allRewards = pendingRewardQueries.getAll.all();

        // 统计信息（区分待处理和已完成）
        const stats = {
            total: allRewards.length,
            totalAmount: allRewards.reduce((sum: number, r: any) => sum + r.reward_amount, 0),
            byStatus: {
                pending: allRewards.filter((r: any) => r.status === 'pending').length,
                processing: allRewards.filter((r: any) => r.status === 'processing').length,
                failed: allRewards.filter((r: any) => r.status === 'failed').length,
                success: allRewards.filter((r: any) => r.status === 'success').length,
            },
            // 待处理金额（pending + processing + failed）
            pendingAmount: allRewards
                .filter((r: any) => ['pending', 'processing', 'failed'].includes(r.status))
                .reduce((sum: number, r: any) => sum + r.reward_amount, 0),
            // 已发放金额
            successAmount: allRewards
                .filter((r: any) => r.status === 'success')
                .reduce((sum: number, r: any) => sum + r.reward_amount, 0),
        };

        // 格式化数据
        const formattedRewards = allRewards.map((r: any) => ({
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
            created_date: new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }),
            updated_date: new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false }),
        }));

        console.log(`[管理员] 📋 查询待发放奖金 - 总数: ${stats.total}, 待处理: ${stats.byStatus.pending + stats.byStatus.processing + stats.byStatus.failed}, 已完成: ${stats.byStatus.success}`);

        return c.json({
            success: true,
            data: formattedRewards,
            stats: {
                ...stats,
                totalAmountCny: (stats.totalAmount / 500000).toFixed(2),
                pendingAmountCny: (stats.pendingAmount / 500000).toFixed(2),
                successAmountCny: (stats.successAmount / 500000).toFixed(2),
            }
        });
    } catch (e: any) {
        console.error('[管理员] ❌ 获取待发放奖金失败:', e);
        return c.json({ success: false, message: `获取失败: ${e.message}` }, 500);
    }
});

/**
 * 手动触发发放待发放奖金（一键发放）
 * 优化版：立即返回，后台异步处理
 */
app.post('/pending-rewards/process', requireAdmin, async (c) => {
    try {
        console.log('[管理员] 🎁 手动触发待发放奖金处理');

        const result = await manualProcessRewards();

        if (result.total === 0) {
            return c.json({
                success: true,
                message: '没有待发放的奖金记录',
                data: result
            });
        }

        console.log(`[管理员] ✅ 已触发异步处理 - 总数: ${result.total}`);

        return c.json({
            success: true,
            message: `已开始处理 ${result.total} 条记录，请稍后刷新查看结果`,
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

// ========== 高级场管理 API ==========

/**
 * 获取高级场配置
 */
app.get('/slot/advanced/config', requireAdmin, async (c) => {
    try {
        let config = advancedSlotQueries.getAdvancedConfig.get();

        // 🔥 如果配置不存在，创建默认配置
        if (!config) {
            console.log('[管理员] 高级场配置不存在，创建默认配置');
            const now = Date.now();
            db.exec(`
                INSERT OR IGNORE INTO advanced_slot_config (
                    id, enabled, bet_min, bet_max, reward_multiplier, penalty_weight_factor, 
                    rtp_target, ticket_valid_hours, session_valid_hours, fragments_needed, 
                    drop_rate_triple, drop_rate_double, max_tickets_hold, daily_bet_limit, 
                    daily_entry_limit, daily_ticket_grant_limit, updated_at
                )
                VALUES (1, 1, 50000000, 250000000, 4.0, 2.0, 0.88, 24, 24, 5, 1.0, 1.0, 2, 5000000000, 2, 2, ${now})
            `);

            // 重新查询
            config = advancedSlotQueries.getAdvancedConfig.get();
        }

        // 处理所有可能的 null 值，使用默认值替换
        const safeConfig = {
            id: config?.id || 1,
            enabled: config?.enabled ?? 1,
            bet_min: config?.bet_min || 50000000,
            bet_max: config?.bet_max || 250000000,
            reward_multiplier: config?.reward_multiplier || 4.0,
            penalty_weight_factor: config?.penalty_weight_factor || 2.0,
            rtp_target: config?.rtp_target || 0.88,
            ticket_valid_hours: config?.ticket_valid_hours || 24,
            session_valid_hours: config?.session_valid_hours || 24,
            fragments_needed: config?.fragments_needed || 5,
            drop_rate_triple: config?.drop_rate_triple || 1.0,
            drop_rate_double: config?.drop_rate_double || 1.0,
            max_tickets_hold: config?.max_tickets_hold || 2,
            daily_bet_limit: config?.daily_bet_limit || 5000000000,
            daily_entry_limit: config?.daily_entry_limit || 2,
            daily_ticket_grant_limit: config?.daily_ticket_grant_limit || 2,
            updated_at: config?.updated_at || Date.now()
        };

        return c.json({
            success: true,
            data: safeConfig
        });
    } catch (e: any) {
        console.error('[管理员] 获取高级场配置失败:', e);
        return c.json({ success: false, message: '获取配置失败: ' + e.message }, 500);
    }
});

/**
 * 更新高级场配置
 */
app.post('/slot/advanced/config', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();

        const {
            enabled,
            bet_min,
            bet_max,
            reward_multiplier,
            penalty_weight_factor,
            rtp_target,
            ticket_valid_hours,
            session_valid_hours,
            fragments_needed,
            drop_rate_triple,
            drop_rate_double,
            max_tickets_hold,
            daily_bet_limit,
            daily_entry_limit,
            daily_ticket_grant_limit
        } = body;

        // 验证参数
        if (bet_min >= bet_max) {
            return c.json({ success: false, message: '最小投注必须小于最大投注' }, 400);
        }

        const now = Date.now();
        advancedSlotQueries.updateAdvancedConfig.run(
            enabled ? 1 : 0,
            bet_min,
            bet_max,
            reward_multiplier,
            penalty_weight_factor,
            rtp_target,
            ticket_valid_hours,
            session_valid_hours,
            fragments_needed,
            drop_rate_triple,
            drop_rate_double,
            max_tickets_hold,
            daily_bet_limit,
            daily_entry_limit || 2,         // 默认每日2次
            daily_ticket_grant_limit || 2,  // 默认每日获得2张
            now
        );

        console.log('[管理员] ✅ 高级场配置已更新:', body);

        return c.json({
            success: true,
            message: '配置已更新'
        });
    } catch (e: any) {
        console.error('[管理员] 更新高级场配置失败:', e);
        return c.json({ success: false, message: '更新配置失败' }, 500);
    }
});

/**
 * 获取高级场游戏记录
 */
app.get('/slot/advanced/records', requireAdmin, async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '50');

        // 查询高级场记录（slot_mode = 'advanced'）
        const records = db.query(`
            SELECT * FROM slot_machine_records 
            WHERE slot_mode = 'advanced'
            ORDER BY timestamp DESC 
            LIMIT ? OFFSET ?
        `).all(pageSize, (page - 1) * pageSize);

        const totalResult = db.query(`
            SELECT COUNT(*) as total FROM slot_machine_records WHERE slot_mode = 'advanced'
        `).get() as { total: number };

        const total = totalResult?.total || 0;

        // 统计信息
        const statsResult = db.query(`
            SELECT 
                COUNT(*) as count,
                COALESCE(SUM(bet_amount), 0) as total_bet,
                COALESCE(SUM(win_amount), 0) as total_win
            FROM slot_machine_records 
            WHERE slot_mode = 'advanced'
        `).get() as { count: number, total_bet: number, total_win: number };

        return c.json({
            success: true,
            data: {
                records,
                total,
                page,
                pageSize,
                stats: statsResult
            }
        });
    } catch (e: any) {
        console.error('[管理员] 获取高级场记录失败:', e);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 获取高级场分析数据
 */
app.get('/slot/advanced/analytics', requireAdmin, async (c) => {
    try {
        // 获取所有老虎机记录
        const allRecords = slotQueries.getAllRecords.all();

        // 筛选高级场记录（slot_mode = 'advanced'）
        const advancedRecords = allRecords.filter(r => r.slot_mode === 'advanced');

        // 基础统计（基于高级场记录）
        const totalCount = advancedRecords.length;
        const totalBet = advancedRecords.reduce((sum, r) => sum + r.bet_amount, 0);
        const totalWin = advancedRecords.reduce((sum, r) => sum + r.win_amount, 0);
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

        advancedRecords.forEach(r => {
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

        const winCount = advancedRecords.filter(r => r.win_amount > 0).length;
        const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;

        // 获取最近的游戏记录（最多100条）
        const recentRecords = advancedRecords.slice(0, 100).map(r => ({
            ...r,
            result_symbols: JSON.parse(r.result_symbols),
            timestamp: r.timestamp,
            date: r.date
        }));

        // 获取高级场RTP统计
        const rtpStats = advancedSlotQueries.getAllRTPStats.all();

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
                rtpStats,
                allRecords: advancedRecords // 添加高级场记录（用于筛选）
            }
        });
    } catch (error: any) {
        console.error('[管理员] 获取高级场分析数据失败:', error);
        return c.json({ success: false, message: '获取分析数据失败' }, 500);
    }
});

/**
 * 获取入场券掉落记录
 */
app.get('/slot/tickets/drop-records', requireAdmin, async (c) => {
    try {
        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '50');

        const records = advancedSlotQueries.getAllDropRecords.all();

        // 手动分页
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const paginatedRecords = records.slice(start, end);

        // 统计信息
        const ticketDrops = records.filter(r => r.drop_type === 'ticket').length;
        const fragmentDrops = records.filter(r => r.drop_type === 'fragment').length;
        const today = new Date().toISOString().split('T')[0];
        const todayDrops = records.filter(r => r.date === today).length;

        return c.json({
            success: true,
            data: {
                records: paginatedRecords,
                total: records.length,
                page,
                pageSize,
                stats: {
                    total: records.length,
                    ticket_drops: ticketDrops,
                    fragment_drops: fragmentDrops,
                    today_drops: todayDrops
                }
            }
        });
    } catch (e: any) {
        console.error('[管理员] 获取掉落记录失败:', e);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 获取高级场RTP统计
 */
app.get('/slot/advanced/rtp-stats', requireAdmin, async (c) => {
    try {
        const stats = advancedSlotQueries.getAllRTPStats.all();

        return c.json({
            success: true,
            data: stats
        });
    } catch (e: any) {
        console.error('[管理员] 获取RTP统计失败:', e);
        return c.json({ success: false, message: '获取统计失败' }, 500);
    }
});

/**
 * 获取高级场符号权重配置
 */
app.get('/slot/advanced/weights', requireAdmin, async (c) => {
    try {
        let weights = advancedSlotQueries.getAdvancedWeights.get();

        // 🔥 如果权重配置不存在，创建默认配置
        if (!weights) {
            console.log('[管理员] 高级场符号权重不存在，创建默认配置');
            const now = Date.now();
            db.exec(`
                INSERT OR IGNORE INTO advanced_slot_symbol_weights (
                    id, weight_m, weight_t, weight_n, weight_j, weight_lq, 
                    weight_bj, weight_zft, weight_bdk, weight_lsh, updated_at
                )
                VALUES (1, 100, 100, 100, 100, 100, 100, 100, 100, 50, ${now})
            `);

            // 重新查询
            weights = advancedSlotQueries.getAdvancedWeights.get();
        }

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
                weight_lsh: 50
            }
        });
    } catch (e: any) {
        console.error('[管理员] 获取高级场符号权重失败:', e);
        return c.json({ success: false, message: '获取权重失败: ' + e.message }, 500);
    }
});

/**
 * 更新高级场符号权重配置
 */
app.post('/slot/advanced/weights', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();
        const { weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh } = body;

        // 验证所有权重都是有效数字
        const weights = [weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh];
        if (weights.some(w => isNaN(w) || w < 1 || w > 1000)) {
            return c.json({ success: false, message: '权重必须在1-1000之间' }, 400);
        }

        const now = Date.now();
        advancedSlotQueries.updateAdvancedWeights.run(
            weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh,
            now
        );

        console.log('[管理员] ✅ 高级场符号权重已更新:', body);

        return c.json({
            success: true,
            message: '高级场权重配置已更新'
        });
    } catch (e: any) {
        console.error('[管理员] 更新高级场符号权重失败:', e);
        return c.json({ success: false, message: '更新权重失败' }, 500);
    }
});

// ========== 坤呗贷款管理API ==========

/**
 * 获取坤呗配置
 */
app.get('/kunbei/config', requireAdmin, async (c) => {
    try {
        const config = kunbeiQueries.getConfig.get();
        return c.json({ success: true, data: config });
    } catch (error: any) {
        return c.json({ success: false, message: '获取配置失败' }, 500);
    }
});

/**
 * 更新坤呗配置
 */
app.post('/kunbei/config', requireAdmin, async (c) => {
    try {
        const config = await c.req.json();
        const now = Date.now();

        kunbeiQueries.updateConfig.run(
            config.enabled,
            config.max_loan_amount,
            config.min_loan_amount,
            config.repay_multiplier,
            config.loan_duration_hours,
            config.early_repay_discount,
            config.overdue_penalty_hours,
            config.overdue_ban_advanced,
            config.max_active_loans,
            config.deduct_all_quota_on_overdue || 0,
            now
        );

        return c.json({ success: true, message: '配置已保存' });
    } catch (error: any) {
        console.error('[坤呗管理] 保存配置失败:', error);
        return c.json({ success: false, message: '保存失败' }, 500);
    }
});

/**
 * 获取所有借款记录
 */
app.get('/kunbei/loans', requireAdmin, async (c) => {
    try {
        const loans = kunbeiQueries.getAllLoans.all();
        const activeLoans = kunbeiQueries.getActiveLoans.all();
        const overdueLoans = kunbeiQueries.getOverdueLoans.all();

        const stats = {
            active_count: activeLoans.length,
            overdue_count: overdueLoans.length,
            total_loan: loans.reduce((sum, l) => sum + l.loan_amount, 0),
            total_repaid: loans.filter(l => l.status === 'repaid').reduce((sum, l) => sum + (l.actual_repay_amount || 0), 0)
        };

        return c.json({
            success: true,
            data: { loans, stats }
        });
    } catch (error: any) {
        console.error('[坤呗管理] 获取借款记录失败:', error);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 获取所有借款记录（带公益站用户名）
 */
app.get('/kunbei/all-loans', requireAdmin, async (c) => {
    try {
        // 立即检查逾期状态（确保数据最新）
        await checkOverdueLoans();

        const loans = kunbeiQueries.getAllLoans.all();

        // 获取所有相关用户信息
        const userIds = [...new Set(loans.map(l => l.linux_do_id))];
        const usersMap = new Map();

        for (const linuxDoId of userIds) {
            const user = userQueries.get.get(linuxDoId);
            if (user) {
                usersMap.set(linuxDoId, user.username);
            }
        }

        // 添加公益站用户名
        const loansWithKyxUsername = loans.map(loan => ({
            ...loan,
            kyx_username: usersMap.get(loan.linux_do_id) || null
        }));

        // 计算统计数据
        const stats = {
            total_count: loans.length,
            active_count: loans.filter(l => l.status === 'active').length,
            repaid_count: loans.filter(l => l.status === 'repaid').length,
            overdue_count: loans.filter(l => l.status === 'overdue').length,
            total_amount: loans.reduce((sum, l) => sum + l.loan_amount, 0),
            total_loaned: loans.reduce((sum, l) => sum + l.loan_amount, 0),
            total_repaid: loans.filter(l => l.status === 'repaid').reduce((sum, l) => sum + (l.actual_repay_amount || 0), 0)
        };

        return c.json({
            success: true,
            data: { loans: loansWithKyxUsername, stats }
        });
    } catch (error: any) {
        console.error('[坤呗管理] 获取全部借款记录失败:', error);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 豁免借款
 */
app.post('/kunbei/loans/:id/forgive', requireAdmin, async (c) => {
    try {
        const loanId = parseInt(c.req.param('id'));
        const { forgiveLoan } = await import('../services/kunbei');

        const result = forgiveLoan(loanId);
        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗管理] 豁免失败:', error);
        return c.json({ success: false, message: '豁免失败' }, 500);
    }
});

/**
 * 获取坤呗梯度配置列表
 */
app.get('/kunbei/gradient-configs', requireAdmin, async (c) => {
    try {
        const { getAllGradientConfigs } = await import('../services/kunbei');
        const configs = getAllGradientConfigs();
        return c.json({ success: true, data: configs });
    } catch (error: any) {
        console.error('[坤呗管理] 获取梯度配置失败:', error);
        return c.json({ success: false, message: '获取梯度配置失败' }, 500);
    }
});

/**
 * 创建坤呗梯度配置
 */
app.post('/kunbei/gradient-configs', requireAdmin, async (c) => {
    try {
        const body = await c.req.json();
        const { createGradientConfig } = await import('../services/kunbei');

        const result = createGradientConfig({
            quota_threshold: body.quota_threshold,
            max_loan_amount: body.max_loan_amount,
            priority: body.priority || 0,
            is_active: body.is_active !== undefined ? body.is_active : 1
        });

        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗管理] 创建梯度配置失败:', error);
        return c.json({ success: false, message: '创建梯度配置失败' }, 500);
    }
});

/**
 * 更新坤呗梯度配置
 */
app.put('/kunbei/gradient-configs/:id', requireAdmin, async (c) => {
    try {
        const id = parseInt(c.req.param('id'));
        const body = await c.req.json();
        const { updateGradientConfig } = await import('../services/kunbei');

        const result = updateGradientConfig(id, {
            quota_threshold: body.quota_threshold,
            max_loan_amount: body.max_loan_amount,
            priority: body.priority || 0,
            is_active: body.is_active !== undefined ? body.is_active : 1
        });

        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗管理] 更新梯度配置失败:', error);
        return c.json({ success: false, message: '更新梯度配置失败' }, 500);
    }
});

/**
 * 删除坤呗梯度配置
 */
app.delete('/kunbei/gradient-configs/:id', requireAdmin, async (c) => {
    try {
        const id = parseInt(c.req.param('id'));
        const { deleteGradientConfig } = await import('../services/kunbei');

        const result = deleteGradientConfig(id);
        return c.json(result);
    } catch (error: any) {
        console.error('[坤呗管理] 删除梯度配置失败:', error);
        return c.json({ success: false, message: '删除梯度配置失败' }, 500);
    }
});

// ========== 权重配置管理API ==========

/**
 * 获取所有权重配置
 */
app.get('/weights', requireAdmin, async (c) => {
    try {
        const { weightConfigQueries } = await import('../database');
        const configs = weightConfigQueries.getAll.all();

        // 获取每个配置的使用情况
        const configsWithUsage = configs.map((config: any) => {
            const usageInfo = weightConfigQueries.getUsageInfo.get(config.id, config.id, config.id);
            const usageCount = usageInfo?.usage_count || 0;

            // 查询具体使用场次
            const { slotQueries, advancedSlotQueries, supremeSlotQueries } = weightConfigQueries;
            // 简化：通过数据库查询获取使用场次

            return {
                ...config,
                usage_count: usageCount
            };
        });

        return c.json({
            success: true,
            data: configsWithUsage
        });
    } catch (error: any) {
        console.error('[权重配置] 获取配置失败:', error);
        return c.json({ success: false, message: '获取配置失败' }, 500);
    }
});

/**
 * 添加权重配置
 */
app.post('/weights', requireAdmin, async (c) => {
    try {
        const { weightConfigQueries } = await import('../database');
        const body = await c.req.json();
        const { config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, description } = body;

        if (!config_name) {
            return c.json({ success: false, message: '配置名称不能为空' }, 400);
        }

        const now = Date.now();
        weightConfigQueries.insert.run(
            config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, description, now, now
        );

        return c.json({ success: true, message: '配置已添加' });
    } catch (error: any) {
        console.error('[权重配置] 添加配置失败:', error);
        return c.json({ success: false, message: '添加配置失败: ' + error.message }, 500);
    }
});

/**
 * 更新权重配置
 */
app.put('/weights/:id', requireAdmin, async (c) => {
    try {
        const { weightConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));
        const body = await c.req.json();
        const { config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, description } = body;

        const now = Date.now();
        weightConfigQueries.update.run(
            config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, description, now, id
        );

        return c.json({ success: true, message: '配置已更新' });
    } catch (error: any) {
        console.error('[权重配置] 更新配置失败:', error);
        return c.json({ success: false, message: '更新配置失败' }, 500);
    }
});

/**
 * 删除权重配置
 */
app.delete('/weights/:id', requireAdmin, async (c) => {
    try {
        const { weightConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));

        // 检查是否被使用
        const usageInfo = weightConfigQueries.getUsageInfo.get(id, id, id);
        if (usageInfo && usageInfo.usage_count > 0) {
            return c.json({
                success: false,
                message: '该配置正在被使用，无法删除。请先将相关场次切换到其他配置。'
            }, 400);
        }

        const now = Date.now();
        weightConfigQueries.softDelete.run(now, id);

        return c.json({ success: true, message: '配置已删除' });
    } catch (error: any) {
        console.error('[权重配置] 删除配置失败:', error);
        return c.json({ success: false, message: '删除配置失败' }, 500);
    }
});

// ========== 奖励配置管理API ==========

/**
 * 获取所有奖励方案
 */
app.get('/rewards/schemes', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const schemes = rewardConfigQueries.getAllSchemes.all();

        const schemesWithDetails = schemes.map((scheme: any) => {
            const rules = rewardConfigQueries.getRulesByScheme.all(scheme.id);
            const punishments = rewardConfigQueries.getPunishmentsByScheme.all(scheme.id);
            const usageInfo = rewardConfigQueries.getSchemeUsageInfo.get(scheme.id, scheme.id, scheme.id);

            return {
                ...scheme,
                rules_count: rules.length,
                has_punishment: punishments.length > 0,
                usage_count: usageInfo?.usage_count || 0
            };
        });

        return c.json({
            success: true,
            data: schemesWithDetails
        });
    } catch (error: any) {
        console.error('[奖励配置] 获取方案失败:', error);
        return c.json({ success: false, message: '获取方案失败' }, 500);
    }
});

/**
 * 获取方案详情（含所有规则）
 */
app.get('/rewards/schemes/:id', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));

        const scheme = rewardConfigQueries.getSchemeById.get(id);
        if (!scheme) {
            return c.json({ success: false, message: '方案不存在' }, 404);
        }

        const rules = rewardConfigQueries.getRulesByScheme.all(id);
        const punishments = rewardConfigQueries.getPunishmentsByScheme.all(id);

        return c.json({
            success: true,
            data: {
                scheme,
                rules,
                punishments
            }
        });
    } catch (error: any) {
        console.error('[奖励配置] 获取方案详情失败:', error);
        return c.json({ success: false, message: '获取方案详情失败' }, 500);
    }
});

/**
 * 添加奖励方案
 */
app.post('/rewards/schemes', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const { scheme_name, description } = await c.req.json();

        if (!scheme_name) {
            return c.json({ success: false, message: '方案名称不能为空' }, 400);
        }

        const now = Date.now();
        rewardConfigQueries.insertScheme.run(scheme_name, description, now, now);

        return c.json({ success: true, message: '方案已添加' });
    } catch (error: any) {
        console.error('[奖励配置] 添加方案失败:', error);
        return c.json({ success: false, message: '添加方案失败: ' + error.message }, 500);
    }
});

/**
 * 更新奖励方案
 */
app.put('/rewards/schemes/:id', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));
        const { scheme_name, description } = await c.req.json();

        const now = Date.now();
        rewardConfigQueries.updateScheme.run(scheme_name, description, now, id);

        return c.json({ success: true, message: '方案已更新' });
    } catch (error: any) {
        console.error('[奖励配置] 更新方案失败:', error);
        return c.json({ success: false, message: '更新方案失败' }, 500);
    }
});

/**
 * 删除奖励方案
 */
app.delete('/rewards/schemes/:id', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));

        // 检查是否被使用
        const usageInfo = rewardConfigQueries.getSchemeUsageInfo.get(id, id, id);
        if (usageInfo && usageInfo.usage_count > 0) {
            return c.json({
                success: false,
                message: '该方案正在被使用，无法删除。请先将相关场次切换到其他方案。'
            }, 400);
        }

        const now = Date.now();
        rewardConfigQueries.softDeleteScheme.run(now, id);

        return c.json({ success: true, message: '方案已删除' });
    } catch (error: any) {
        console.error('[奖励配置] 删除方案失败:', error);
        return c.json({ success: false, message: '删除方案失败' }, 500);
    }
});

/**
 * 添加规则到方案
 */
app.post('/rewards/rules', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const body = await c.req.json();
        const { scheme_id, rule_name, rule_type, rule_category, match_pattern, match_count, required_symbols, win_multiplier, grant_free_spin, priority, description } = body;

        const now = Date.now();
        rewardConfigQueries.insertRule.run(
            scheme_id, rule_name, rule_type, rule_category, match_pattern, match_count || null, required_symbols || null, win_multiplier, grant_free_spin || 0, priority || 0, 1, description || null, now, now
        );

        return c.json({ success: true, message: '规则已添加' });
    } catch (error: any) {
        console.error('[奖励配置] 添加规则失败:', error);
        return c.json({ success: false, message: '添加规则失败' }, 500);
    }
});

/**
 * 更新规则
 */
app.put('/rewards/rules/:id', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));
        const body = await c.req.json();
        const { rule_name, rule_type, rule_category, match_pattern, match_count, required_symbols, win_multiplier, grant_free_spin, priority, is_active, description } = body;

        const now = Date.now();
        rewardConfigQueries.updateRule.run(
            rule_name, rule_type, rule_category, match_pattern, match_count || null, required_symbols || null, win_multiplier, grant_free_spin || 0, priority || 0, is_active !== undefined ? is_active : 1, description || null, now, id
        );

        return c.json({ success: true, message: '规则已更新' });
    } catch (error: any) {
        console.error('[奖励配置] 更新规则失败:', error);
        return c.json({ success: false, message: '更新规则失败' }, 500);
    }
});

/**
 * 删除规则
 */
app.delete('/rewards/rules/:id', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const id = parseInt(c.req.param('id'));

        rewardConfigQueries.deleteRule.run(id);

        return c.json({ success: true, message: '规则已删除' });
    } catch (error: any) {
        console.error('[奖励配置] 删除规则失败:', error);
        return c.json({ success: false, message: '删除规则失败' }, 500);
    }
});

/**
 * 更新律师函惩罚配置
 */
app.post('/rewards/punishments', requireAdmin, async (c) => {
    try {
        const { rewardConfigQueries } = await import('../database');
        const { scheme_id, punishments } = await c.req.json();

        if (!scheme_id || !Array.isArray(punishments)) {
            return c.json({ success: false, message: '参数错误' }, 400);
        }

        const now = Date.now();

        // 批量更新律师函惩罚配置
        for (const p of punishments) {
            rewardConfigQueries.upsertPunishment.run(
                scheme_id, p.lsh_count, p.deduct_multiplier, p.ban_hours || 0, p.is_active !== undefined ? p.is_active : 1, now, now,
                // ON CONFLICT部分
                p.deduct_multiplier, p.ban_hours || 0, p.is_active !== undefined ? p.is_active : 1, now
            );
        }

        return c.json({ success: true, message: '律师函惩罚配置已更新' });
    } catch (error: any) {
        console.error('[奖励配置] 更新律师函配置失败:', error);
        return c.json({ success: false, message: '更新失败' }, 500);
    }
});

// ========== 至尊场管理API ==========

/**
 * 获取至尊场配置
 */
app.get('/supreme/config', requireAdmin, async (c) => {
    try {
        const { supremeSlotQueries } = await import('../database');
        const config = supremeSlotQueries.getConfig.get();

        return c.json({
            success: true,
            data: config
        });
    } catch (error: any) {
        console.error('[至尊场管理] 获取配置失败:', error);
        return c.json({ success: false, message: '获取配置失败' }, 500);
    }
});

/**
 * 更新至尊场配置
 */
app.post('/supreme/config', requireAdmin, async (c) => {
    try {
        const { supremeSlotQueries } = await import('../database');
        const body = await c.req.json();
        const { enabled, fragments_to_token, max_tokens_hold, token_valid_hours, session_valid_hours, min_bet_amount, max_bet_amount, bet_step, daily_entry_limit, daily_token_grant_limit, daily_bet_limit, weight_config_id, reward_scheme_id } = body;

        const now = Date.now();
        supremeSlotQueries.updateConfig.run(
            enabled, fragments_to_token, max_tokens_hold, token_valid_hours, session_valid_hours,
            min_bet_amount, max_bet_amount, bet_step, daily_entry_limit, daily_token_grant_limit,
            daily_bet_limit, weight_config_id, reward_scheme_id, now
        );

        return c.json({ success: true, message: '至尊场配置已更新' });
    } catch (error: any) {
        console.error('[至尊场管理] 更新配置失败:', error);
        return c.json({ success: false, message: '更新配置失败' }, 500);
    }
});

/**
 * 获取至尊场游戏记录
 */
app.get('/supreme/records', requireAdmin, async (c) => {
    try {
        const { supremeSlotQueries } = await import('../database');
        const records = supremeSlotQueries.getAllRecords.all();

        return c.json({
            success: true,
            data: records
        });
    } catch (error: any) {
        console.error('[至尊场管理] 获取记录失败:', error);
        return c.json({ success: false, message: '获取记录失败' }, 500);
    }
});

/**
 * 获取至尊令牌掉落记录
 */
app.get('/supreme/drop-records', requireAdmin, async (c) => {
    try {
        const { supremeSlotQueries } = await import('../database');
        const records = supremeSlotQueries.getAllDropRecords.all();

        return c.json({
            success: true,
            data: records
        });
    } catch (error: any) {
        console.error('[至尊场管理] 获取掉落记录失败:', error);
        return c.json({ success: false, message: '获取掉落记录失败' }, 500);
    }
});

export default app;

