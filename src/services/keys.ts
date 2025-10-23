import { CONFIG } from '../config';
import { keyQueries, donateQueries } from '../database';
import { searchAndFindExactUser, updateKyxUserQuota, pushKeysToGroup } from './kyx-api';
import { cacheManager } from '../cache';

/**
 * 验证 ModelScope API Key
 */
export async function validateModelScopeKey(apiKey: string): Promise<boolean> {
    try {
        const response = await fetch(
            `${CONFIG.MODELSCOPE_API_BASE}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'ZhipuAI/GLM-4.6',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 1,
                }),
            }
        );
        return response.ok || response.status === 429; // 429 表示请求过多但 key 有效
    } catch {
        return false;
    }
}

/**
 * 验证 iFlow API Key
 */
export async function validateIFlowKey(apiKey: string): Promise<boolean> {
    try {
        const response = await fetch(
            `${CONFIG.IFLOW_API_BASE}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'TBStars2-200B-A13B',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 1,
                }),
            }
        );
        return response.ok || response.status === 429; // 429 表示请求过多但 key 有效
    } catch {
        return false;
    }
}

/**
 * 检查 Key 是否已被使用
 */
export async function isKeyUsed(key: string, keyType: 'modelscope' | 'iflow' = 'modelscope'): Promise<boolean> {
    const cacheKey = `key_used:${keyType}:${key}`;

    return await cacheManager.getOrLoad(
        cacheKey,
        async () => {
            const result = keyQueries.isUsed.get(key, keyType);
            return (result?.count || 0) > 0;
        },
        600000 // 缓存10分钟
    );
}

/**
 * 标记 Key 为已使用
 */
export async function markKeyUsed(
    key: string,
    linuxDoId: string,
    username: string,
    keyType: 'modelscope' | 'iflow' = 'modelscope'
): Promise<void> {
    const timestamp = Date.now();
    keyQueries.insert.run(key, linuxDoId, username, timestamp, keyType);

    // 更新缓存
    cacheManager.set(`key_used:${keyType}:${key}`, true, 600000);
}

/**
 * 获取今日投喂数量
 */
export async function getTodayDonateCount(linuxDoId: string, keyType?: 'modelscope' | 'iflow'): Promise<number> {
    const today = new Date().toISOString().split('T')[0] || '';
    const todayStart = new Date(today).getTime();
    const todayEnd = todayStart + 86400000; // 24 小时后

    if (keyType) {
        const result = donateQueries.getTodayCountByType.get(linuxDoId, todayStart, todayEnd, keyType);
        return result?.total || 0;
    } else {
        const result = donateQueries.getTodayCount.get(linuxDoId, todayStart, todayEnd);
        return result?.total || 0;
    }
}

/**
 * 验证并投喂 Keys
 */
export async function validateAndDonateKeys(
    linuxDoId: string,
    username: string,
    keys: string[],
    keyType: 'modelscope' | 'iflow' = 'modelscope'
): Promise<any> {
    // 检查今日投喂次数限制（按类型分别计算）
    const todayDonateCount = await getTodayDonateCount(linuxDoId, keyType);
    const remainingQuota = CONFIG.MAX_DAILY_DONATE - todayDonateCount;

    if (remainingQuota <= 0) {
        return {
            success: false,
            message: `今日${keyType === 'modelscope' ? 'ModelScope' : 'iFlow'} Key 投喂已达上限（${CONFIG.MAX_DAILY_DONATE}个），明天再来吧！今日已投喂：${todayDonateCount} 个Key`,
        };
    }

    if (keys.length > remainingQuota) {
        return {
            success: false,
            message: `今日还可投喂 ${remainingQuota} 个 ${keyType === 'modelscope' ? 'ModelScope' : 'iFlow'} Key，您提交了 ${keys.length} 个。请减少提交数量。`,
        };
    }

    // 第一步：去重
    const originalCount = keys.length;
    const uniqueKeys = [...new Set(keys)];
    const duplicateCount = originalCount - uniqueKeys.length;

    // 第二步：检查数据库已存在的 Keys
    const alreadyExistsKeys: string[] = [];
    const keysToValidate: string[] = [];

    for (const key of uniqueKeys) {
        if (await isKeyUsed(key, keyType)) {
            alreadyExistsKeys.push(key);
        } else {
            keysToValidate.push(key);
        }
    }

    // 第三步：并发验证 Keys
    const validKeys: string[] = [];
    const invalidKeys: string[] = [];
    const results: any[] = [];

    // 添加已存在的 Keys 到结果
    alreadyExistsKeys.forEach((key) => {
        results.push({
            key: key.substring(0, 10) + '...',
            valid: false,
            reason: '数据库已存在',
        });
    });

    // 并发验证函数
    async function validateBatch(batch: string[]) {
        const validateFunc = keyType === 'modelscope' ? validateModelScopeKey : validateIFlowKey;
        return await Promise.all(
            batch.map(async (key) => {
                const isValid = await validateFunc(key);
                return { key, valid: isValid };
            })
        );
    }

    // 分批验证（每批30个，提高并发数）
    const batchSize = 30;
    for (let i = 0; i < keysToValidate.length; i += batchSize) {
        const batch = keysToValidate.slice(i, i + batchSize);
        const batchResults = await validateBatch(batch);

        for (const result of batchResults) {
            if (result.valid) {
                validKeys.push(result.key);
                results.push({
                    key: result.key.substring(0, 10) + '...',
                    valid: true,
                });
            } else {
                invalidKeys.push(result.key);
                results.push({
                    key: result.key.substring(0, 10) + '...',
                    valid: false,
                    reason: '无效',
                });
            }
        }
    }

    // 批量保存有效的 Keys
    if (validKeys.length > 0) {
        await Promise.all(
            validKeys.map(async (key) => {
                await markKeyUsed(key, linuxDoId, username, keyType);
            })
        );
    }

    if (validKeys.length === 0) {
        return {
            success: false,
            message: `提交了 ${originalCount} 个Key，去重后 ${uniqueKeys.length} 个，数据库已存在 ${alreadyExistsKeys.length} 个，验证后无有效Key`,
            data: {
                valid_keys: 0,
                already_exists: alreadyExistsKeys.length,
                duplicate_removed: duplicateCount,
                quota_added: 0,
            },
            results,
        };
    }

    // 计算奖励额度
    const totalQuotaAdded = validKeys.length * CONFIG.DONATE_QUOTA_PER_KEY;

    // 获取管理员配置
    const adminConfig = await getAdminConfig();

    // 查询用户信息并更新额度
    const searchResult = await searchAndFindExactUser(
        username,
        adminConfig.session,
        adminConfig.new_api_user,
        '投喂Keys'
    );

    if (searchResult.success && searchResult.user) {
        const kyxUser = searchResult.user;
        const newQuota = kyxUser.quota + totalQuotaAdded;
        await updateKyxUserQuota(
            kyxUser.id,
            newQuota,
            adminConfig.session,
            adminConfig.new_api_user,
            kyxUser.username,
            kyxUser.group || 'default'
        );
    }

    // 推送 keys 到分组（根据 key_type 使用不同的 group_id）
    let pushStatus: 'success' | 'failed' = 'success';
    let pushMessage = '推送成功';
    let failedKeys: string[] = [];

    if (validKeys.length > 0 && adminConfig.keys_authorization) {
        // 根据 keyType 选择对应的 group_id
        const targetGroupId = keyType === 'iflow'
            ? (adminConfig.iflow_group_id || adminConfig.modelscope_group_id)
            : adminConfig.modelscope_group_id;

        const pushResult = await pushKeysToGroup(
            validKeys,
            adminConfig.keys_api_url,
            adminConfig.keys_authorization,
            targetGroupId
        );

        if (!pushResult.success) {
            pushStatus = 'failed';
            pushMessage = pushResult.message || '推送失败';
            failedKeys = pushResult.failedKeys || validKeys;
        }
    } else if (!adminConfig.keys_authorization) {
        pushStatus = 'failed';
        pushMessage = '未配置推送授权';
        failedKeys = validKeys;
    }

    // 保存投喂记录
    const timestamp = Date.now();
    donateQueries.insert.run(
        linuxDoId,
        username,
        validKeys.length,
        totalQuotaAdded,
        timestamp,
        pushStatus,
        pushMessage,
        failedKeys.length > 0 ? JSON.stringify(failedKeys) : null,
        keyType
    );

    // 构建详细消息
    let message = '';
    if (duplicateCount > 0) {
        message += `已自动去重 ${duplicateCount} 个重复Key。`;
    }
    if (alreadyExistsKeys.length > 0) {
        message += `数据库已存在 ${alreadyExistsKeys.length} 个Key。`;
    }
    if (validKeys.length > 0) {
        message += `成功投喂 ${validKeys.length} 个新Key，奖励额度 $${(totalQuotaAdded / 500000).toLocaleString('en-US')}`;
    }

    return {
        success: validKeys.length > 0,
        message: message || '没有新的有效 Key',
        data: {
            valid_keys: validKeys.length,
            already_exists: alreadyExistsKeys.length,
            duplicate_removed: duplicateCount,
            quota_added: totalQuotaAdded,
        },
        results,
    };
}

// 辅助函数：获取管理员配置
async function getAdminConfig() {
    return await cacheManager.getOrLoad(
        'admin_config',
        async () => {
            const config = await import('../database').then((m) =>
                m.adminQueries.get.get()
            );

            const defaults = {
                session: '',
                new_api_user: '1',
                claim_quota: CONFIG.DEFAULT_CLAIM_QUOTA,
                keys_api_url: 'https://gpt-load.kyx03.de/api/keys/add-async',
                keys_authorization: '',
                modelscope_group_id: 26,
                iflow_group_id: 26,
                max_daily_claims: 1,
                updated_at: Date.now(),
            };

            if (!config) {
                return defaults;
            }

            return {
                session: config.session || defaults.session,
                new_api_user: config.new_api_user || defaults.new_api_user,
                claim_quota: config.claim_quota || defaults.claim_quota,
                keys_api_url: config.keys_api_url || defaults.keys_api_url,
                keys_authorization:
                    config.keys_authorization || defaults.keys_authorization,
                modelscope_group_id:
                    config.modelscope_group_id !== undefined ? config.modelscope_group_id : defaults.modelscope_group_id,
                iflow_group_id:
                    config.iflow_group_id !== undefined ? config.iflow_group_id : defaults.iflow_group_id,
                max_daily_claims: config.max_daily_claims || defaults.max_daily_claims,
                updated_at: config.updated_at || defaults.updated_at,
            };
        },
        300000 // 缓存5分钟
    );
}

