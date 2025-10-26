// 用户相关
export interface User {
    linux_do_id: string;
    username: string;
    linux_do_username?: string;  // LinuxDo用户名
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
    max_daily_donate_modelscope: number;  // ModelScope 每日最大投喂次数
    max_daily_donate_iflow: number;       // iFlow 每日最大投喂次数
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

// 老虎机配置
export interface SlotMachineConfig {
    id: number;
    bet_amount: number;
    max_daily_spins: number;
    min_quota_required: number;
    enabled: number;
    background_type: string;  // 'default' 或 'gif'
    updated_at: number;
}

// 老虎机游戏记录
export interface SlotMachineRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    linux_do_username?: string;  // LinuxDo用户名
    bet_amount: number;
    result_symbols: string;  // JSON 数组
    win_type: string;
    win_multiplier: number;
    win_amount: number;
    free_spin_awarded: number;
    is_free_spin: number;
    timestamp: number;
    date: string;
}

// 用户免费次数
export interface UserFreeSpin {
    linux_do_id: string;
    free_spins: number;
    banned_until: number;  // 禁止抽奖截止时间戳
    updated_at: number;
}

