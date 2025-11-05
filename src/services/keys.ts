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
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'qwen3-32b',
                    messages: [{ role: 'user', content: 'Hi' }],
                    temperature: 0.7,
                    max_tokens: 100,
                }),
            }
        );

        // 检查响应状态
        if (!response.ok) {
            // 429 表示请求过多但 key 有效
            if (response.status === 429) {
                return true;
            }
            return false;
        }

        // 解析响应内容
        const result = await response.json();

        // 验证返回内容不为空
        if (result.choices &&
            result.choices.length > 0 &&
            result.choices[0].message &&
            result.choices[0].message.content &&
            result.choices[0].message.content.trim().length > 0) {
            return true;  // 返回内容不为空，验证成功
        }

        return false;
    } catch (error) {
        logger.error('iFlow验证', `验证异常: ${error}`);
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
    // 获取管理员配置（提前获取以使用投喂限制配置）
    const adminConfig = await getAdminConfig();

    // 获取对应渠道的每日投喂限制
    const maxDailyDonate = keyType === 'modelscope'
        ? (adminConfig.max_daily_donate_modelscope || 1)
        : (adminConfig.max_daily_donate_iflow || 1);

    // 检查今日投喂次数限制（按类型分别计算）
    const todayDonateCount = await getTodayDonateCount(linuxDoId, keyType);
    const remainingQuota = maxDailyDonate - todayDonateCount;

    const keyTypeName = keyType === 'modelscope' ? 'ModelScope' : 'iFlow';

    if (remainingQuota <= 0) {
        return {
            success: false,
            message: `今日 ${keyTypeName} Key 投喂已达上限（${maxDailyDonate} 个/天），明天再来吧！😊`,
        };
    }

    if (keys.length > remainingQuota) {
        return {
            success: false,
            message: `今日还可投喂 ${remainingQuota} 个 ${keyTypeName} Key，您提交了 ${keys.length} 个`,
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
        // 构建友好的错误提示
        let friendlyMessage = '';

        if (alreadyExistsKeys.length > 0 && invalidKeys.length === 0) {
            // 全部是已存在的 Key
            friendlyMessage = alreadyExistsKeys.length === 1
                ? '该 Key 已被使用过，请提交其他 Key'
                : `提交的 ${alreadyExistsKeys.length} 个 Key 都已被使用过`;
        } else if (alreadyExistsKeys.length === 0 && invalidKeys.length > 0) {
            // 全部是无效的 Key
            friendlyMessage = invalidKeys.length === 1
                ? 'Key 无效或已失效，请检查后重试'
                : `提交的 ${invalidKeys.length} 个 Key 都无效或已失效`;
        } else {
            // 混合情况
            friendlyMessage = `${alreadyExistsKeys.length} 个已被使用，${invalidKeys.length} 个无效，没有可用的 Key`;
        }

        return {
            success: false,
            message: friendlyMessage,
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

    // 查询用户信息并更新额度（adminConfig 已在函数开头获取）
    const searchResult = await searchAndFindExactUser(
        username,
        adminConfig.session,
        adminConfig.new_api_user,
        '投喂Keys'
    );

    if (searchResult.success && searchResult.user) {
        const kyxUser = searchResult.user;
        const newQuota = kyxUser.quota + totalQuotaAdded;

        logger.debug('投喂Keys', `准备添加额度 - 用户: ${kyxUser.username}, 当前: ${kyxUser.quota}, 奖励: ${totalQuotaAdded}, 目标: ${newQuota}`);

        const updateResult = await updateKyxUserQuota(
            kyxUser.id,
            newQuota,
            adminConfig.session,
            adminConfig.new_api_user,
            kyxUser.username,
            kyxUser.group || 'default'
        );

        // 【关键】检查额度更新结果
        if (!updateResult || !updateResult.success) {
            logger.error('投喂Keys', `❌ 添加额度失败 - 用户: ${kyxUser.username}, 奖励: $${(totalQuotaAdded / 500000).toFixed(2)}, 错误: ${updateResult?.message || '未知错误'}`);
            // 注意：即使额度添加失败，仍然继续推送keys和保存记录
            // 这样管理员可以从记录中看到失败情况并补发
        } else {
            logger.info('投喂Keys', `✅ 添加额度成功 - 用户: ${kyxUser.username}, 奖励: $${(totalQuotaAdded / 500000).toFixed(2)}`);
        }
    } else {
        logger.error('投喂Keys', `⚠️ 未找到用户或搜索失败，无法添加额度 - LinuxDo ID: ${linuxDoId}`);
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

    // 构建友好的成功消息
    const quotaUSD = (totalQuotaAdded / 500000).toFixed(2);
    let message = `🎉 投喂成功！奖励额度 $${quotaUSD}`;

    // 添加额外信息（如果有）
    const extraInfo: string[] = [];
    if (duplicateCount > 0) {
        extraInfo.push(`去重 ${duplicateCount} 个`);
    }
    if (alreadyExistsKeys.length > 0) {
        extraInfo.push(`${alreadyExistsKeys.length} 个已存在`);
    }

    if (extraInfo.length > 0) {
        message += `（${extraInfo.join('，')}）`;
    }

    return {
        success: true,
        message: message,
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

