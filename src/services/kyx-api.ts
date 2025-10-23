import { CONFIG } from '../config';

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
 * 搜索公益站用户
 */
export async function searchKyxUser(
    username: string,
    session: string,
    newApiUser: string = '1',
    page: number = 1,
    pageSize: number = 100
): Promise<any> {
    const url = `${CONFIG.KYX_API_BASE}/api/user/search?keyword=${encodeURIComponent(username)}&p=${page}&page_size=${pageSize}`;

    const response = await fetch(url, {
        headers: {
            Cookie: `session=${session}`,
            'new-api-user': newApiUser,
        },
    });

    return await response.json();
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
        console.log(`[${context}] ⚠️ 用户名大小写不一致 - 输入: "${username}", 实际: "${user.username}"`);
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
    console.log(`[${context}] 🔍 搜索用户: ${username}`);

    // 第一次搜索，使用默认分页
    let searchResult = await searchKyxUser(username, session, newApiUser, 1, 100);

    if (!searchResult.success) {
        console.log(`[${context}] ❌ 搜索失败: ${searchResult.message}`);
        return { success: false, message: searchResult.message, user: null };
    }

    // 尝试在第一页中查找精确匹配
    let user = findExactUser(searchResult, username, context);

    if (user) {
        console.log(`[${context}] ✅ 找到用户 - ID: ${user.id}, Linux Do ID: ${user.linux_do_id}`);
        return { success: true, user };
    }

    // 如果第一页没找到，检查是否有更多数据
    const total = searchResult.data?.total || 0;
    const pageSize = 100;
    const totalPages = Math.ceil(total / pageSize);

    // 如果只有一页或没有更多数据，直接返回未找到
    if (totalPages <= 1) {
        console.log(`[${context}] ❌ 未找到用户: ${username}`);
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
            console.log(`[${context}] ✅ 找到用户（第${page}页） - ID: ${user.id}, Linux Do ID: ${user.linux_do_id}`);
            return { success: true, user };
        }
    }

    const totalSearched = pageSize * maxPagesToSearch;
    console.log(`[${context}] ❌ 未找到用户: ${username}（已搜索${maxPagesToSearch}页）`);

    return {
        success: false,
        message: `未找到该用户。已搜索前 ${maxPagesToSearch} 页（${totalSearched} 条记录），请确认用户名输入正确。`,
        user: null,
    };
}

/**
 * 通过 ID 直接查询用户信息
 */
export async function getKyxUserById(
    userId: number,
    session: string,
    newApiUser: string = '1'
): Promise<SearchResult> {
    try {
        const response = await fetch(`${CONFIG.KYX_API_BASE}/api/user/${userId}`, {
            headers: {
                Cookie: `session=${session}`,
                'new-api-user': newApiUser,
            },
        });

        const result = await response.json();

        if (!result.success || !result.data) {
            return { success: false, message: result.message || '查询失败', user: null };
        }

        return { success: true, user: result.data };
    } catch (error: any) {
        return { success: false, message: '查询请求失败: ' + (error.message || '未知错误'), user: null };
    }
}

/**
 * 更新用户额度
 */
export async function updateKyxUserQuota(
    userId: number,
    newQuota: number,
    session: string,
    newApiUser: string = '1',
    username: string = '',
    group: string = 'default'
): Promise<any> {
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
    });

    return await response.json();
}

/**
 * 推送 Keys 到分组
 */
export async function pushKeysToGroup(
    keys: string[],
    apiUrl: string,
    authorization: string,
    groupId: number
): Promise<{ success: boolean; message?: string; failedKeys?: string[] }> {
    try {
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
        });

        const result = await response.json();

        if (!response.ok) {
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
        return {
            success: false,
            message: '推送请求失败: ' + (error.message || '未知错误'),
            failedKeys: keys,
        };
    }
}

