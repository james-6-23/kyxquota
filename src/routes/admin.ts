import { Hono } from 'hono';
import { getCookie, getSession, saveSession, generateSessionId, setCookie } from '../utils';
import {
    adminQueries,
    claimQueries,
    donateQueries,
    keyQueries,
    userQueries,
} from '../database';
import { cacheManager } from '../cache';
import { CONFIG } from '../config';
import { searchAndFindExactUser, pushKeysToGroup } from '../services/kyx-api';
import { validateModelScopeKey } from '../services/keys';
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
        return c.json({ success: false, message: '密码错误' }, 401);
    }

    const sessionId = generateSessionId();
    await saveSession(sessionId, { admin: true });

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
            keys_authorization_configured: !!config!.keys_authorization,
            modelscope_group_id: config!.modelscope_group_id,
            iflow_group_id: config!.iflow_group_id || 26,
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
        Date.now()
    );

    cacheManager.clear('admin_config');

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
        Date.now()
    );

    cacheManager.clear('admin_config');

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
        Date.now()
    );

    cacheManager.clear('admin_config');

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
        Date.now()
    );

    cacheManager.clear('admin_config');

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
        Date.now()
    );

    cacheManager.clear('admin_config');

    return c.json({ success: true, message: 'iFlow Group ID 已更新' });
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

    const results: any[] = [];
    for (const key of keys) {
        const isValid = await validateModelScopeKey(key);
        results.push({ key, valid: isValid });
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

    for (const key of keys) {
        keyQueries.delete.run(key);
    }

    return c.json({
        success: true,
        message: `成功删除 ${keys.length} 个Key`,
    });
});

/**
 * 获取用户列表
 */
app.get('/users', requireAdmin, async (c) => {
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

    return c.json({ success: true, data: userStats });
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
        userQueries.ban.run(Date.now(), reason || '违规行为', linuxDoId);
        return c.json({ success: true, message: '用户已被封禁' });
    } catch (e: any) {
        console.error('封禁用户失败:', e);
        return c.json({ success: false, message: '封禁失败' }, 500);
    }
});

/**
 * 解封用户
 */
app.post('/users/:linuxDoId/unban', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');

    try {
        userQueries.unban.run(linuxDoId);
        return c.json({ success: true, message: '用户已解封' });
    } catch (e: any) {
        console.error('解封用户失败:', e);
        return c.json({ success: false, message: '解封失败' }, 500);
    }
});

/**
 * 解除用户绑定
 */
app.post('/users/:linuxDoId/unbind', requireAdmin, async (c) => {
    const linuxDoId = c.req.param('linuxDoId');

    try {
        // 删除用户记录
        userQueries.delete.run(linuxDoId);

        // 清除缓存
        cacheManager.delete(`user:${linuxDoId}`);

        console.log('[Admin] 用户绑定已解除:', linuxDoId);
        return c.json({ success: true, message: '用户绑定已解除' });
    } catch (e: any) {
        console.error('解绑用户失败:', e);
        return c.json({ success: false, message: `解绑失败: ${e.message}` }, 500);
    }
});

export default app;

