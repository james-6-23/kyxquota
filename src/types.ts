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
    buy_spins_enabled: number;  // 是否启用购买次数功能
    buy_spins_price: number;    // 购买一次的价格
    max_daily_buy_spins: number; // 每日最大购买次数
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

// 购买抽奖次数记录
export interface BuySpinsRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    linux_do_username?: string;
    spins_count: number;
    price_paid: number;
    timestamp: number;
    date: string;
}

// ========== 高级场系统类型 ==========

// 用户入场券和碎片
export interface UserTickets {
    linux_do_id: string;
    tickets: number;              // 完整入场券数量
    fragments: number;             // 碎片数量
    tickets_expires_at: number | null;  // 入场券过期时间戳
    advanced_mode_until: number | null; // 高级场资格截止时间戳
    updated_at: number;
}

// 高级场配置
export interface AdvancedSlotConfig {
    id: number;
    enabled: number;               // 是否启用
    bet_min: number;               // 最小投注额
    bet_max: number;               // 最大投注额
    reward_multiplier: number;     // 奖励倍数放大系数
    penalty_weight_factor: number; // 惩罚权重放大系数
    rtp_target: number;            // 目标RTP
    ticket_valid_hours: number;    // 入场券有效期（小时）
    session_valid_hours: number;   // 高级场停留时长（小时）
    fragments_needed: number;       // 合成所需碎片数
    drop_rate_triple: number;       // 三连掉落概率
    drop_rate_double: number;       // 二连掉落概率
    max_tickets_hold: number;       // 最多持有入场券数
    daily_bet_limit: number;        // 每日投注上限
    daily_entry_limit: number;      // 每日进入次数限制
    daily_ticket_grant_limit: number; // 每日入场券获得数量限制
    weight_config_id?: number;      // 权重配置方案ID
    reward_scheme_id?: number;      // 奖励配置方案ID
    updated_at: number;
}

// 入场券掉落记录
export interface TicketDropRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    drop_type: 'ticket' | 'fragment';  // 掉落类型
    drop_count: number;                 // 掉落数量
    trigger_win_type: string;           // 触发的中奖类型
    timestamp: number;
    date: string;
}

// 用户每日进入高级场记录
export interface UserAdvancedEntry {
    id?: number;
    linux_do_id: string;
    entry_date: string;          // YYYY-MM-DD 格式
    entry_count: number;         // 今日进入次数
    last_entry_time: number;     // 最后进入时间戳
}

// 用户每日入场券获得记录
export interface UserDailyTicketGrant {
    id?: number;
    linux_do_id: string;
    grant_date: string;          // YYYY-MM-DD 格式
    ticket_granted: number;      // 今日获得的入场券数量
    fragment_granted: number;    // 今日获得的碎片数量
    last_grant_time: number;     // 最后获得时间戳
}

// 高级场RTP统计
export interface AdvancedSlotRTPStats {
    id?: number;
    linux_do_id: string;
    total_bet: number;      // 总投注
    total_win: number;      // 总获奖
    rtp: number;            // RTP比率
    games_count: number;    // 游戏次数
    last_updated: number;
}

// ========== 坤呗借款系统类型 ==========

// 坤呗配置
export interface KunbeiConfig {
    id: number;
    enabled: number;                      // 是否启用
    max_loan_amount: number;              // 最大借款额度
    min_loan_amount: number;              // 最小借款额度
    repay_multiplier: number;             // 还款倍数
    loan_duration_hours: number;          // 借款期限（小时）
    early_repay_discount: number;         // 提前还款优惠比例
    overdue_penalty_hours: number;        // 逾期惩罚时长（小时）
    overdue_ban_advanced: number;         // 逾期是否禁止高级场
    max_active_loans: number;             // 最多同时借款数
    deduct_all_quota_on_overdue?: number; // 逾期是否扣除所有额度（已废弃，使用overdue_deduct_multiplier）
    overdue_deduct_multiplier?: number;   // 逾期扣款倍数（默认2.5倍）
    max_daily_borrows?: number;           // 每日借款次数限制（默认3次）
    updated_at: number;
}

// 用户借款记录
export interface UserLoan {
    id?: number;
    linux_do_id: string;
    username: string;
    loan_amount: number;                  // 借款金额
    repay_amount: number;                 // 应还金额
    actual_repay_amount?: number;         // 实际还款金额
    status: 'active' | 'repaid' | 'overdue';
    borrowed_at: number;                  // 借款时间
    due_at: number;                       // 应还时间
    repaid_at?: number;                   // 实际还款时间
    overdue_penalty_until?: number;       // 逾期惩罚截止时间
    auto_deducted_amount?: number;        // 逾期自动扣款金额
    balance_after_deduct?: number;        // 扣款后余额
    created_at: number;
    updated_at: number;
}

// 用户坤呗统计
export interface UserKunbeiStats {
    linux_do_id: string;
    total_borrowed: number;               // 累计借款
    total_repaid: number;                 // 累计还款
    total_loans: number;                  // 总借款次数
    repaid_loans: number;                 // 已还款次数
    overdue_loans: number;                // 逾期次数
    credit_score: number;                 // 信用分
    is_banned: number;                    // 是否禁用
    last_borrow_date?: string;            // 最后借款日期
    has_daily_buff: number;               // 今日是否有buff
    buff_multiplier: number;              // buff倍率
    buff_used: number;                    // buff是否已使用
    updated_at: number;
}

// 坤呗梯度配置
export interface KunbeiGradientConfig {
    id?: number;
    quota_threshold: number;              // 额度阈值
    max_loan_amount: number;              // 最大可借金额
    priority: number;                     // 优先级
    is_active: number;                    // 是否启用
    created_at?: number;
    updated_at?: number;
}

// ========== 权重配置方案系统类型 ==========

// 符号权重配置方案
export interface SymbolWeightConfig {
    id?: number;
    config_name: string;
    weight_m: number;
    weight_t: number;
    weight_n: number;
    weight_j: number;
    weight_lq: number;
    weight_bj: number;
    weight_zft: number;
    weight_bdk: number;
    weight_lsh: number;
    description?: string;
    is_deleted: number;
    created_at: number;
    updated_at: number;
}

// ========== 奖励配置方案系统类型 ==========

// 奖励配置方案
export interface RewardConfigScheme {
    id?: number;
    scheme_name: string;
    description?: string;
    is_deleted: number;
    created_at: number;
    updated_at: number;
}

// 奖励规则
export interface RewardRule {
    id?: number;
    scheme_id: number;
    rule_name: string;
    rule_type: string;
    rule_category: string;                // normal/special/combo/punishment
    match_pattern: string;                // consecutive/any/sequence/combination/double_pair
    match_count?: number;
    required_symbols?: string;            // JSON数组
    win_multiplier: number;
    grant_free_spin: number;
    priority: number;
    is_active: number;
    description?: string;
    created_at: number;
    updated_at: number;
}

// 律师函惩罚配置
export interface PunishmentLshConfig {
    id?: number;
    scheme_id: number;
    lsh_count: number;                    // 律师函数量 1-4
    deduct_multiplier: number;            // 扣除倍数
    ban_hours: number;                    // 禁止抽奖时长
    is_active: number;
    created_at: number;
    updated_at: number;
}

// ========== 至尊场系统类型 ==========

// 用户至尊令牌
export interface SupremeUserTokens {
    linux_do_id: string;
    tokens: number;
    fragments: number;
    tokens_expires_at: number | null;
    supreme_mode_until: number | null;
    created_at: number;
    updated_at: number;
}

// 至尊场配置
export interface SupremeSlotConfig {
    id: number;
    enabled: number;
    
    // 令牌系统
    fragments_to_token: number;
    max_tokens_hold: number;
    token_valid_hours: number;
    session_valid_hours: number;
    
    // 投注配置
    min_bet_amount: number;
    max_bet_amount: number;
    bet_step: number;
    
    // 每日限制
    daily_entry_limit: number;
    daily_token_grant_limit: number;
    daily_bet_limit: number;
    
    // 引用配置ID
    weight_config_id: number;
    reward_scheme_id: number;
    
    updated_at: number;
}

// 至尊场游戏记录
export interface SupremeSlotRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    linux_do_username?: string;
    bet_amount: number;
    result_symbols: string;               // JSON数组
    win_type: string;
    win_multiplier: number;
    win_amount: number;
    timestamp: number;
    date: string;
    created_at: number;
}

// 至尊令牌掉落记录
export interface SupremeTokenDropRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    drop_type: string;                    // 'token' 或 'fragment'
    drop_count: number;
    source: string;                       // 'advanced_slot'
    trigger_win_type?: string;
    timestamp: number;
    date: string;
    created_at: number;
}

// ========== 权重配置方案系统类型 ==========

// 符号权重配置方案
export interface SymbolWeightConfig {
    id?: number;
    config_name: string;
    weight_m: number;
    weight_t: number;
    weight_n: number;
    weight_j: number;
    weight_lq: number;
    weight_bj: number;
    weight_zft: number;
    weight_bdk: number;
    weight_lsh: number;
    description?: string;
    is_deleted: number;
    created_at: number;
    updated_at: number;
}

// ========== 奖励配置方案系统类型 ==========

// 奖励配置方案
export interface RewardConfigScheme {
    id?: number;
    scheme_name: string;
    description?: string;
    is_deleted: number;
    created_at: number;
    updated_at: number;
}

// 奖励规则
export interface RewardRule {
    id?: number;
    scheme_id: number;
    rule_name: string;
    rule_type: string;
    rule_category: string;                // normal/special/combo/punishment
    match_pattern: string;                // consecutive/any/sequence/combination/double_pair
    match_count?: number;
    required_symbols?: string;            // JSON数组
    win_multiplier: number;
    grant_free_spin: number;
    priority: number;
    is_active: number;
    description?: string;
    created_at: number;
    updated_at: number;
}

// 律师函惩罚配置
export interface PunishmentLshConfig {
    id?: number;
    scheme_id: number;
    lsh_count: number;                    // 律师函数量 1-4
    deduct_multiplier: number;            // 扣除倍数
    ban_hours: number;                    // 禁止抽奖时长
    is_active: number;
    created_at: number;
    updated_at: number;
}

// ========== 至尊场系统类型 ==========

// 用户至尊令牌
export interface SupremeUserTokens {
    linux_do_id: string;
    tokens: number;
    fragments: number;
    tokens_expires_at: number | null;
    supreme_mode_until: number | null;
    created_at: number;
    updated_at: number;
}

// 至尊场配置
export interface SupremeSlotConfig {
    id: number;
    enabled: number;
    
    // 令牌系统
    fragments_to_token: number;
    max_tokens_hold: number;
    token_valid_hours: number;
    session_valid_hours: number;
    
    // 投注配置
    min_bet_amount: number;
    max_bet_amount: number;
    bet_step: number;
    
    // 每日限制
    daily_entry_limit: number;
    daily_token_grant_limit: number;
    daily_bet_limit: number;
    
    // 引用配置ID
    weight_config_id: number;
    reward_scheme_id: number;
    
    updated_at: number;
}

// 至尊场游戏记录
export interface SupremeSlotRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    linux_do_username?: string;
    bet_amount: number;
    result_symbols: string;               // JSON数组
    win_type: string;
    win_multiplier: number;
    win_amount: number;
    timestamp: number;
    date: string;
    created_at: number;
}

// 至尊令牌掉落记录
export interface SupremeTokenDropRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    drop_type: string;                    // 'token' 或 'fragment'
    drop_count: number;
    source: string;                       // 'advanced_slot'
    trigger_win_type?: string;
    timestamp: number;
    date: string;
    created_at: number;
}
