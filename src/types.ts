// 用户相关
export interface User {
    linux_do_id: string;
    username: string;
    kyx_user_id: number;
    is_banned: number;  // 0: 正常, 1: 已封禁
    banned_at?: number;
    banned_reason?: string;
    created_at: number;
}

// 领取记录
export interface ClaimRecord {
    linux_do_id: string;
    username: string;
    quota_added: number;
    timestamp: number;
    date: string; // YYYY-MM-DD
}

// 投喂记录
export interface DonateRecord {
    linux_do_id: string;
    username: string;
    keys_count: number;
    total_quota_added: number;
    timestamp: number;
    push_status?: 'success' | 'failed';
    push_message?: string;
    failed_keys?: string;
    key_type?: 'modelscope' | 'iflow';
}

// 管理员配置
export interface AdminConfig {
    session: string;
    new_api_user: string;
    claim_quota: number;
    max_daily_claims: number;  // 每日最大领取次数
    keys_api_url: string;
    keys_authorization: string;
    modelscope_group_id: number;  // ModelScope 分组 ID
    iflow_group_id: number;       // iFlow 分组 ID
    updated_at: number;
}

// Session 数据
export interface SessionData {
    linux_do_id?: string;
    username?: string;
    avatar_url?: string;
    name?: string;
    admin?: boolean;
}

// 缓存统计
export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    hitRate: string;
    memoryUsage: number;
}

