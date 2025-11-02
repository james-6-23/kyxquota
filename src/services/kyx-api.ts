import { CONFIG } from '../config';
import { kyxApiLimiter } from './rate-limiter';
import { userCache } from './user-cache';
import { searchCache } from './search-cache';
import { userQueries } from '../database';
import logger from '../utils/logger';

/**
 * 获取用户显示名称（优先使用 linux_do_username，否则使用 linux_do_id）
 */
function getUserDisplayName(linuxDoId: string): string {
    const user = userQueries.get.get(linuxDoId);
    if (user?.linux_do_username) {
        return user.linux_do_username;
    }
    return linuxDoId;
}

export interface KyxUser {
    id: number;
    username: string;
    display_name: string;
    linux_do_id: string;
    quota: number;
    used_quota: number;
    group: string;
}

export interface SearchResult {
    success: boolean;
    message?: string;
    user: KyxUser | null;
}

/**
 * 搜索公益站用户（带缓存、限流和错误处理）
 */
export async function searchKyxUser(
    username: string,
    session: string,
    newApiUser: string = '1',
    page: number = 1,
    pageSize: number = 100,
    maxRetries: number = 3
): Promise<any> {
    const context = `[搜索用户] 关键词: ${username}, 页码: ${page}`;

    // 先尝试从缓存获取
    const cachedResult = searchCache.get(username, page);
    if (cachedResult) {
        logger.debug(context, '✨ 命中搜索缓存');
        return cachedResult;
    }

    return await kyxApiLimiter.execute(async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    logger.debug(context, `第${attempt}次尝试`);
                }

                const url = `${CONFIG.KYX_API_BASE}/api/user/search?keyword=${encodeURIComponent(username)}&p=${page}&page_size=${pageSize}`;

                const response = await fetch(url, {
                    headers: {
                        Cookie: `session=${session}`,
                        'new-api-user': newApiUser,
                    },
                    signal: AbortSignal.timeout(10000),
                });

                // 处理 429 错误（快速重试策略）
                if (response.status === 429) {
                    kyxApiLimiter.recordRateLimit();
                    const waitTime = Math.min(1000 * attempt, 4000); // 1s, 2s, 3s, 4s
                    logger.warn(context, `⚠️ 触发限流 (429)，等待 ${waitTime}ms 后重试`);

                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: '搜索失败: 服务繁忙，请稍后再试'
                    };
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(context, `HTTP错误: ${response.status}, 响应: ${errorText}`);

                    if (attempt < maxRetries) {
                        const backoffTime = 1000 * Math.pow(2, attempt - 1);
                        await new Promise(resolve => setTimeout(resolve, backoffTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: `搜索失败: HTTP ${response.status}`
                    };
                }

                const result = await response.json();

                // 成功后存入缓存
                searchCache.set(username, page, result);
                logger.debug(context, '✅ 搜索成功并缓存');

                return result;
            } catch (error: any) {
                const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
                const errorMsg = isTimeout ? '请求超时' : error.message || '未知错误';

                logger.error(context, `❌ 第${attempt}次尝试失败: ${errorMsg}`);

                if (attempt === maxRetries) {
                    return {
                        success: false,
                        message: '搜索请求失败: ' + errorMsg
                    };
                }

                const backoffTime = 1000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
        }

        return {
            success: false,
            message: '搜索失败: 已达到最大重试次数'
        };
    });
}

/**
 * 从搜索结果中查找精确匹配的用户
 */
export function findExactUser(
    searchResult: any,
    username: string,
    context: string = '操作'
): KyxUser | null {
    if (!searchResult.success || !searchResult.data?.items?.length) {
        return null;
    }

    // 优先精确匹配（区分大小写）
    let user = searchResult.data.items.find(
        (user: any) => user.username === username
    );

    if (user) {
        return user;
    }

    // 如果精确匹配失败，尝试不区分大小写匹配
    user = searchResult.data.items.find(
        (user: any) => user.username.toLowerCase() === username.toLowerCase()
    );

    if (user) {
        logger.warn(context, `⚠️ 用户名大小写不一致 - 输入: "${username}", 实际: "${user.username}"`);
        return user;
    }

    return null;
}

/**
 * 搜索并查找精确匹配的用户（支持多页搜索）
 */
export async function searchAndFindExactUser(
    username: string,
    session: string,
    newApiUser: string = '1',
    context: string = '操作'
): Promise<SearchResult> {
    logger.info(context, `🔍 搜索用户: ${username}`);

    // 第一次搜索，使用默认分页
    let searchResult = await searchKyxUser(username, session, newApiUser, 1, 100);

    if (!searchResult.success) {
        logger.error(context, `❌ 搜索失败: ${searchResult.message}`);
        return { success: false, message: searchResult.message, user: null };
    }

    // 尝试在第一页中查找精确匹配
    let user = findExactUser(searchResult, username, context);

    if (user) {
        logger.info(context, `✅ 找到用户 - ID: ${user.id}, Linux Do ID: ${user.linux_do_id}`);
        return { success: true, user };
    }

    // 如果第一页没找到，检查是否有更多数据
    const total = searchResult.data?.total || 0;
    const pageSize = 100;
    const totalPages = Math.ceil(total / pageSize);

    // 如果只有一页或没有更多数据，直接返回未找到
    if (totalPages <= 1) {
        logger.info(context, `❌ 未找到用户: ${username}`);
        return { success: false, message: '未找到该用户', user: null };
    }

    // 继续搜索后续页（最多搜索前4页，避免过多请求）
    const maxPagesToSearch = Math.min(totalPages, 4);

    for (let page = 2; page <= maxPagesToSearch; page++) {
        searchResult = await searchKyxUser(
            username,
            session,
            newApiUser,
            page,
            pageSize
        );

        if (!searchResult.success) {
            continue;
        }

        user = findExactUser(searchResult, username, context);
        if (user) {
            logger.info(context, `✅ 找到用户（第${page}页） - ID: ${user.id}, Linux Do ID: ${user.linux_do_id}`);
            return { success: true, user };
        }
    }

    const totalSearched = pageSize * maxPagesToSearch;
    logger.info(context, `❌ 未找到用户: ${username}（已搜索${maxPagesToSearch}页）`);

    return {
        success: false,
        message: `未找到该用户。已搜索前 ${maxPagesToSearch} 页（${totalSearched} 条记录），请确认用户名输入正确。`,
        user: null,
    };
}

/**
 * 通过 ID 直接查询用户信息（带缓存、限流和重试）
 */
export async function getKyxUserById(
    userId: number,
    session: string,
    newApiUser: string = '1',
    maxRetries: number = 3,
    skipCache: boolean = false // 是否跳过缓存（需要最新数据时使用）
): Promise<SearchResult> {
    const context = `[查询用户] 用户ID: ${userId}`;

    // 先尝试从缓存获取（除非明确跳过）
    if (!skipCache) {
        const cachedUser = userCache.get(userId);
        if (cachedUser) {
            logger.debug('查询用户', `用户ID: ${userId} - ✨ 命中缓存`);
            return { success: true, user: cachedUser };
        }
    }

    return await kyxApiLimiter.execute(async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // 第1次尝试是正常情况，改为DEBUG；第2+次说明有重试，保留INFO
                if (attempt === 1) {
                    logger.debug('查询用户', `用户ID: ${userId} - 第1次尝试`);
                } else {
                    logger.info('查询用户', `用户ID: ${userId} - 第${attempt}次尝试（重试中）`);
                }

                const response = await fetch(`${CONFIG.KYX_API_BASE}/api/user/${userId}`, {
                    headers: {
                        Cookie: `session=${session}`,
                        'new-api-user': newApiUser,
                    },
                    signal: AbortSignal.timeout(10000), // 10秒超时
                });

                // 处理 429 错误（快速重试策略）
                if (response.status === 429) {
                    kyxApiLimiter.recordRateLimit();
                    const waitTime = Math.min(1000 * attempt, 3000); // 1s, 2s, 3s（快速重试）
                    logger.warn('查询用户', `用户ID: ${userId} - ⚠️ 触发限流 (429)，等待 ${waitTime}ms 后重试`);

                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: '查询失败: 服务繁忙，请稍后再试',
                        user: null
                    };
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error('查询用户', `用户ID: ${userId} - HTTP错误: ${response.status}, 响应: ${errorText}`);

                    if (attempt < maxRetries) {
                        const backoffTime = 1000 * Math.pow(2, attempt - 1);
                        await new Promise(resolve => setTimeout(resolve, backoffTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: `查询失败: HTTP ${response.status}`,
                        user: null
                    };
                }

                const result = await response.json();

                if (!result.success || !result.data) {
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    return { success: false, message: result.message || '查询失败', user: null };
                }

                // 成功后存入缓存
                userCache.set(userId, result.data);
                logger.info('查询用户', `用户ID: ${userId} - ✅ 查询成功并缓存`);

                return { success: true, user: result.data };
            } catch (error: any) {
                const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
                const errorMsg = isTimeout ? '请求超时' : error.message || '未知错误';

                logger.error('查询用户', `用户ID: ${userId} - ❌ 第${attempt}次尝试失败: ${errorMsg}`);

                if (attempt === maxRetries) {
                    return {
                        success: false,
                        message: '查询请求失败: ' + errorMsg,
                        user: null
                    };
                }

                const backoffTime = 1000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
        }

        return { success: false, message: '查询失败: 已达到最大重试次数', user: null };
    });
}

/**
 * 更新用户额度（带限流、重试和详细日志）
 */
export async function updateKyxUserQuota(
    userId: number,
    newQuota: number,
    session: string,
    newApiUser: string = '1',
    username: string = '',
    group: string = 'default',
    maxRetries: number = 3
): Promise<any> {
    const context = `[更新额度] 用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username}`;

    // 使用限流器执行请求
    return await kyxApiLimiter.execute(async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // 第1次尝试是正常情况，改为DEBUG；第2+次说明有重试，保留INFO
                if (attempt === 1) {
                    logger.debug('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - 第1次尝试`);
                } else {
                    logger.info('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - 第${attempt}次尝试（重试中）`);
                }

                const response = await fetch(`${CONFIG.KYX_API_BASE}/api/user/`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `session=${session}`,
                        'new-api-user': newApiUser,
                    },
                    body: JSON.stringify({
                        id: userId,
                        quota: newQuota,
                        username: username,
                        group: group,
                    }),
                    signal: AbortSignal.timeout(10000), // 10秒超时
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - HTTP错误: ${response.status} ${response.statusText}, 响应: ${errorText}`);

                    // 特殊处理 429 错误
                    if (response.status === 429) {
                        kyxApiLimiter.recordRateLimit();
                        const waitTime = Math.min(2000 * attempt, 6000); // 2s, 4s, 6s（快速重试）
                        logger.warn('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - ⚠️ 触发限流，等待 ${waitTime}ms 后重试`);

                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        }
                    }

                    // 如果是最后一次尝试，返回失败
                    if (attempt === maxRetries) {
                        return {
                            success: false,
                            message: `更新额度失败: HTTP ${response.status}`,
                            httpStatus: response.status
                        };
                    }

                    // 其他错误：指数退避
                    const backoffTime = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s...
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                    continue;
                }

                const result = await response.json();

                // 验证返回结果
                if (result.success) {
                    // 更新成功后，同步更新缓存
                    userCache.updateQuota(userId, newQuota);
                    // 第1次尝试成功是正常情况，改为DEBUG；重试后成功保留INFO
                    if (attempt === 1) {
                        logger.debug('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - ✅ 成功更新额度并同步缓存`);
                    } else {
                        logger.info('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - ✅ 第${attempt}次重试成功，已更新额度并同步缓存`);
                    }
                    return result;
                } else {
                    logger.error('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - 返回success=false: ${result.message || '无错误信息'}`);

                    if (attempt === maxRetries) {
                        return result;
                    }

                    // 等待后重试
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
            } catch (error: any) {
                const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
                const errorMsg = isTimeout ? '请求超时' : error.message || '未知错误';

                logger.error('更新额度', `用户ID: ${userId}, 目标额度: ${newQuota}, 用户名: ${username} - ❌ 第${attempt}次尝试失败: ${errorMsg}`);

                if (attempt === maxRetries) {
                    return {
                        success: false,
                        message: `更新额度失败: ${errorMsg}`,
                        error: errorMsg
                    };
                }

                // 等待后重试（指数退避）
                const backoffTime = 1000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
        }

        // 理论上不会到这里
        return {
            success: false,
            message: '更新额度失败: 已达到最大重试次数'
        };
    });
}

/**
 * 推送 Keys 到分组（带限流和重试）
 */
export async function pushKeysToGroup(
    keys: string[],
    apiUrl: string,
    authorization: string,
    groupId: number,
    maxRetries: number = 3
): Promise<{ success: boolean; message?: string; failedKeys?: string[] }> {
    const context = `[推送Keys] 数量: ${keys.length}, 分组: ${groupId}`;

    return await kyxApiLimiter.execute(async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    logger.debug(context, `第${attempt}次尝试`);
                }

                const keysText = keys.join('\n');
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${authorization}`,
                    },
                    body: JSON.stringify({
                        group_id: groupId,
                        keys_text: keysText,
                    }),
                    signal: AbortSignal.timeout(15000), // 15秒超时（推送可能较慢）
                });

                // 处理 429 错误（快速重试，因为已有缓存+高RPM）
                if (response.status === 429) {
                    kyxApiLimiter.recordRateLimit();
                    const waitTime = Math.min(2000 * attempt, 6000); // 2s, 4s, 6s（最多6s）
                    logger.warn(context, `⚠️ 触发限流 (429)，等待 ${waitTime}ms 后重试`);

                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: '推送失败: 服务繁忙，请稍后再试',
                        failedKeys: keys,
                    };
                }

                const result = await response.json();

                if (!response.ok) {
                    logger.error(context, `HTTP错误: ${response.status}, 消息: ${result.message || '无'}`);

                    if (attempt < maxRetries) {
                        const backoffTime = 1000 * Math.pow(2, attempt - 1);
                        await new Promise(resolve => setTimeout(resolve, backoffTime));
                        continue;
                    }

                    return {
                        success: false,
                        message: result.message || '推送失败',
                        failedKeys: keys,
                    };
                }

                return {
                    success: true,
                    message: '推送成功',
                };
            } catch (error: any) {
                const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
                const errorMsg = isTimeout ? '请求超时' : error.message || '未知错误';

                logger.error(context, `❌ 第${attempt}次尝试失败: ${errorMsg}`);

                if (attempt === maxRetries) {
                    return {
                        success: false,
                        message: '推送请求失败: ' + errorMsg,
                        failedKeys: keys,
                    };
                }

                const backoffTime = 1000 * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
        }

        return {
            success: false,
            message: '推送失败: 已达到最大重试次数',
            failedKeys: keys,
        };
    });
}

/**
 * 获取用户额度
 */
export function getUserQuota(linuxDoId: string): number {
    try {
        // 从本地数据库获取用户信息
        const user = userQueries.get.get(linuxDoId);
        if (!user) {
            logger.warn('getUserQuota', `用户不存在: ${getUserDisplayName(linuxDoId)}`);
            return 0;
        }
        
        // 从缓存中获取用户信息（同步）
        const cachedUser = userCache.get(user.kyx_user_id);
        if (cachedUser) {
            return cachedUser.quota || 0;
        }

        // 如果缓存中没有，返回0（实际场景中应该先确保用户数据已加载）
        logger.warn('getUserQuota', `用户 ${getUserDisplayName(linuxDoId)} 的额度信息未缓存`);
        return 0;
    } catch (error: any) {
        logger.error('getUserQuota', `获取用户额度失败: ${error}`);
        return 0;
    }
}

/**
 * 增加用户额度（辅助函数）
 */
export async function addQuota(
    userId: number,
    amount: number,
    session: string,
    newApiUser: string = '1',
    context: string = '增加额度'
): Promise<any> {
    try {
        // 先获取用户当前信息
        const userResult = await getKyxUserById(userId, session, newApiUser);
        if (!userResult.success || !userResult.user) {
            return {
                success: false,
                message: '获取用户信息失败'
            };
        }

        const currentQuota = userResult.user.quota || 0;
        const newQuota = currentQuota + amount;

        logger.info(context, `用户ID: ${userId}, 当前额度: ${currentQuota}, 增加: ${amount}, 新额度: ${newQuota}`);

        // 更新额度
        return await updateKyxUserQuota(
            userId,
            newQuota,
            session,
            newApiUser,
            userResult.user.username,
            userResult.user.group || 'default'
        );
    } catch (error: any) {
        logger.error(context, `增加额度失败: ${error}`);
        return {
            success: false,
            message: `增加额度失败: ${error.message}`
        };
    }
}

/**
 * 扣除用户额度（辅助函数）
 */
export async function deductQuota(
    userId: number,
    amount: number,
    session: string,
    newApiUser: string = '1',
    context: string = '扣除额度'
): Promise<any> {
    try {
        // 先获取用户当前信息
        const userResult = await getKyxUserById(userId, session, newApiUser);
        if (!userResult.success || !userResult.user) {
            return {
                success: false,
                message: '获取用户信息失败'
            };
        }

        const currentQuota = userResult.user.quota || 0;

        // 检查额度是否足够
        if (currentQuota < amount) {
            return {
                success: false,
                message: `额度不足: 当前额度 ${currentQuota}, 需要 ${amount}`
            };
        }

        const newQuota = currentQuota - amount;

        logger.info(context, `用户ID: ${userId}, 当前额度: ${currentQuota}, 扣除: ${amount}, 新额度: ${newQuota}`);

        // 更新额度
        return await updateKyxUserQuota(
            userId,
            newQuota,
            session,
            newApiUser,
            userResult.user.username,
            userResult.user.group || 'default'
        );
    } catch (error: any) {
        logger.error(context, `扣除额度失败: ${error}`);
        return {
            success: false,
            message: `扣除额度失败: ${error.message}`
        };
    }
}

