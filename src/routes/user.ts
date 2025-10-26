import { Hono } from 'hono';
import { getCookie, getSession, deleteSession, setCookie } from '../utils';
import { userQueries, claimQueries, donateQueries, adminQueries } from '../database';
import { cacheManager } from '../cache';
import {
    searchAndFindExactUser,
    updateKyxUserQuota,
    getKyxUserById,
} from '../services/kyx-api';
import { validateAndDonateKeys } from '../services/keys';
import { addUserFreeSpins, getUserFreeSpins } from '../services/slot';
import { CONFIG } from '../config';
import type { User } from '../types';

const app = new Hono();

/**
 * 中间件：验证用户登录
 */
async function requireAuth(c: any, next: any) {
    const sessionId = getCookie(c.req.raw.headers, 'session_id');
    if (!sessionId) {
        return c.json({ success: false, message: '未登录' }, 401);
    }

    const session = await getSession(sessionId);
    if (!session || !session.linux_do_id) {
        return c.json({ success: false, message: '会话无效' }, 401);
    }

    // 检查用户是否被封禁
    const user = userQueries.get.get(session.linux_do_id);
    if (user && user.is_banned) {
        console.log(`[用户操作] ❌ 已封禁用户尝试访问 - Linux Do ID: ${session.linux_do_id}, 原因: ${user.banned_reason || '未知'}`);
        return c.json({
            success: false,
            message: `您的账号已被封禁${user.banned_reason ? '，原因：' + user.banned_reason : ''}`,
            banned: true
        }, 403);
    }

    c.set('session', session);
    await next();
}

/**
 * 绑定公益站账号
 */
app.post('/auth/bind', requireAuth, async (c) => {
    const session = c.get('session');
    const { username } = await c.req.json();

    if (!username) {
        return c.json({ success: false, message: '用户名不能为空' }, 400);
    }

    // 获取管理员配置
    const adminConfig = await cacheManager.getOrLoad(
        'admin_config',
        async () => {
            const config = adminQueries.get.get();
            return (
                config || {
                    session: '',
                    new_api_user: '1',
                    claim_quota: CONFIG.DEFAULT_CLAIM_QUOTA,
                    keys_api_url: '',
                    keys_authorization: '',
                    group_id: 26,
                    updated_at: Date.now(),
                }
            );
        },
        300000
    );

    if (!adminConfig.session) {
        return c.json(
            {
                success: false,
                message: '系统配置错误，请联系管理员',
            },
            500
        );
    }

    // 搜索用户
    const searchResult = await searchAndFindExactUser(
        username,
        adminConfig.session,
        adminConfig.new_api_user,
        '绑定'
    );

    if (!searchResult.success) {
        if (
            searchResult.message?.includes('未登录') ||
            searchResult.message?.includes('无权进行此操作')
        ) {
            return c.json(
                {
                    success: false,
                    message: '系统配置错误，请联系管理员',
                },
                500
            );
        }
        return c.json(
            {
                success: false,
                message:
                    searchResult.message ||
                    '未找到该用户，请确认用户名输入正确。\n提示：用户名需要与公益站完全一致。',
            },
            404
        );
    }

    const kyxUser = searchResult.user!;

    // 验证 Linux Do ID 是否匹配
    console.log(
        '[绑定] 验证 Linux Do ID - 输入:',
        session.linux_do_id,
        '公益站:',
        kyxUser.linux_do_id
    );

    if (kyxUser.linux_do_id !== session.linux_do_id) {
        return c.json(
            {
                success: false,
                message: `Linux Do ID 不匹配！\n您当前登录的 Linux Do ID: ${session.linux_do_id}\n用户 ${username} 的 Linux Do ID: ${kyxUser.linux_do_id}\n请使用正确的 Linux Do 账号登录后再绑定此用户名。`,
            },
            400
        );
    }

    // 检查是否已经绑定过
    const existingUser = userQueries.get.get(session.linux_do_id);
    const isFirstBind = !existingUser;

    // 保存绑定信息（同时保存LinuxDo用户名）
    if (isFirstBind) {
        userQueries.insert.run(
            session.linux_do_id,
            kyxUser.username,
            session.username || '',
            kyxUser.id,
            Date.now()
        );
        console.log(`[用户操作] ✅ 新用户绑定 - LinuxDo用户: ${session.username}, 公益站用户: ${kyxUser.username}, Linux Do ID: ${session.linux_do_id}, KYX ID: ${kyxUser.id}`);
    } else {
        userQueries.update.run(
            kyxUser.username,
            session.username || '',
            kyxUser.id,
            session.linux_do_id
        );
        console.log(`[用户操作] 🔄 重新绑定 - LinuxDo用户: ${session.username}, 公益站用户: ${kyxUser.username}, Linux Do ID: ${session.linux_do_id}`);
    }

    // 清除缓存
    cacheManager.delete(`user:${session.linux_do_id}`);
    cacheManager.clear(`kyx_user:${kyxUser.id}`);

    // 如果是首次绑定，赠送新手额度
    if (isFirstBind) {
        const bonusQuota = 50000000;
        const newQuota = kyxUser.quota + bonusQuota;

        console.log('[绑定] 首次绑定，赠送额度:', bonusQuota);

        const updateResult = await updateKyxUserQuota(
            kyxUser.id,
            newQuota,
            adminConfig.session,
            adminConfig.new_api_user,
            kyxUser.username,
            kyxUser.group || 'default'
        );

        if (!updateResult || !updateResult.success) {
            console.error(`[绑定] ❌ 发放新手奖励失败 - 用户: ${kyxUser.username}, 错误: ${updateResult?.message || '未知错误'}`);
            // 绑定成功但奖励发放失败，告知用户
            return c.json({
                success: true,
                message: `绑定成功！但新手奖励发放失败（${updateResult?.message || '未知错误'}），请联系管理员补发`,
                data: {
                    kyx_user: kyxUser,
                    quota_before: kyxUser.quota,
                    bonus_quota: bonusQuota,
                    bonus_failed: true
                }
            });
        }

        // 保存绑定奖励记录到领取记录表
        const today = new Date().toISOString().split('T')[0];
        const timestamp = Date.now();
        claimQueries.insert.run(
            session.linux_do_id,
            kyxUser.username,
            bonusQuota,
            timestamp,
            today
        );
        console.log(`[用户操作] 🎁 新手奖励发放成功 - 用户: ${kyxUser.username}, 奖励: $${(bonusQuota / 500000).toFixed(2)}`);

        return c.json({
            success: true,
            message: `绑定成功！已赠送新手奖励 $${(bonusQuota / 500000).toFixed(2)}`,
            data: {
                kyx_user: kyxUser,
                quota_before: kyxUser.quota,
                quota_after: newQuota,
                bonus: bonusQuota,
                bonusCNY: (bonusQuota / 500000).toFixed(2),
            },
        });
    } else {
        return c.json({
            success: true,
            message: '重新绑定成功',
            data: {
                kyx_user: kyxUser,
            },
        });
    }
});

/**
 * 查询用户额度
 */
app.get('/user/quota', requireAuth, async (c) => {
    const session = c.get('session');

    // 从数据库获取用户信息
    const user = await cacheManager.getOrLoad(
        `user:${session.linux_do_id}`,
        async () => {
            return userQueries.get.get(session.linux_do_id);
        },
        300000
    );

    if (!user) {
        return c.json({ success: false, message: '未绑定账号' }, 400);
    }

    // 获取管理员配置
    const adminConfig = await cacheManager.getOrLoad(
        'admin_config',
        async () => adminQueries.get.get(),
        300000
    );

    // 优化：直接通过 kyx_user_id 查询，避免每次都搜索用户
    const cacheKey = `kyx_user:${user.kyx_user_id}:quota`;
    const kyxUserResult = await cacheManager.getOrLoad(
        cacheKey,
        async () => {
            return await getKyxUserById(
                user.kyx_user_id,
                adminConfig!.session,
                adminConfig!.new_api_user
            );
        },
        30000 // 缓存30秒，确保额度信息较实时
    );

    if (!kyxUserResult.success || !kyxUserResult.user) {
        if (
            kyxUserResult.message?.includes('未登录') ||
            kyxUserResult.message?.includes('无权进行此操作')
        ) {
            return c.json(
                {
                    success: false,
                    message: '系统配置错误，请联系管理员',
                },
                500
            );
        }
        return c.json(
            {
                success: false,
                message: kyxUserResult.message || '查询额度失败',
            },
            500
        );
    }

    const kyxUser = kyxUserResult.user!;

    // 检查今日是否已领取
    const today = new Date().toISOString().split('T')[0];
    const claimToday = await cacheManager.getOrLoad(
        `claim:${user.linux_do_id}:${today}`,
        async () => {
            return claimQueries.getToday.get(user.linux_do_id, today);
        },
        3600000 // 1小时
    );

    // 检查今日投喂情况（按类型分别统计）
    const todayStart = new Date(today || '').getTime();
    const todayEnd = todayStart + 86400000;
    const allDonates = donateQueries.getByUser.all(user.linux_do_id);
    const todayDonates = allDonates.filter(
        (r) => r.timestamp >= todayStart && r.timestamp < todayEnd
    );

    // 统计今日各类型投喂次数
    const today_donate_modelscope_count = todayDonates.filter(r => r.key_type === 'modelscope' || !r.key_type).length;
    const today_donate_iflow_count = todayDonates.filter(r => r.key_type === 'iflow').length;

    // 获取投喂限制配置
    const max_daily_donate_modelscope = adminConfig?.max_daily_donate_modelscope || 1;
    const max_daily_donate_iflow = adminConfig?.max_daily_donate_iflow || 1;

    // 计算剩余投喂次数
    const remaining_donate_modelscope = Math.max(0, max_daily_donate_modelscope - today_donate_modelscope_count);
    const remaining_donate_iflow = Math.max(0, max_daily_donate_iflow - today_donate_iflow_count);

    // 计算今日已领取次数（排除绑定奖励）
    const allClaims = claimQueries.getByUser.all(user.linux_do_id);
    const todayClaims = allClaims.filter(
        (r) => r.timestamp >= todayStart && r.timestamp < todayEnd && r.quota_added !== 50000000
    );
    const today_claim_count = todayClaims.length;

    // 获取管理员配置的最大领取次数
    const max_daily_claims = adminConfig?.max_daily_claims || 1;
    const remaining_claims = Math.max(0, max_daily_claims - today_claim_count);

    return c.json({
        success: true,
        data: {
            username: kyxUser.username,
            display_name: kyxUser.display_name,
            linux_do_id: user.linux_do_id,
            linux_do_username: session.username || '',
            avatar_url: session.avatar_url || '',
            name: session.name || kyxUser.username,
            quota: kyxUser.quota,
            used_quota: kyxUser.used_quota,
            total: kyxUser.quota + kyxUser.used_quota,
            can_claim: kyxUser.quota < CONFIG.MIN_QUOTA_THRESHOLD && remaining_claims > 0,
            claimed_today: !!claimToday,
            // 投喂相关信息
            today_donate_modelscope_count: today_donate_modelscope_count,
            today_donate_iflow_count: today_donate_iflow_count,
            max_daily_donate_modelscope: max_daily_donate_modelscope,
            max_daily_donate_iflow: max_daily_donate_iflow,
            remaining_donate_modelscope: remaining_donate_modelscope,
            remaining_donate_iflow: remaining_donate_iflow,
            // 兼容旧版前端
            donated_modelscope_today: today_donate_modelscope_count >= max_daily_donate_modelscope,
            donated_iflow_today: today_donate_iflow_count >= max_daily_donate_iflow,
            // 领取相关信息
            today_claim_count: today_claim_count,
            max_daily_claims: max_daily_claims,
            remaining_claims: remaining_claims,
        },
    });
});

/**
 * 每日领取额度
 */
app.post('/claim/daily', requireAuth, async (c) => {
    const session = c.get('session');

    // 获取用户信息
    const user = userQueries.get.get(session.linux_do_id);
    if (!user) {
        return c.json({ success: false, message: '未绑定账号' }, 400);
    }

    // 检查今日领取次数
    const today = new Date().toISOString().split('T')[0] || '';
    const todayStart = new Date(today).getTime();
    const todayEnd = todayStart + 86400000;

    // 查询今日领取记录数（排除绑定奖励）
    const todayClaimsResult = await cacheManager.getOrLoad(
        `claims_count:${user.linux_do_id}:${today}`,
        async () => {
            const allClaims = claimQueries.getByUser.all(user.linux_do_id);
            return allClaims.filter(
                (r) => r.timestamp >= todayStart && r.timestamp < todayEnd && r.quota_added !== 50000000
            ).length;
        },
        3600000 // 缓存1小时
    );

    // 获取最大领取次数配置
    const adminConfig = adminQueries.get.get()!;
    const maxDailyClaims = adminConfig.max_daily_claims || 1;

    if (todayClaimsResult >= maxDailyClaims) {
        return c.json(
            {
                success: false,
                message: `今天已经领取 ${todayClaimsResult} 次，达到每日上限（${maxDailyClaims}次）`,
            },
            400
        );
    }

    // 查询用户当前额度
    const searchResult = await searchAndFindExactUser(
        user.username,
        adminConfig.session,
        adminConfig.new_api_user,
        '每日领取'
    );

    if (!searchResult.success) {
        if (
            searchResult.message?.includes('未登录') ||
            searchResult.message?.includes('无权进行此操作')
        ) {
            return c.json(
                {
                    success: false,
                    message: '系统配置错误，请联系管理员',
                },
                500
            );
        }
        return c.json(
            {
                success: false,
                message: searchResult.message || '查询用户失败',
            },
            500
        );
    }

    const kyxUser = searchResult.user!;

    if (kyxUser.quota >= CONFIG.MIN_QUOTA_THRESHOLD) {
        return c.json(
            { success: false, message: '额度充足，未达到领取要求' },
            400
        );
    }

    // 更新额度
    const newQuota = kyxUser.quota + adminConfig.claim_quota;
    const updateResult = await updateKyxUserQuota(
        user.kyx_user_id,
        newQuota,
        adminConfig.session,
        adminConfig.new_api_user,
        kyxUser.username,
        kyxUser.group || 'default'
    );

    if (!updateResult.success) {
        if (
            updateResult.message?.includes('未登录') ||
            updateResult.message?.includes('无权进行此操作')
        ) {
            return c.json(
                {
                    success: false,
                    message: '系统配置错误，请联系管理员',
                },
                500
            );
        }
        return c.json(
            {
                success: false,
                message: '额度添加失败: ' + (updateResult.message || '未知错误'),
            },
            500
        );
    }

    // 保存领取记录
    const timestamp = Date.now();
    claimQueries.insert.run(
        user.linux_do_id,
        user.username,
        adminConfig.claim_quota,
        timestamp,
        today
    );

    // 清除缓存
    cacheManager.clear(`claim:${user.linux_do_id}`);
    cacheManager.clear(`claims_count:${user.linux_do_id}`);
    cacheManager.clear(`kyx_user:${user.kyx_user_id}`);

    console.log(`[用户操作] 💰 每日领取成功 - 用户: ${user.username}, 额度: $${(adminConfig.claim_quota / 500000).toFixed(2)}, 今日第 ${todayClaimsResult + 1} 次`);

    return c.json({
        success: true,
        message: `成功添加额度 $${(adminConfig.claim_quota / 500000).toFixed(2)}`,
        data: { quota_added: adminConfig.claim_quota },
    });
});

/**
 * 投喂 ModelScope Keys
 */
app.post('/donate/validate', requireAuth, async (c) => {
    const session = c.get('session');

    const user = userQueries.get.get(session.linux_do_id);
    if (!user) {
        return c.json({ success: false, message: '未绑定账号' }, 400);
    }

    let { keys } = await c.req.json();
    if (!Array.isArray(keys) || keys.length === 0) {
        return c.json({ success: false, message: 'Keys 不能为空' }, 400);
    }

    // 调用验证服务
    const result = await validateAndDonateKeys(
        user.linux_do_id,
        user.username,
        keys,
        'modelscope'
    );

    if (result.success) {
        // 清除额度缓存，确保前端能获取到最新额度
        cacheManager.clear(`kyx_user:${user.kyx_user_id}`);

        // 投喂成功后增加一次免费抽奖次数
        addUserFreeSpins(user.linux_do_id, 1);

        console.log(`[用户操作] 🎁 ModelScope 投喂成功 - 用户: ${user.username}, Keys数: ${result.data.valid_keys}, 额度: $${(result.data.quota_added / 500000).toFixed(2)}, 奖励免费抽奖次数: 1`);

        // ✅ 获取更新后的免费次数
        const freeSpins = getUserFreeSpins(user.linux_do_id);
        console.log(`[用户操作] 当前免费次数: ${freeSpins}`);

        return c.json({
            ...result,
            show_thanks: true,
            free_spins: freeSpins, // ✅ 返回免费次数给前端
        }, 200);
    } else {
        console.log(`[用户操作] ❌ ModelScope 投喂失败 - 用户: ${user.username}, 原因: ${result.message}`);
        return c.json(result, 400);
    }
});

/**
 * 投喂 iFlow Keys
 */
app.post('/donate/iflow', requireAuth, async (c) => {
    const session = c.get('session');

    const user = userQueries.get.get(session.linux_do_id);
    if (!user) {
        return c.json({ success: false, message: '未绑定账号' }, 400);
    }

    let { keys } = await c.req.json();
    if (!Array.isArray(keys) || keys.length === 0) {
        return c.json({ success: false, message: 'Keys 不能为空' }, 400);
    }

    // 调用验证服务
    const result = await validateAndDonateKeys(
        user.linux_do_id,
        user.username,
        keys,
        'iflow'
    );

    if (result.success) {
        // 清除额度缓存，确保前端能获取到最新额度
        cacheManager.clear(`kyx_user:${user.kyx_user_id}`);

        // 投喂成功后增加一次免费抽奖次数
        addUserFreeSpins(user.linux_do_id, 1);

        console.log(`[用户操作] ✨ iFlow 投喂成功 - 用户: ${user.username}, Keys数: ${result.data.valid_keys}, 额度: $${(result.data.quota_added / 500000).toFixed(2)}, 奖励免费抽奖次数: 1`);

        // ✅ 获取更新后的免费次数
        const freeSpins = getUserFreeSpins(user.linux_do_id);
        console.log(`[用户操作] 当前免费次数: ${freeSpins}`);

        return c.json({
            ...result,
            show_thanks: true,
            free_spins: freeSpins, // ✅ 返回免费次数给前端
        }, 200);
    } else {
        console.log(`[用户操作] ❌ iFlow 投喂失败 - 用户: ${user.username}, 原因: ${result.message}`);
        return c.json(result, 400);
    }
});

/**
 * 查看用户领取记录
 */
app.get('/user/records/claim', requireAuth, async (c) => {
    const session = c.get('session');

    const records = claimQueries.getByUser.all(session.linux_do_id);

    return c.json({ success: true, data: records });
});

/**
 * 查看用户投喂记录
 */
app.get('/user/records/donate', requireAuth, async (c) => {
    const session = c.get('session');

    const records = donateQueries.getByUser.all(session.linux_do_id);

    // 解析 failed_keys JSON
    const processedRecords = records.map((r) => ({
        ...r,
        failed_keys: r.failed_keys ? JSON.parse(r.failed_keys) : [],
    }));

    return c.json({ success: true, data: processedRecords });
});

/**
 * 用户登出
 */
app.post('/auth/logout', async (c) => {
    const sessionId = getCookie(c.req.raw.headers, 'session_id');
    if (sessionId) {
        const session = await getSession(sessionId);
        if (session?.linux_do_id) {
            const user = userQueries.get.get(session.linux_do_id);
            if (user) {
                console.log(`[用户操作] 🚪 用户登出 - 用户: ${user.username}, Linux Do ID: ${session.linux_do_id}`);
            }
        }
        await deleteSession(sessionId);
    }

    c.header('Set-Cookie', setCookie('session_id', '', 0));
    return c.json({ success: true });
});

export default app;

