import { Database } from 'bun:sqlite';
import { CONFIG } from './config';
import type {
    User,
    ClaimRecord,
    DonateRecord,
    AdminConfig,
    SessionData,
    SlotMachineConfig,
    SlotMachineRecord,
    UserFreeSpin,
    UserTickets,
    AdvancedSlotConfig,
    TicketDropRecord,
    AdvancedSlotRTPStats,
    UserAdvancedEntry,
    UserDailyTicketGrant,
    KunbeiConfig,
    UserLoan,
    UserKunbeiStats,
    KunbeiGradientConfig,
    Achievement,
    UserAchievement,
    AchievementProgress,
    UserAchievementStats,
} from './types';
// 数据库迁移已整合到本文件中

// 创建数据库连接
export const db = new Database(CONFIG.DATABASE_PATH, { create: true });

// 启用 WAL 模式（提升并发性能）
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = 10000');
db.exec('PRAGMA temp_store = MEMORY');

/**
 * 初始化数据库表
 */
export function initDatabase() {
    console.log('📦 初始化数据库...');

    // 用户表
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      linux_do_username TEXT,
      kyx_user_id INTEGER NOT NULL,
      is_banned INTEGER DEFAULT 0,
      banned_at INTEGER,
      banned_reason TEXT,
      created_at INTEGER NOT NULL
    )
  `);

    // 🚀 优化：为用户表添加索引
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_linux_do_username ON users(linux_do_username)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned)');

    // 添加封禁相关字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE users ADD COLUMN banned_reason TEXT');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加LinuxDo用户名字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE users ADD COLUMN linux_do_username TEXT');
        console.log('✅ 已添加 linux_do_username 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加连击计数器字段（用于连续中奖成就）
    try {
        db.exec('ALTER TABLE users ADD COLUMN win_streak INTEGER DEFAULT 0');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 领取记录表
    db.exec(`
    CREATE TABLE IF NOT EXISTS claim_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      quota_added INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_claim_linux_do_id ON claim_records(linux_do_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_claim_date ON claim_records(date)');
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_claim_timestamp ON claim_records(timestamp)'
    );

    // 投喂记录表
    db.exec(`
    CREATE TABLE IF NOT EXISTS donate_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      keys_count INTEGER NOT NULL,
      total_quota_added INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      push_status TEXT DEFAULT 'success',
      push_message TEXT,
      failed_keys TEXT,
      key_type TEXT DEFAULT 'modelscope'
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_donate_linux_do_id ON donate_records(linux_do_id)'
    );
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_donate_timestamp ON donate_records(timestamp)'
    );

    // 添加 key_type 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE donate_records ADD COLUMN key_type TEXT DEFAULT \'modelscope\'');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 已使用的 Key 表
    db.exec(`
    CREATE TABLE IF NOT EXISTS used_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      key_type TEXT DEFAULT 'modelscope',
      UNIQUE(key, key_type)
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_used_keys_key ON used_keys(key)');

    // 添加 key_type 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE used_keys ADD COLUMN key_type TEXT DEFAULT \'modelscope\'');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // Session 表
    db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)'
    );

    // 🛡️ 速率限制封禁记录表
    db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      ban_type TEXT NOT NULL,
      trigger_count INTEGER NOT NULL,
      ban_reason TEXT NOT NULL,
      banned_at INTEGER NOT NULL,
      banned_until INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      unbanned_at INTEGER,
      unbanned_by TEXT,
      unban_reason TEXT,
      created_at INTEGER NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_rate_limit_bans_linux_do_id ON rate_limit_bans(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rate_limit_bans_is_active ON rate_limit_bans(is_active)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rate_limit_bans_banned_until ON rate_limit_bans(banned_until)');

    // 管理员配置表
    db.exec(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      session TEXT DEFAULT '',
      new_api_user TEXT DEFAULT '1',
      claim_quota INTEGER DEFAULT 20000000,
      max_daily_claims INTEGER DEFAULT 1,
      keys_api_url TEXT DEFAULT 'https://gpt-load.kyx03.de/api/keys/add-async',
      keys_authorization TEXT DEFAULT '',
      modelscope_group_id INTEGER DEFAULT 26,
      iflow_group_id INTEGER DEFAULT 26,
      max_daily_donate_modelscope INTEGER DEFAULT 1,
      max_daily_donate_iflow INTEGER DEFAULT 1,
      updated_at INTEGER NOT NULL,
      -- 钱包相关配置
      wallet_exchange_rate INTEGER DEFAULT 500000, -- 每🥚对应的quota（默认500,000）
      wallet_daily_transfer_limit_count INTEGER DEFAULT 2, -- 每日划转次数上限
      wallet_initial_egg INTEGER DEFAULT 250 -- 初始🥚额度
    )
  `);

    // 插入默认管理员配置
    db.exec(`
    INSERT OR IGNORE INTO admin_config (id, updated_at, claim_quota, max_daily_claims)
    VALUES (1, ${Date.now()}, ${CONFIG.DEFAULT_CLAIM_QUOTA}, 1)
  `);

    // 兼容旧数据：如果表已存在但缺少 max_daily_claims 字段，则添加
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN max_daily_claims INTEGER DEFAULT 1');
        console.log('✅ 已添加 max_daily_claims 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 兼容旧数据：重命名 group_id 为 modelscope_group_id
    try {
        // SQLite 不支持 RENAME COLUMN，需要通过查询判断
        const hasOldColumn = db.query("SELECT COUNT(*) as count FROM pragma_table_info('admin_config') WHERE name='group_id'").get();
        const hasNewColumn = db.query("SELECT COUNT(*) as count FROM pragma_table_info('admin_config') WHERE name='modelscope_group_id'").get();

        if ((hasOldColumn as any).count > 0 && (hasNewColumn as any).count === 0) {
            // 先添加新字段
            db.exec('ALTER TABLE admin_config ADD COLUMN modelscope_group_id INTEGER DEFAULT 26');
            // 复制旧数据
            db.exec('UPDATE admin_config SET modelscope_group_id = group_id');
            console.log('✅ 已将 group_id 迁移为 modelscope_group_id');
        }
    } catch (e) {
        // 忽略错误
    }

    // 兼容旧数据：如果表已存在但缺少 iflow_group_id 字段，则添加
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN iflow_group_id INTEGER DEFAULT 26');
        console.log('✅ 已添加 iflow_group_id 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 兼容旧数据：添加投喂限制字段
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN max_daily_donate_modelscope INTEGER DEFAULT 1');
        console.log('✅ 已添加 max_daily_donate_modelscope 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 兼容旧数据：添加钱包相关配置字段
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN wallet_exchange_rate INTEGER DEFAULT 500000');
        console.log('✅ 已添加 wallet_exchange_rate 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN wallet_daily_transfer_limit_count INTEGER DEFAULT 2');
        console.log('✅ 已添加 wallet_daily_transfer_limit_count 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN wallet_initial_egg INTEGER DEFAULT 250');
        console.log('✅ 已添加 wallet_initial_egg 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 用户钱包表（余额以 quota 存储，展示时换算为🥚）
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      linux_do_id TEXT PRIMARY KEY,
      balance_quota INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wallets_updated_at ON user_wallets(updated_at)');

    // 迁移：检查并添加 user_wallets 表的缺失列
    try {
        db.exec('ALTER TABLE user_wallets ADD COLUMN balance_quota INTEGER DEFAULT 0');
        console.log('✅ 已添加 balance_quota 字段到 user_wallets');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    try {
        db.exec('ALTER TABLE user_wallets ADD COLUMN updated_at INTEGER DEFAULT 0');
        console.log('✅ 已添加 updated_at 字段到 user_wallets');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 钱包划转记录（用于限次与审计）
    db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transfer_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      direction TEXT NOT NULL, -- in: 上游->本地, out: 本地->上游
      amount_quota INTEGER NOT NULL, -- 以quota计
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_date ON wallet_transfer_records(linux_do_id, date)');

    try {
        db.exec('ALTER TABLE admin_config ADD COLUMN max_daily_donate_iflow INTEGER DEFAULT 1');
        console.log('✅ 已添加 max_daily_donate_iflow 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 老虎机配置表
    db.exec(`
    CREATE TABLE IF NOT EXISTS slot_machine_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bet_amount INTEGER DEFAULT 10000000,
      max_daily_spins INTEGER DEFAULT 5,
      min_quota_required INTEGER DEFAULT 10000000,
      enabled INTEGER DEFAULT 1,
      background_type TEXT DEFAULT 'default',
      buy_spins_enabled INTEGER DEFAULT 0,
      buy_spins_price INTEGER DEFAULT 20000000,
      max_daily_buy_spins INTEGER DEFAULT 5,
      updated_at INTEGER NOT NULL
    )
  `);

    // 兼容旧数据：添加 background_type 字段（必须在 INSERT 之前）
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN background_type TEXT DEFAULT \'default\'');
        console.log('✅ 已添加 background_type 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 兼容旧数据：添加购买次数相关字段
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN buy_spins_enabled INTEGER DEFAULT 0');
        console.log('✅ 已添加 buy_spins_enabled 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN buy_spins_price INTEGER DEFAULT 20000000');
        console.log('✅ 已添加 buy_spins_price 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN max_daily_buy_spins INTEGER DEFAULT 5');
        console.log('✅ 已添加 max_daily_buy_spins 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加配置方案引用字段
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN weight_config_id INTEGER DEFAULT 1');
        console.log('✅ 已添加 weight_config_id 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_machine_config ADD COLUMN reward_scheme_id INTEGER DEFAULT 1');
        console.log('✅ 已添加 reward_scheme_id 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 插入默认老虎机配置
    db.exec(`
    INSERT OR IGNORE INTO slot_machine_config (id, bet_amount, max_daily_spins, min_quota_required, enabled, background_type, buy_spins_enabled, buy_spins_price, max_daily_buy_spins, updated_at)
    VALUES (1, 10000000, 5, 10000000, 1, 'default', 0, 20000000, 5, ${Date.now()})
  `);

    // 符号权重配置表
    db.exec(`
    CREATE TABLE IF NOT EXISTS slot_symbol_weights (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      weight_m INTEGER DEFAULT 100,
      weight_t INTEGER DEFAULT 100,
      weight_n INTEGER DEFAULT 100,
      weight_j INTEGER DEFAULT 100,
      weight_lq INTEGER DEFAULT 100,
      weight_bj INTEGER DEFAULT 100,
      weight_zft INTEGER DEFAULT 100,
      weight_bdk INTEGER DEFAULT 100,
      weight_lsh INTEGER DEFAULT 25,
      weight_man INTEGER DEFAULT 25,
      updated_at INTEGER NOT NULL
    )
  `);

    // 🔥 数据库迁移：添加新符号列（如果不存在）
    try {
        db.exec('ALTER TABLE slot_symbol_weights ADD COLUMN weight_lsh INTEGER DEFAULT 25');
        console.log('✅ 已添加 slot_symbol_weights.weight_lsh 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_symbol_weights ADD COLUMN weight_man INTEGER DEFAULT 25');
        console.log('✅ 已添加 slot_symbol_weights.weight_man 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 插入默认符号权重配置
    db.exec(`
    INSERT OR IGNORE INTO slot_symbol_weights (id, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, weight_man, updated_at)
    VALUES (1, 100, 100, 100, 100, 100, 100, 100, 100, 25, 25, ${Date.now()})
  `);

    // 奖励倍数配置表
    db.exec(`
    CREATE TABLE IF NOT EXISTS slot_reward_multipliers (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      super_jackpot_multiplier INTEGER DEFAULT 256,
      special_combo_multiplier INTEGER DEFAULT 16,
      quad_multiplier INTEGER DEFAULT 32,
      triple_multiplier INTEGER DEFAULT 8,
      double_multiplier INTEGER DEFAULT 4,
      updated_at INTEGER NOT NULL
    )
  `);

    // 插入默认奖励倍数配置
    db.exec(`
    INSERT OR IGNORE INTO slot_reward_multipliers (id, super_jackpot_multiplier, special_combo_multiplier, quad_multiplier, triple_multiplier, double_multiplier, updated_at)
    VALUES (1, 256, 16, 32, 8, 4, ${Date.now()})
  `);

    // 老虎机游戏记录表
    db.exec(`
    CREATE TABLE IF NOT EXISTS slot_machine_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      linux_do_username TEXT,
      bet_amount INTEGER NOT NULL,
      result_symbols TEXT NOT NULL,
      win_type TEXT NOT NULL,
      win_multiplier REAL NOT NULL,
      win_amount INTEGER NOT NULL,
      free_spin_awarded INTEGER DEFAULT 0,
      is_free_spin INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_slot_linux_do_id ON slot_machine_records(linux_do_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_slot_date ON slot_machine_records(date)');
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_slot_timestamp ON slot_machine_records(timestamp)'
    );
    // 🚀 优化：为用户筛选字段添加索引
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_slot_linux_do_username ON slot_machine_records(linux_do_username)'
    );
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_slot_username ON slot_machine_records(username)'
    );
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_slot_mode ON slot_machine_records(slot_mode)'
    );

    // 添加 linux_do_username 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN linux_do_username TEXT');
        console.log('✅ 已添加 linux_do_username 字段到 slot_machine_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加 rule_name 字段（兼容旧数据库）- 用于显示具体的规则名称
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN rule_name TEXT');
        console.log('✅ 已添加 rule_name 字段到 slot_machine_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 用户免费次数表
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_free_spins (
      linux_do_id TEXT PRIMARY KEY,
      free_spins INTEGER DEFAULT 0,
      banned_until INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

    // 添加 banned_until 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE user_free_spins ADD COLUMN banned_until INTEGER DEFAULT 0');
        console.log('✅ 已添加 banned_until 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加 ban_slot_mode 字段（记录封禁发生的场次类型）
    try {
        db.exec('ALTER TABLE user_free_spins ADD COLUMN ban_slot_mode TEXT DEFAULT NULL');
        console.log('✅ 已添加 ban_slot_mode 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加 ban_hours 字段（记录实际封禁的小时数）
    try {
        db.exec('ALTER TABLE user_free_spins ADD COLUMN ban_hours INTEGER DEFAULT 0');
        console.log('✅ 已添加 ban_hours 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加 banned_at 字段（记录封禁开始时间的时间戳）
    try {
        db.exec('ALTER TABLE user_free_spins ADD COLUMN banned_at INTEGER DEFAULT 0');
        console.log('✅ 已添加 banned_at 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 用户老虎机统计表（用于排行榜）
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_slot_stats (
      linux_do_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar_url TEXT,
      total_spins INTEGER DEFAULT 0,
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      biggest_win INTEGER DEFAULT 0,
      biggest_win_type TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

    // 添加 avatar_url 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE user_slot_stats ADD COLUMN avatar_url TEXT');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_slot_stats_total_win ON user_slot_stats(total_win DESC)');

    // 日榜统计表
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_slot_daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      date TEXT NOT NULL,
      total_spins INTEGER DEFAULT 0,
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      biggest_win INTEGER DEFAULT 0,
      biggest_win_type TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(linux_do_id, date)
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON user_slot_daily_stats(date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_daily_stats_linux_do_id ON user_slot_daily_stats(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_daily_stats_profit ON user_slot_daily_stats((total_win - total_bet) DESC)');

    // 周榜统计表（周起始日期，例如：2025-01-06 代表该周的周一）
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_slot_weekly_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      week_start TEXT NOT NULL,
      total_spins INTEGER DEFAULT 0,
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      biggest_win INTEGER DEFAULT 0,
      biggest_win_type TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(linux_do_id, week_start)
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_stats_week ON user_slot_weekly_stats(week_start)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_stats_linux_do_id ON user_slot_weekly_stats(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_stats_profit ON user_slot_weekly_stats((total_win - total_bet) DESC)');

    // 购买抽奖次数记录表
    db.exec(`
    CREATE TABLE IF NOT EXISTS buy_spins_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      linux_do_username TEXT,
      spins_count INTEGER NOT NULL,
      price_paid INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_buy_spins_linux_do_id ON buy_spins_records(linux_do_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_buy_spins_date ON buy_spins_records(date)');
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_buy_spins_timestamp ON buy_spins_records(timestamp)'
    );

    // 待发放奖金表（用于失败重试）
    db.exec(`
    CREATE TABLE IF NOT EXISTS pending_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      kyx_user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      reward_amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      processed_at INTEGER
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pending_rewards_status ON pending_rewards(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pending_rewards_linux_do_id ON pending_rewards(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pending_rewards_created_at ON pending_rewards(created_at)');

    // ========== 高级场系统表 ==========

    // 用户入场券和碎片表
    db.exec(`
    CREATE TABLE IF NOT EXISTS user_tickets (
      linux_do_id TEXT PRIMARY KEY,
      tickets INTEGER DEFAULT 0,
      fragments INTEGER DEFAULT 0,
      tickets_expires_at INTEGER,
      advanced_mode_until INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_tickets_expires ON user_tickets(tickets_expires_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_tickets_advanced ON user_tickets(advanced_mode_until)');

    // 高级场配置表
    db.exec(`
    CREATE TABLE IF NOT EXISTS advanced_slot_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      bet_min INTEGER DEFAULT 50000000,
      bet_max INTEGER DEFAULT 250000000,
      reward_multiplier REAL DEFAULT 4.0,
      penalty_weight_factor REAL DEFAULT 2.0,
      rtp_target REAL DEFAULT 0.95,
      ticket_valid_hours INTEGER DEFAULT 24,
      session_valid_hours INTEGER DEFAULT 24,
      fragments_needed INTEGER DEFAULT 5,
      drop_rate_triple REAL DEFAULT 1.0,
      drop_rate_double REAL DEFAULT 1.0,
      max_tickets_hold INTEGER DEFAULT 2,
      daily_bet_limit INTEGER DEFAULT 5000000000,
      daily_entry_limit INTEGER DEFAULT 2,
      daily_ticket_grant_limit INTEGER DEFAULT 2,
      updated_at INTEGER NOT NULL
    )
  `);

    // 添加高级场配置方案引用字段
    try {
        db.exec('ALTER TABLE advanced_slot_config ADD COLUMN weight_config_id INTEGER DEFAULT 1');
        console.log('✅ 已添加 advanced_slot_config.weight_config_id 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE advanced_slot_config ADD COLUMN reward_scheme_id INTEGER DEFAULT 1');
        console.log('✅ 已添加 advanced_slot_config.reward_scheme_id 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加至尊令牌掉落配置字段
    try {
        db.exec('ALTER TABLE advanced_slot_config ADD COLUMN supreme_token_drop_rate REAL DEFAULT 0.001');
        console.log('✅ 已添加 supreme_token_drop_rate 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE advanced_slot_config ADD COLUMN supreme_fragment_drop_rate REAL DEFAULT 0.02');
        console.log('✅ 已添加 supreme_fragment_drop_rate 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 高级场符号权重配置表（独立于初级场）
    db.exec(`
    CREATE TABLE IF NOT EXISTS advanced_slot_symbol_weights (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      weight_m INTEGER DEFAULT 100,
      weight_t INTEGER DEFAULT 100,
      weight_n INTEGER DEFAULT 100,
      weight_j INTEGER DEFAULT 100,
      weight_lq INTEGER DEFAULT 100,
      weight_bj INTEGER DEFAULT 100,
      weight_zft INTEGER DEFAULT 100,
      weight_bdk INTEGER DEFAULT 100,
      weight_lsh INTEGER DEFAULT 50,
      weight_man INTEGER DEFAULT 30,
      updated_at INTEGER NOT NULL
    )
  `);

    // 🔥 数据库迁移：添加高级场新符号列（如果不存在）
    try {
        db.exec('ALTER TABLE advanced_slot_symbol_weights ADD COLUMN weight_lsh INTEGER DEFAULT 50');
        console.log('✅ 已添加 advanced_slot_symbol_weights.weight_lsh 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE advanced_slot_symbol_weights ADD COLUMN weight_man INTEGER DEFAULT 30');
        console.log('✅ 已添加 advanced_slot_symbol_weights.weight_man 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 入场券掉落记录表
    // ========== 掉落配置表 (统一掉落系统) ==========
    db.exec(`
        CREATE TABLE IF NOT EXISTS drop_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slot_mode TEXT NOT NULL,
            trigger_rule_name TEXT NOT NULL,
            drop_item_type TEXT NOT NULL,
            drop_probability REAL NOT NULL,
            drop_count INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            priority INTEGER DEFAULT 0,
            description TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(slot_mode, trigger_rule_name, drop_item_type)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_drop_configs_mode ON drop_configs(slot_mode)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_drop_configs_active ON drop_configs(is_active)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_drop_configs_rule ON drop_configs(trigger_rule_name)');

    db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_drop_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      drop_type TEXT NOT NULL,
      drop_count INTEGER NOT NULL,
      trigger_win_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      date TEXT NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_drop_linux_do_id ON ticket_drop_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_drop_timestamp ON ticket_drop_records(timestamp)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_drop_date ON ticket_drop_records(date)');

    // 高级场RTP统计表
    db.exec(`
    CREATE TABLE IF NOT EXISTS advanced_slot_rtp_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linux_do_id TEXT NOT NULL UNIQUE,
      total_bet INTEGER DEFAULT 0,
      total_win INTEGER DEFAULT 0,
      rtp REAL DEFAULT 0,
      games_count INTEGER DEFAULT 0,
      last_updated INTEGER NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_advanced_rtp_linux_do_id ON advanced_slot_rtp_stats(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_advanced_rtp_last_updated ON advanced_slot_rtp_stats(last_updated)');

    // 修改 slot_machine_records 表，添加高级场相关字段（兼容旧数据）
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN slot_mode TEXT DEFAULT \'normal\'');
        console.log('✅ 已添加 slot_mode 字段到 slot_machine_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN ticket_dropped INTEGER DEFAULT 0');
        console.log('✅ 已添加 ticket_dropped 字段到 slot_machine_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN drop_type TEXT');
        console.log('✅ 已添加 drop_type 字段到 slot_machine_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_slot_records_mode ON slot_machine_records(slot_mode)');

    // 用户每日进入高级场记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_advanced_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            entry_count INTEGER DEFAULT 0,
            last_entry_time INTEGER,
            UNIQUE(linux_do_id, entry_date)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_advanced_entries_date ON user_advanced_entries(entry_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_advanced_entries_user ON user_advanced_entries(linux_do_id)');

    // 用户每日入场券获得记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_daily_ticket_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            grant_date TEXT NOT NULL,
            ticket_granted INTEGER DEFAULT 0,
            fragment_granted INTEGER DEFAULT 0,
            last_grant_time INTEGER,
            UNIQUE(linux_do_id, grant_date)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_ticket_grants_date ON user_daily_ticket_grants(grant_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_ticket_grants_user ON user_daily_ticket_grants(linux_do_id)');

    // ========== 权重配置方案表（通用）==========

    // 符号权重配置方案表（所有场次共享）
    db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_weight_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_name TEXT NOT NULL UNIQUE,
            weight_m INTEGER DEFAULT 100,
            weight_t INTEGER DEFAULT 100,
            weight_n INTEGER DEFAULT 100,
            weight_j INTEGER DEFAULT 100,
            weight_lq INTEGER DEFAULT 100,
            weight_bj INTEGER DEFAULT 100,
            weight_zft INTEGER DEFAULT 100,
            weight_bdk INTEGER DEFAULT 100,
            weight_lsh INTEGER DEFAULT 25,
            weight_man INTEGER DEFAULT 25,
            description TEXT,
            is_deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_weight_configs_deleted ON symbol_weight_configs(is_deleted)');

    // 🔥 数据库迁移：为 symbol_weight_configs 添加 weight_man 列（如果不存在）
    try {
        db.exec('ALTER TABLE symbol_weight_configs ADD COLUMN weight_man INTEGER DEFAULT 25');
        console.log('✅ 已添加 symbol_weight_configs.weight_man 字段');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // ========== 奖励配置方案表（通用）==========

    // 奖励配置方案表
    db.exec(`
        CREATE TABLE IF NOT EXISTS reward_config_schemes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheme_name TEXT NOT NULL UNIQUE,
            description TEXT,
            is_deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_reward_schemes_deleted ON reward_config_schemes(is_deleted)');

    // 奖励规则表（每个方案包含多条规则）
    db.exec(`
        CREATE TABLE IF NOT EXISTS reward_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheme_id INTEGER NOT NULL,
            rule_name TEXT NOT NULL,
            rule_type TEXT NOT NULL,
            rule_category TEXT NOT NULL,
            match_pattern TEXT NOT NULL,
            match_count INTEGER,
            required_symbols TEXT,
            win_multiplier REAL NOT NULL,
            grant_free_spin INTEGER DEFAULT 0,
            priority INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            description TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (scheme_id) REFERENCES reward_config_schemes(id)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_reward_rules_scheme ON reward_rules(scheme_id, priority DESC)');

    // 律师函惩罚配置表（关联到奖励方案）
    db.exec(`
        CREATE TABLE IF NOT EXISTS punishment_lsh_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheme_id INTEGER NOT NULL,
            lsh_count INTEGER NOT NULL,
            deduct_multiplier REAL NOT NULL,
            ban_hours INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (scheme_id) REFERENCES reward_config_schemes(id),
            UNIQUE(scheme_id, lsh_count)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_punishment_lsh_scheme ON punishment_lsh_configs(scheme_id)');

    // ========== 坤呗借款系统表 ==========

    // 坤呗配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS kunbei_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,
            max_loan_amount INTEGER DEFAULT 50000000,
            min_loan_amount INTEGER DEFAULT 5000000,
            repay_multiplier REAL DEFAULT 2.5,
            loan_duration_hours REAL DEFAULT 72,  -- 支持小数
            early_repay_discount REAL DEFAULT 0.025,
            overdue_penalty_hours INTEGER DEFAULT 60,
            overdue_ban_advanced INTEGER DEFAULT 1,
            max_active_loans INTEGER DEFAULT 1,
            deduct_all_quota_on_overdue INTEGER DEFAULT 1,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
        )
    `);

    // 添加逾期扣款倍数字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE kunbei_config ADD COLUMN overdue_deduct_multiplier REAL DEFAULT 2.5');
        console.log('✅ 已添加 overdue_deduct_multiplier 字段（逾期扣款倍数）');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加每日借款次数限制字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE kunbei_config ADD COLUMN max_daily_borrows INTEGER DEFAULT 3');
        console.log('✅ 已添加 max_daily_borrows 字段（每日借款次数限制）');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 用户借款记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_loans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            loan_amount INTEGER NOT NULL,
            repay_amount INTEGER NOT NULL,
            actual_repay_amount INTEGER,
            status TEXT DEFAULT 'active',
            borrowed_at INTEGER NOT NULL,
            due_at INTEGER NOT NULL,
            repaid_at INTEGER,
            overdue_penalty_until INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_linux_do_id ON user_loans(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_status ON user_loans(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_due_at ON user_loans(due_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_created_at ON user_loans(created_at)');

    // 添加逾期自动扣款字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE user_loans ADD COLUMN auto_deducted_amount INTEGER DEFAULT 0');
        console.log('✅ 已添加 auto_deducted_amount 字段（逾期自动扣款记录）');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 添加扣款后余额字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE user_loans ADD COLUMN balance_after_deduct INTEGER DEFAULT 0');
        console.log('✅ 已添加 balance_after_deduct 字段（扣款后余额记录）');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 用户坤呗统计表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_kunbei_stats (
            linux_do_id TEXT PRIMARY KEY,
            total_borrowed INTEGER DEFAULT 0,
            total_repaid INTEGER DEFAULT 0,
            total_loans INTEGER DEFAULT 0,
            repaid_loans INTEGER DEFAULT 0,
            overdue_loans INTEGER DEFAULT 0,
            credit_score INTEGER DEFAULT 100,
            is_banned INTEGER DEFAULT 0,
            last_borrow_date TEXT,
            has_daily_buff INTEGER DEFAULT 0,
            buff_multiplier REAL DEFAULT 2.5,
            buff_used INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
    `);

    // 坤呗梯度配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS kunbei_gradient_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quota_threshold INTEGER NOT NULL,
            max_loan_amount INTEGER NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_kunbei_gradient_priority ON kunbei_gradient_configs(priority DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kunbei_gradient_active ON kunbei_gradient_configs(is_active)');

    // ========== 至尊场系统表 ==========

    // 用户至尊令牌表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_user_tokens (
            linux_do_id TEXT PRIMARY KEY,
            tokens INTEGER DEFAULT 0,
            fragments INTEGER DEFAULT 0,
            tokens_expires_at INTEGER,
            supreme_mode_until INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_tokens_expires ON supreme_user_tokens(tokens_expires_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_mode_until ON supreme_user_tokens(supreme_mode_until)');

    // 至尊场配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_slot_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,
            
            -- 令牌系统
            fragments_to_token INTEGER DEFAULT 10,
            max_tokens_hold INTEGER DEFAULT 3,
            token_valid_hours REAL DEFAULT 168,
            session_valid_hours REAL DEFAULT 2,
            
            -- 投注配置
            min_bet_amount INTEGER DEFAULT 500000000,
            max_bet_amount INTEGER DEFAULT 5000000000,
            bet_step INTEGER DEFAULT 100000000,
            
            -- 每日限制
            daily_entry_limit INTEGER DEFAULT 3,
            daily_token_grant_limit INTEGER DEFAULT 1,
            daily_bet_limit INTEGER DEFAULT 50000000000,
            
            -- 引用配置ID
            weight_config_id INTEGER DEFAULT 1,
            reward_scheme_id INTEGER DEFAULT 1,
            
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (weight_config_id) REFERENCES symbol_weight_configs(id),
            FOREIGN KEY (reward_scheme_id) REFERENCES reward_config_schemes(id)
        )
    `);

    // 至尊场游戏记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_slot_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            linux_do_username TEXT,
            bet_amount INTEGER NOT NULL,
            result_symbols TEXT NOT NULL,
            win_type TEXT NOT NULL,
            win_multiplier REAL NOT NULL,
            win_amount INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            date TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_records_linux_do_id ON supreme_slot_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_records_timestamp ON supreme_slot_records(timestamp)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_records_date ON supreme_slot_records(date)');
    // 🚀 优化：为至尊场记录用户筛选字段添加索引
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_records_linux_do_username ON supreme_slot_records(linux_do_username)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_records_username ON supreme_slot_records(username)');

    // 添加 rule_name 字段到至尊场记录表（兼容旧数据库）
    try {
        db.exec('ALTER TABLE supreme_slot_records ADD COLUMN rule_name TEXT');
        console.log('✅ 已添加 rule_name 字段到 supreme_slot_records');
    } catch (e) {
        // 字段已存在，忽略错误
    }

    // 至尊令牌掉落记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_token_drop_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            drop_type TEXT NOT NULL,
            drop_count INTEGER NOT NULL,
            source TEXT NOT NULL,
            trigger_win_type TEXT,
            timestamp INTEGER NOT NULL,
            date TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_drop_linux_do_id ON supreme_token_drop_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_drop_date ON supreme_token_drop_records(date)');

    // 至尊场每日进入记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_daily_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            entry_count INTEGER DEFAULT 0,
            last_entry_time INTEGER,
            UNIQUE(linux_do_id, entry_date)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_entries_date ON supreme_daily_entries(entry_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_entries_user ON supreme_daily_entries(linux_do_id)');

    // 至尊场每日令牌获得记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS supreme_daily_token_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            grant_date TEXT NOT NULL,
            tokens_granted INTEGER DEFAULT 0,
            fragments_granted INTEGER DEFAULT 0,
            last_grant_time INTEGER,
            UNIQUE(linux_do_id, grant_date)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_grants_date ON supreme_daily_token_grants(grant_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_supreme_grants_user ON supreme_daily_token_grants(linux_do_id)');

    // ========== 成就系统表 ==========

    // 成就定义表
    db.exec(`
        CREATE TABLE IF NOT EXISTS achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            achievement_key TEXT UNIQUE NOT NULL,
            achievement_name TEXT NOT NULL,
            achievement_desc TEXT NOT NULL,
            category TEXT NOT NULL,
            icon TEXT NOT NULL,
            condition_type TEXT NOT NULL,
            condition_value TEXT NOT NULL,
            reward_quota INTEGER NOT NULL,
            rarity TEXT NOT NULL DEFAULT 'common',
            display_order INTEGER DEFAULT 0,
            is_hidden INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_achievements_category ON achievements(category)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_achievements_active ON achievements(is_active)');

    // 用户成就表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            achievement_key TEXT NOT NULL,
            unlocked_at INTEGER NOT NULL,
            reward_claimed INTEGER DEFAULT 0,
            claimed_at INTEGER,
            progress TEXT,
            UNIQUE(linux_do_id, achievement_key)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_achievements_unlocked ON user_achievements(unlocked_at)');

    // 成就进度表
    db.exec(`
        CREATE TABLE IF NOT EXISTS achievement_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            achievement_key TEXT NOT NULL,
            current_value INTEGER DEFAULT 0,
            target_value INTEGER NOT NULL,
            last_updated INTEGER NOT NULL,
            UNIQUE(linux_do_id, achievement_key)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_achievement_progress_user ON achievement_progress(linux_do_id)');

    // 用户成就统计表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_achievement_stats (
            linux_do_id TEXT PRIMARY KEY,
            total_achievements INTEGER DEFAULT 0,
            unlocked_achievements INTEGER DEFAULT 0,
            completion_rate REAL DEFAULT 0,
            total_rewards INTEGER DEFAULT 0,
            claimed_rewards INTEGER DEFAULT 0,
            badge_slot_1 TEXT,
            badge_slot_2 TEXT,
            badge_slot_3 TEXT,
            updated_at INTEGER NOT NULL
        )
    `);

    // 用户符号收集表（用于符号学者成就）
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_symbol_collection (
            linux_do_id TEXT PRIMARY KEY,
            symbol_m INTEGER DEFAULT 0,
            symbol_t INTEGER DEFAULT 0,
            symbol_n INTEGER DEFAULT 0,
            symbol_j INTEGER DEFAULT 0,
            symbol_lq INTEGER DEFAULT 0,
            symbol_bj INTEGER DEFAULT 0,
            symbol_zft INTEGER DEFAULT 0,
            symbol_bdk INTEGER DEFAULT 0,
            symbol_lsh INTEGER DEFAULT 0,
            symbol_man INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbol_collection_user ON user_symbol_collection(linux_do_id)');

    // 用户盈利追踪表（用于逆风翻盘成就）
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_profit_tracking (
            linux_do_id TEXT PRIMARY KEY,
            lowest_profit INTEGER DEFAULT 0,
            highest_profit INTEGER DEFAULT 0,
            last_profit INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_profit_tracking_user ON user_profit_tracking(linux_do_id)');

    console.log('✅ 数据库表结构创建完成（含权重/奖励方案、至尊场和成就系统）');

    // 插入默认数据
    insertDefaultData();

    console.log('✅ 数据库初始化完成（含高级场、至尊场和配置方案系统）');

    // 初始化预编译查询语句
    initQueries();

    // 🔥 自动修复错误的奖励规则数据
    fixRewardRulesData();

    // 🔥 自动更新成就描述单位
    fixAchievementDescriptions();
}

/**
 * 插入默认数据
 */
function insertDefaultData() {
    console.log('📝 插入默认数据...');

    try {
        // 插入默认高级场配置
        db.exec(`
            INSERT OR IGNORE INTO advanced_slot_config (
                id, enabled, bet_min, bet_max, reward_multiplier, penalty_weight_factor, 
                rtp_target, ticket_valid_hours, session_valid_hours, fragments_needed, 
                drop_rate_triple, drop_rate_double, max_tickets_hold, daily_bet_limit, 
                daily_entry_limit, daily_ticket_grant_limit, updated_at
            )
            VALUES (1, 1, 50000000, 250000000, 4.0, 2.0, 0.95, 24, 24, 5, 1.0, 1.0, 2, 5000000000, 2, 2, ${Date.now()})
        `);

        // 插入默认高级场符号权重配置（律师函权重更高）
        db.exec(`
            INSERT OR IGNORE INTO advanced_slot_symbol_weights (
                id, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, 
                weight_zft, weight_bdk, weight_lsh, weight_man, updated_at
            )
            VALUES (1, 100, 100, 100, 100, 100, 100, 100, 100, 50, 30, ${Date.now()})
        `);

        // 插入默认坤呗配置
        db.exec(`
            INSERT OR IGNORE INTO kunbei_config (
                id, enabled, max_loan_amount, min_loan_amount, repay_multiplier,
                loan_duration_hours, early_repay_discount, overdue_penalty_hours,
                overdue_ban_advanced, max_active_loans, deduct_all_quota_on_overdue,
                overdue_deduct_multiplier, max_daily_borrows, updated_at
            )
            VALUES (1, 1, 50000000, 5000000, 2.5, 72, 0.025, 60, 1, 1, 1, 2.5, 3, ${Date.now()})
        `);

        // 🔥 确保坤呗配置字段完整（修复缺失字段）
        db.exec(`
            UPDATE kunbei_config 
            SET 
                overdue_deduct_multiplier = COALESCE(overdue_deduct_multiplier, 2.5),
                max_daily_borrows = COALESCE(max_daily_borrows, 3),
                updated_at = ${Date.now()}
            WHERE id = 1
        `);

        // 插入默认坤呗梯度配置（仅在表为空时）
        const existingKunbeiConfigs = db.query('SELECT COUNT(*) as count FROM kunbei_gradient_configs').get() as { count: number };
        if (existingKunbeiConfigs.count === 0) {
            db.exec(`
                INSERT INTO kunbei_gradient_configs (quota_threshold, max_loan_amount, priority)
                VALUES 
                    (2500000, 2500000, 0),     -- 余额$5时，可借$5
                    (50000000, 50000000, 0)    -- 余额$100时，可借$100
            `);
        }

        // 插入默认权重配置方案（仅在表为空时）
        const existingWeightConfigs = db.query('SELECT COUNT(*) as count FROM symbol_weight_configs').get() as { count: number };
        if (existingWeightConfigs.count === 0) {
            const now = Date.now();
            db.exec(`
                INSERT INTO symbol_weight_configs (config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, weight_man, description, is_deleted, created_at, updated_at)
                VALUES 
                    ('默认配置', 100, 100, 100, 100, 100, 100, 100, 100, 25, 25, '平衡的符号分布，适合日常运营', 0, ${now}, ${now}),
                    ('高风险模式', 50, 50, 50, 50, 80, 80, 100, 120, 150, 30, '稀有符号出现概率提升，高风险高回报', 0, ${now}, ${now}),
                    ('低风险模式', 150, 140, 130, 120, 30, 20, 10, 5, 2, 25, '常见符号出现概率提升，降低游戏难度', 0, ${now}, ${now})
            `);
            console.log('✅ 已插入默认权重配置方案');
        }

        // 插入默认奖励配置方案和规则（仅在表为空时）
        const existingRewardSchemes = db.query('SELECT COUNT(*) as count FROM reward_config_schemes').get() as { count: number };
        if (existingRewardSchemes.count === 0) {
            const now = Date.now();
            // 创建初级场标准方案
            db.exec(`
                INSERT INTO reward_config_schemes (scheme_name, description, is_deleted, created_at, updated_at)
                VALUES ('初级场标准', '包含所有基础规则，含双连和惩罚机制', 0, ${now}, ${now})
            `);
            const normalSchemeId = db.query('SELECT last_insert_rowid() as id').get() as { id: number };

            // 为初级场标准方案添加规则
            db.exec(`
                INSERT INTO reward_rules (scheme_id, rule_name, rule_type, rule_category, match_pattern, match_count, required_symbols, win_multiplier, grant_free_spin, priority, is_active, description, created_at, updated_at)
                VALUES
                    (${normalSchemeId.id}, '按顺序jntm', 'super_jackpot', 'special', 'sequence', 4, '["j","n","t","m"]', 256, 0, 100, 1, '鸡你太美按顺序排列', ${now}, ${now}),
                    (${normalSchemeId.id}, '乱序jntm', 'special_combo', 'special', 'combination', 4, '["j","n","t","m"]', 16, 0, 85, 1, '包含鸡你太美全部但不按顺序', ${now}, ${now}),
                    (${normalSchemeId.id}, '四连', 'quad', 'combo', 'any', 4, NULL, 32, 1, 80, 1, '任意相同符号4个', ${now}, ${now}),
                    (${normalSchemeId.id}, '严格3连', 'triple_strict', 'combo', 'consecutive', 3, NULL, 12, 1, 70, 1, '连续3个相同符号', ${now}, ${now}),
                    (${normalSchemeId.id}, '普通3连', 'triple', 'combo', 'any', 3, NULL, 8, 0, 60, 1, '任意位置3个相同符号', ${now}, ${now}),
                    (${normalSchemeId.id}, '两对2连', 'double_pair', 'combo', 'double_pair', 2, NULL, 5, 0, 50, 1, '两对连续的相同符号', ${now}, ${now}),
                    (${normalSchemeId.id}, '严格2连', 'double_strict', 'combo', 'consecutive', 2, NULL, 3, 0, 40, 1, '连续2个相同符号', ${now}, ${now}),
                    (${normalSchemeId.id}, '普通2连', 'double', 'combo', 'any', 2, NULL, 2, 0, 30, 1, '任意位置2个相同符号', ${now}, ${now})
            `);

            // 为初级场标准方案添加律师函惩罚
            db.exec(`
                INSERT INTO punishment_lsh_configs (scheme_id, lsh_count, deduct_multiplier, ban_hours, is_active, created_at, updated_at)
                VALUES
                    (${normalSchemeId.id}, 1, 1, 0, 1, ${now}, ${now}),
                    (${normalSchemeId.id}, 2, 2, 0, 1, ${now}, ${now}),
                    (${normalSchemeId.id}, 3, 3, 60, 1, ${now}, ${now}),
                    (${normalSchemeId.id}, 4, 4, 60, 1, ${now}, ${now})
            `);
            console.log('✅ 已插入默认奖励配置方案');
        }

        // 插入默认至尊场配置
        db.exec(`
            INSERT OR IGNORE INTO supreme_slot_config (
                id, enabled, fragments_to_token, max_tokens_hold, token_valid_hours, session_valid_hours,
                min_bet_amount, max_bet_amount, bet_step, daily_entry_limit, daily_token_grant_limit, daily_bet_limit,
                weight_config_id, reward_scheme_id, updated_at
            )
            VALUES (1, 1, 10, 3, 168, 2, 500000000, 5000000000, 100000000, 3, 1, 50000000000, 1, 1, ${Date.now()})
        `);

        // 🔥 确保至尊场配置存在（修复：如果INSERT OR IGNORE没有插入，则UPDATE）
        db.exec(`
            UPDATE supreme_slot_config 
            SET 
                token_valid_hours = COALESCE(token_valid_hours, 168),
                session_valid_hours = COALESCE(session_valid_hours, 2),
                updated_at = ${Date.now()}
            WHERE id = 1
        `);

        // ========== 插入默认成就数据 ==========
        console.log('📝 插入默认成就数据...');

        const now = Date.now();

        // ✅ 成就奖励梯度设置（美元单位，需要×500000转换为聪）
        // 📌 梯度：common=$100, rare=$200, epic=$500, legendary=$1000, mythic=$2000
        const defaultAchievements = [
            // 新手成就
            { key: 'first_bind', name: '踏入坤圈', desc: '成功绑定公益站账号', category: 'beginner', icon: '🎉', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 1 },
            { key: 'first_game', name: '初来乍到', desc: '完成首次老虎机游戏', category: 'beginner', icon: '🎰', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 2 },
            { key: 'first_win', name: '幸运新手', desc: '首次中奖（任意）', category: 'beginner', icon: '🍀', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 3 },
            { key: 'daily_claim_3', name: '每日打卡', desc: '连续3天领取每日额度', category: 'beginner', icon: '📅', condition_type: 'count', condition_value: JSON.stringify({ target: 3 }), reward: 100 * 500000, rarity: 'common', order: 4 },
            { key: 'first_donate', name: '投喂达人', desc: '首次投喂Keys', category: 'beginner', icon: '🎁', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 5 },
            { key: 'daily_claim_7', name: '每日坚持', desc: '连续7天领取每日额度', category: 'beginner', icon: '⭐', condition_type: 'count', condition_value: JSON.stringify({ target: 7 }), reward: 200 * 500000, rarity: 'rare', order: 6 },

            // 游戏成就
            { key: 'play_10_games', name: '小试牛刀', desc: '游玩10次老虎机', category: 'gaming', icon: '🎮', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 100 * 500000, rarity: 'common', order: 10 },
            { key: 'play_50_games', name: '渐入佳境', desc: '游玩50次老虎机', category: 'gaming', icon: '🎯', condition_type: 'count', condition_value: JSON.stringify({ target: 50 }), reward: 200 * 500000, rarity: 'rare', order: 11 },
            { key: 'play_200_games', name: '老司机', desc: '游玩200次老虎机', category: 'gaming', icon: '🚗', condition_type: 'count', condition_value: JSON.stringify({ target: 200 }), reward: 500 * 500000, rarity: 'epic', order: 12 },
            { key: 'play_1000_games', name: '骨灰玩家', desc: '游玩1000次老虎机', category: 'gaming', icon: '👑', condition_type: 'count', condition_value: JSON.stringify({ target: 1000 }), reward: 1000 * 500000, rarity: 'legendary', order: 13 },
            { key: 'win_10_times', name: '中奖小王子', desc: '累计中奖10次', category: 'gaming', icon: '✨', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 100 * 500000, rarity: 'common', order: 14 },
            { key: 'win_50_times', name: '中奖大师', desc: '累计中奖50次', category: 'gaming', icon: '💎', condition_type: 'count', condition_value: JSON.stringify({ target: 50 }), reward: 200 * 500000, rarity: 'rare', order: 15 },
            { key: 'win_100_times', name: '中奖传说', desc: '累计中奖100次', category: 'gaming', icon: '🌟', condition_type: 'count', condition_value: JSON.stringify({ target: 100 }), reward: 500 * 500000, rarity: 'epic', order: 16 },

            // 中奖成就
            { key: 'double_win', name: '双连达成', desc: '获得双连中奖', category: 'jackpot', icon: '🎁', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 20 },
            { key: 'triple_win', name: '三连达成', desc: '获得三连中奖', category: 'jackpot', icon: '✨', condition_type: 'once', condition_value: '{}', reward: 200 * 500000, rarity: 'rare', order: 21 },
            { key: 'quad_win', name: '四连奇迹', desc: '获得四连中奖', category: 'jackpot', icon: '🎰', condition_type: 'once', condition_value: '{}', reward: 500 * 500000, rarity: 'epic', order: 22 },
            { key: 'special_combo_win', name: '特殊组合', desc: '获得特殊组合（乱序jntm）', category: 'jackpot', icon: '💎', condition_type: 'once', condition_value: '{}', reward: 1000 * 500000, rarity: 'legendary', order: 23 },
            { key: 'super_jackpot_win', name: '超级大奖', desc: '获得超级大奖（256x）', category: 'jackpot', icon: '🏆', condition_type: 'once', condition_value: '{}', reward: 2000 * 500000, rarity: 'mythic', order: 24 },
            { key: 'combo_3_wins', name: '连续中奖', desc: '连续3次中奖', category: 'jackpot', icon: '🔥', condition_type: 'combo', condition_value: JSON.stringify({ count: 3 }), reward: 200 * 500000, rarity: 'rare', order: 25 },
            { key: 'combo_5_wins', name: '连胜王者', desc: '连续5次中奖', category: 'jackpot', icon: '👑', condition_type: 'combo', condition_value: JSON.stringify({ count: 5 }), reward: 500 * 500000, rarity: 'epic', order: 26 },

            // 财富成就
            { key: 'earn_10k', name: '小富即安', desc: '累计盈利$2,000', category: 'wealth', icon: '💰', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'total_earned', threshold: 10000 }), reward: 100 * 500000, rarity: 'common', order: 27 },
            { key: 'earn_100k', name: '财源滚滚', desc: '累计盈利$20,000', category: 'wealth', icon: '💸', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'total_earned', threshold: 100000 }), reward: 200 * 500000, rarity: 'rare', order: 28 },
            { key: 'earn_1m', name: '富甲一方', desc: '累计盈利$2,000,000', category: 'wealth', icon: '💵', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'total_earned', threshold: 1000000 }), reward: 500 * 500000, rarity: 'epic', order: 29 },
            { key: 'balance_50k', name: '土豪本豪', desc: '账户余额达到$10,000,000', category: 'wealth', icon: '👑', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'quota', threshold: 50000 }), reward: 200 * 500000, rarity: 'rare', order: 30 },
            { key: 'single_win_5k', name: '单次暴富', desc: '单次中奖超过$100,000', category: 'wealth', icon: '🎊', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'win_amount', threshold: 5000 }), reward: 500 * 500000, rarity: 'epic', order: 31 },
            { key: 'rank_1_profit', name: '坤圈首富', desc: '登上盈利榜第1名', category: 'wealth', icon: '🏆', condition_type: 'rank', condition_value: JSON.stringify({ rank: 1, type: 'profit' }), reward: 2000 * 500000, rarity: 'mythic', order: 32 },

            // 探索成就
            { key: 'first_advanced', name: '勇闯高级场', desc: '首次进入高级场', category: 'explorer', icon: '🎫', condition_type: 'once', condition_value: '{}', reward: 200 * 500000, rarity: 'rare', order: 40 },
            { key: 'advanced_10_times', name: '高级场常客', desc: '进入高级场10次', category: 'explorer', icon: '🎪', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 200 * 500000, rarity: 'rare', order: 41 },
            { key: 'first_supreme', name: '至尊挑战者', desc: '首次进入至尊场', category: 'explorer', icon: '💎', condition_type: 'once', condition_value: '{}', reward: 500 * 500000, rarity: 'epic', order: 42 },
            { key: 'supreme_10_times', name: '至尊场霸主', desc: '进入至尊场10次', category: 'explorer', icon: '👑', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 1000 * 500000, rarity: 'legendary', order: 43 },
            { key: 'fragment_10', name: '碎片收集者', desc: '累计获得10个碎片', category: 'explorer', icon: '🍀', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 200 * 500000, rarity: 'rare', order: 44 },
            { key: 'ticket_5', name: '入场券大户', desc: '同时持有5张入场券', category: 'explorer', icon: '🎫', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'tickets', threshold: 5 }), reward: 500 * 500000, rarity: 'epic', order: 45 },

            // 社交成就
            { key: 'donate_5_times', name: '慷慨解囊', desc: '投喂5次Keys', category: 'social', icon: '🎁', condition_type: 'count', condition_value: JSON.stringify({ target: 5 }), reward: 200 * 500000, rarity: 'rare', order: 50 },
            { key: 'donate_20_times', name: '大慈善家', desc: '投喂20次Keys', category: 'social', icon: '💝', condition_type: 'count', condition_value: JSON.stringify({ target: 20 }), reward: 500 * 500000, rarity: 'epic', order: 51 },
            { key: 'rank_top10', name: '榜上有名', desc: '进入盈利榜前10', category: 'social', icon: '📊', condition_type: 'rank', condition_value: JSON.stringify({ rank: 10, type: 'profit' }), reward: 200 * 500000, rarity: 'rare', order: 52 },
            { key: 'rank_top3', name: '名扬四海', desc: '进入盈利榜前3', category: 'social', icon: '🌟', condition_type: 'rank', condition_value: JSON.stringify({ rank: 3, type: 'profit' }), reward: 500 * 500000, rarity: 'epic', order: 53 },

            // 挑战成就
            { key: 'daily_profit_10k', name: '赌神之路', desc: '单日盈利超过10,000', category: 'challenge', icon: '🎲', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'daily_profit', threshold: 10000 }), reward: 500 * 500000, rarity: 'epic', order: 60 },
            { key: 'bet_5k_advanced', name: '梭哈大师', desc: '在高级场单次下注5000+', category: 'challenge', icon: '💪', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'bet_amount', threshold: 5000 }), reward: 200 * 500000, rarity: 'rare', order: 61 },
            { key: 'comeback_5k', name: '逆风翻盘', desc: '从-5000盈利回正', category: 'challenge', icon: '🔄', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'comeback', threshold: 5000 }), reward: 500 * 500000, rarity: 'epic', order: 62 },
            { key: 'comeback_10k', name: '惊天逆转', desc: '从-10000盈利回正', category: 'challenge', icon: '🚀', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'comeback', threshold: 10000 }), reward: 1000 * 500000, rarity: 'legendary', order: 63 },
            { key: 'free_game_10', name: '免费之王', desc: '累计获得10次免费游戏', category: 'challenge', icon: '🎰', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 200 * 500000, rarity: 'rare', order: 64 },

            // 收藏成就
            { key: 'symbol_collector', name: '符号学者', desc: '抽出所有9种符号各1次', category: 'collection', icon: '📚', condition_type: 'collection', condition_value: JSON.stringify({ items: ['m', 't', 'n', 'j', 'lq', 'bj', 'zft', 'bdk', 'lsh'] }), reward: 200 * 500000, rarity: 'rare', order: 70 },
            { key: 'combo_master', name: '组合大师', desc: '获得5种不同中奖类型', category: 'collection', icon: '🎯', condition_type: 'collection', condition_value: JSON.stringify({ items: ['double', 'triple', 'quad', 'special', 'super'] }), reward: 500 * 500000, rarity: 'epic', order: 71 },
            { key: 'perfectionist', name: '完美主义者', desc: '完成所有基础成就', category: 'collection', icon: '💯', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'completion_rate', threshold: 80 }), reward: 2000 * 500000, rarity: 'mythic', order: 72 },

            // 坤呗成就
            { key: 'first_kunbei', name: '初次借款', desc: '首次使用坤呗借款', category: 'kunbei', icon: '🏦', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 80 },
            { key: 'repay_5_times', name: '信用良好', desc: '按时还款5次', category: 'kunbei', icon: '✅', condition_type: 'count', condition_value: JSON.stringify({ target: 5 }), reward: 200 * 500000, rarity: 'rare', order: 81 },
            { key: 'credit_100', name: '信用卡神', desc: '信用分达到100', category: 'kunbei', icon: '⭐', condition_type: 'threshold', condition_value: JSON.stringify({ field: 'credit_score', threshold: 100 }), reward: 500 * 500000, rarity: 'epic', order: 82 },
            { key: 'early_repay_3', name: '提前还款', desc: '提前还款3次', category: 'kunbei', icon: '⚡', condition_type: 'count', condition_value: JSON.stringify({ target: 3 }), reward: 200 * 500000, rarity: 'rare', order: 83 },

            // 🔥 特殊符号成就
            { key: 'man_25_times', name: '一个真正的Man', desc: '累计抽到25个Man符号', category: 'special', icon: '💪', condition_type: 'count', condition_value: JSON.stringify({ target: 25 }), reward: 200 * 500000, rarity: 'rare', order: 85 },
            { key: 'idol_trainee', name: '偶像练习生', desc: '按顺序抽到 BJ→ZFT→BDK→LQ', category: 'special', icon: '🎤', condition_type: 'once', condition_value: '{}', reward: 500 * 500000, rarity: 'epic', order: 86 },

            // 惩罚成就（黑色幽默）
            { key: 'first_lsh', name: '收到律师函', desc: '首次抽到律师函', category: 'punishment', icon: '📧', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'common', order: 90 },
            { key: 'lsh_10_times', name: '律师函收割机', desc: '累计抽到10个律师函', category: 'punishment', icon: '⚖️', condition_type: 'count', condition_value: JSON.stringify({ target: 10 }), reward: 200 * 500000, rarity: 'rare', order: 91 },
            { key: 'lsh_quad', name: '满手律师函', desc: '单次抽到4个律师函', category: 'punishment', icon: '😱', condition_type: 'once', condition_value: '{}', reward: 1000 * 500000, rarity: 'legendary', order: 92 },
            { key: 'first_ban', name: '禁赛玩家', desc: '因律师函被禁1次', category: 'punishment', icon: '🚫', condition_type: 'once', condition_value: '{}', reward: 100 * 500000, rarity: 'rare', order: 93 },
            { key: 'rank_1_loss', name: '坤圈首负', desc: '登上亏损榜第1名', category: 'punishment', icon: '😭', condition_type: 'rank', condition_value: JSON.stringify({ rank: 1, type: 'loss' }), reward: 500 * 500000, rarity: 'epic', order: 94 },
            { key: 'kunbei_overdue', name: '逾期达人', desc: '坤呗逾期1次', category: 'punishment', icon: '⏰', condition_type: 'once', condition_value: '{}', reward: 0, rarity: 'common', order: 95 }
        ];

        // 插入或更新成就数据（使用INSERT OR REPLACE确保奖励额度会更新）
        for (const ach of defaultAchievements) {
            try {
                db.exec(`
                    INSERT OR REPLACE INTO achievements (
                        achievement_key, achievement_name, achievement_desc, category, icon,
                        condition_type, condition_value, reward_quota, rarity, display_order,
                        is_hidden, is_active, created_at, updated_at
                    ) VALUES (
                        '${ach.key}', '${ach.name}', '${ach.desc}', '${ach.category}', '${ach.icon}',
                        '${ach.condition_type}', '${ach.condition_value}', ${ach.reward}, '${ach.rarity}', ${ach.order},
                        0, 1, 
                        COALESCE((SELECT created_at FROM achievements WHERE achievement_key = '${ach.key}'), ${now}),
                        ${now}
                    )
                `);
            } catch (error: any) {
                console.error(`插入/更新成就 ${ach.key} 失败:`, error.message);
            }
        }

        console.log(`✅ 已插入 ${defaultAchievements.length} 个默认成就`);

        console.log('✅ 默认数据插入完成（含配置方案、至尊场和成就系统）');
    } catch (error) {
        console.error('❌ 插入默认数据失败:', error);
        throw error; // 重新抛出错误，让调用者处理
    }
}

// ========== 预编译查询语句（性能优化） ==========

// 声明查询对象（延迟初始化）
export let userQueries: any;
export let claimQueries: any;
export let donateQueries: any;
export let keyQueries: any;
export let sessionQueries: any;
export let adminQueries: any;
export let slotQueries: any;
export let pendingRewardQueries: any;
export let advancedSlotQueries: any;  // 高级场查询
export let kunbeiQueries: any;  // 坤呗借款查询
export let weightConfigQueries: any;  // 权重配置查询
export let rewardConfigQueries: any;  // 奖励配置查询
export let supremeSlotQueries: any;  // 至尊场查询
export let dropConfigQueries: any;  // 掉落配置查询
export let achievementQueries: any;  // 成就系统查询
export let rateLimitBanQueries: any;  // 速率限制封禁记录查询

/**
 * 初始化预编译查询语句
 * 必须在数据库表创建后调用
 */
function initQueries() {
    // 用户相关
    userQueries = {
        get: db.query<User, string>('SELECT * FROM users WHERE linux_do_id = ?'),
        getByUsername: db.query<User, string>('SELECT * FROM users WHERE username = ?'),
        getByLinuxDoUsername: db.query<User, string>('SELECT * FROM users WHERE linux_do_username = ?'),
        searchByUsername: db.query<User, string>(
            'SELECT * FROM users WHERE username LIKE ? OR linux_do_username LIKE ? LIMIT 50'
        ),
        insert: db.query(
            'INSERT INTO users (linux_do_id, username, linux_do_username, kyx_user_id, created_at) VALUES (?, ?, ?, ?, ?)'
        ),
        update: db.query(
            'UPDATE users SET username = ?, linux_do_username = ?, kyx_user_id = ? WHERE linux_do_id = ?'
        ),
        getAll: db.query<User, never>('SELECT * FROM users'),
        // 🚀 优化：使用 JOIN 聚合获取用户统计（替代内存中过滤）
        getAllWithStats: db.query<any, [number, number]>(`
            SELECT
                u.*,
                COALESCE(c.claim_count, 0) as claim_count,
                COALESCE(c.total_claim_quota, 0) as total_claim_quota,
                COALESCE(d.donate_count, 0) as donate_count,
                COALESCE(d.total_donate_quota, 0) as total_donate_quota
            FROM users u
            LEFT JOIN (
                SELECT linux_do_id,
                       COUNT(*) as claim_count,
                       SUM(quota_added) as total_claim_quota
                FROM claim_records
                GROUP BY linux_do_id
            ) c ON u.linux_do_id = c.linux_do_id
            LEFT JOIN (
                SELECT linux_do_id,
                       SUM(keys_count) as donate_count,
                       SUM(total_quota_added) as total_donate_quota
                FROM donate_records
                GROUP BY linux_do_id
            ) d ON u.linux_do_id = d.linux_do_id
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：搜索用户（支持用户名和LinuxDo用户名）
        searchWithStats: db.query<any, [string, string, number, number]>(`
            SELECT
                u.*,
                COALESCE(c.claim_count, 0) as claim_count,
                COALESCE(c.total_claim_quota, 0) as total_claim_quota,
                COALESCE(d.donate_count, 0) as donate_count,
                COALESCE(d.total_donate_quota, 0) as total_donate_quota
            FROM users u
            LEFT JOIN (
                SELECT linux_do_id,
                       COUNT(*) as claim_count,
                       SUM(quota_added) as total_claim_quota
                FROM claim_records
                GROUP BY linux_do_id
            ) c ON u.linux_do_id = c.linux_do_id
            LEFT JOIN (
                SELECT linux_do_id,
                       SUM(keys_count) as donate_count,
                       SUM(total_quota_added) as total_donate_quota
                FROM donate_records
                GROUP BY linux_do_id
            ) d ON u.linux_do_id = d.linux_do_id
            WHERE u.username LIKE ? OR u.linux_do_username LIKE ?
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：统计搜索结果数量
        countSearch: db.query<{ count: number }, [string, string]>(`
            SELECT COUNT(*) as count FROM users
            WHERE username LIKE ? OR linux_do_username LIKE ?
        `),
        // 🚀 优化：获取用户总数（用于分页）
        count: db.query<{ count: number }, never>('SELECT COUNT(*) as count FROM users'),
        getAllLinuxDoIds: db.query<{ linux_do_id: string }, never>('SELECT linux_do_id FROM users WHERE is_banned = 0'),
        getBannedUsers: db.query<User, never>('SELECT * FROM users WHERE is_banned = 1 ORDER BY banned_at DESC'),
        ban: db.query(
            'UPDATE users SET is_banned = 1, banned_at = ?, banned_reason = ? WHERE linux_do_id = ?'
        ),
        unban: db.query(
            'UPDATE users SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE linux_do_id = ?'
        ),
        delete: db.query(
            'DELETE FROM users WHERE linux_do_id = ?'
        ),
        // 连击计数器（用于连续中奖成就）
        updateWinStreak: db.query(
            'UPDATE users SET win_streak = ? WHERE linux_do_id = ?'
        ),
        getWinStreak: db.query<{ win_streak: number }, string>(
            'SELECT win_streak FROM users WHERE linux_do_id = ?'
        ),
    };

    // 领取记录相关
    claimQueries = {
        getToday: db.query<ClaimRecord, [string, string]>(
            'SELECT * FROM claim_records WHERE linux_do_id = ? AND date = ?'
        ),
        insert: db.query(
            'INSERT INTO claim_records (linux_do_id, username, quota_added, timestamp, date) VALUES (?, ?, ?, ?, ?)'
        ),
        getByUser: db.query<ClaimRecord, string>(
            'SELECT * FROM claim_records WHERE linux_do_id = ? ORDER BY timestamp DESC'
        ),
        getAll: db.query<ClaimRecord, never>(
            'SELECT * FROM claim_records ORDER BY timestamp DESC'
        ),
        getAllPaginated: db.query<ClaimRecord, [number, number]>(
            'SELECT * FROM claim_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        count: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM claim_records'
        ),
    };

    // 投喂记录相关
    donateQueries = {
        insert: db.query(
            'INSERT INTO donate_records (linux_do_id, username, keys_count, total_quota_added, timestamp, push_status, push_message, failed_keys, key_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getByUser: db.query<DonateRecord, string>(
            'SELECT * FROM donate_records WHERE linux_do_id = ? ORDER BY timestamp DESC'
        ),
        getAll: db.query<DonateRecord, never>(
            'SELECT * FROM donate_records ORDER BY timestamp DESC'
        ),
        getAllPaginated: db.query<DonateRecord, [number, number]>(
            'SELECT * FROM donate_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        count: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM donate_records'
        ),
        getTodayCount: db.query<{ total: number }, [string, number, number]>(
            'SELECT COALESCE(SUM(keys_count), 0) as total FROM donate_records WHERE linux_do_id = ? AND timestamp >= ? AND timestamp < ?'
        ),
        getTodayCountByType: db.query<{ total: number }, [string, number, number, string]>(
            'SELECT COALESCE(SUM(keys_count), 0) as total FROM donate_records WHERE linux_do_id = ? AND timestamp >= ? AND timestamp < ? AND key_type = ?'
        ),
        getByTimestamp: db.query<DonateRecord, [string, number]>(
            'SELECT * FROM donate_records WHERE linux_do_id = ? AND timestamp = ?'
        ),
        update: db.query(
            'UPDATE donate_records SET push_status = ?, push_message = ?, failed_keys = ? WHERE linux_do_id = ? AND timestamp = ?'
        ),
    };

    // 已使用的 Key 相关
    keyQueries = {
        isUsed: db.query<{ count: number }, [string, string]>(
            'SELECT COUNT(*) as count FROM used_keys WHERE key = ? AND key_type = ?'
        ),
        insert: db.query(
            'INSERT INTO used_keys (key, linux_do_id, username, timestamp, key_type) VALUES (?, ?, ?, ?, ?)'
        ),
        getAll: db.query<
            { key: string; linux_do_id: string; username: string; timestamp: number; key_type: string },
            never
        >('SELECT * FROM used_keys ORDER BY timestamp DESC'),
        delete: db.query('DELETE FROM used_keys WHERE key = ? AND key_type = ?'),
    };

    // Session 相关
    sessionQueries = {
        get: db.query<{ data: string }, [string, number]>(
            'SELECT data FROM sessions WHERE id = ? AND expires_at > ?'
        ),
        set: db.query(
            'INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)'
        ),
        delete: db.query('DELETE FROM sessions WHERE id = ?'),
        cleanup: db.query('DELETE FROM sessions WHERE expires_at < ?'),
    };

    // 管理员配置相关
    adminQueries = {
        get: db.query<AdminConfig, never>('SELECT * FROM admin_config WHERE id = 1'),
        update: db.query(
            'UPDATE admin_config SET session = ?, new_api_user = ?, claim_quota = ?, max_daily_claims = ?, keys_api_url = ?, keys_authorization = ?, modelscope_group_id = ?, iflow_group_id = ?, max_daily_donate_modelscope = ?, max_daily_donate_iflow = ?, updated_at = ? WHERE id = 1'
        ),
        // 独立更新钱包配置（避免动到其它字段）
        updateWallet: db.query(
            'UPDATE admin_config SET wallet_exchange_rate = ?, wallet_daily_transfer_limit_count = ?, wallet_initial_egg = ?, updated_at = ? WHERE id = 1'
        ),
    };

    // 老虎机相关
    slotQueries = {
        // 配置
        getConfig: db.query<SlotMachineConfig, never>(
            'SELECT * FROM slot_machine_config WHERE id = 1'
        ),
        updateConfig: db.query(
            'UPDATE slot_machine_config SET bet_amount = ?, max_daily_spins = ?, min_quota_required = ?, enabled = ?, background_type = ?, buy_spins_enabled = ?, buy_spins_price = ?, max_daily_buy_spins = ?, updated_at = ? WHERE id = 1'
        ),

        // 符号权重配置
        getWeights: db.query<any, never>(
            'SELECT * FROM slot_symbol_weights WHERE id = 1'
        ),
        updateWeights: db.query(
            'UPDATE slot_symbol_weights SET weight_m = ?, weight_t = ?, weight_n = ?, weight_j = ?, weight_lq = ?, weight_bj = ?, weight_zft = ?, weight_bdk = ?, weight_lsh = ?, updated_at = ? WHERE id = 1'
        ),

        // 奖励倍数配置
        getMultipliers: db.query<any, never>(
            'SELECT * FROM slot_reward_multipliers WHERE id = 1'
        ),
        updateMultipliers: db.query(
            'UPDATE slot_reward_multipliers SET super_jackpot_multiplier = ?, special_combo_multiplier = ?, quad_multiplier = ?, triple_multiplier = ?, double_multiplier = ?, updated_at = ? WHERE id = 1'
        ),

        // 游戏记录
        insertRecord: db.query(
            'INSERT INTO slot_machine_records (linux_do_id, username, linux_do_username, bet_amount, result_symbols, win_type, win_multiplier, win_amount, free_spin_awarded, is_free_spin, slot_mode, rule_name, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getRecordsByUser: db.query<SlotMachineRecord, string>(
            'SELECT * FROM slot_machine_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getRecordsByUserAndMode: db.query<SlotMachineRecord, [string, string]>(
            'SELECT * FROM slot_machine_records WHERE linux_do_id = ? AND slot_mode = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllRecords: db.query<SlotMachineRecord, never>(
            'SELECT * FROM slot_machine_records ORDER BY timestamp DESC'
        ),
        getAllRecordsPaginated: db.query<SlotMachineRecord, [number, number]>(
            'SELECT * FROM slot_machine_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        getNormalRecordsPaginated: db.query<SlotMachineRecord, [number, number]>(
            'SELECT * FROM slot_machine_records WHERE slot_mode = "normal" OR slot_mode IS NULL ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        // 🚀 优化：按用户筛选初级场记录（支持分页）
        getNormalRecordsByUserPaginated: db.query<SlotMachineRecord, [string, string, string, number, number]>(`
            SELECT * FROM slot_machine_records
            WHERE (slot_mode = "normal" OR slot_mode IS NULL)
            AND (linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?)
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：按用户筛选初级场记录总数
        countNormalRecordsByUser: db.query<{ count: number }, [string, string, string]>(`
            SELECT COUNT(*) as count FROM slot_machine_records
            WHERE (slot_mode = "normal" OR slot_mode IS NULL)
            AND (linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?)
        `),
        countRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM slot_machine_records'
        ),
        countNormalRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM slot_machine_records WHERE slot_mode = "normal" OR slot_mode IS NULL'
        ),
        // 🚀 优化：高级场记录分页
        getAdvancedRecordsPaginated: db.query<SlotMachineRecord, [number, number]>(
            'SELECT * FROM slot_machine_records WHERE slot_mode = "advanced" ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        // 🚀 优化：按用户筛选高级场记录
        getAdvancedRecordsByUserPaginated: db.query<SlotMachineRecord, [string, string, string, number, number]>(`
            SELECT * FROM slot_machine_records
            WHERE slot_mode = "advanced"
            AND (linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?)
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：高级场记录总数
        countAdvancedRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM slot_machine_records WHERE slot_mode = "advanced"'
        ),
        // 🚀 优化：按用户筛选高级场记录总数
        countAdvancedRecordsByUser: db.query<{ count: number }, [string, string, string]>(`
            SELECT COUNT(*) as count FROM slot_machine_records
            WHERE slot_mode = "advanced"
            AND (linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?)
        `),
        getTodaySpins: db.query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) as count FROM slot_machine_records WHERE linux_do_id = ? AND date = ? AND is_free_spin = 0 AND (slot_mode = 'normal' OR slot_mode IS NULL)"
        ),
        getTodayStats: db.query<{ total_bet: number; total_win: number; count: number }, [string, string]>(
            "SELECT COALESCE(SUM(bet_amount), 0) as total_bet, COALESCE(SUM(win_amount), 0) as total_win, COUNT(*) as count FROM slot_machine_records WHERE linux_do_id = ? AND date = ? AND (slot_mode = 'normal' OR slot_mode IS NULL)"
        ),
        // 获取今日高级场投注总额
        getAdvancedTodayBet: db.query<{ total_bet: number }, [string, string]>(
            "SELECT COALESCE(SUM(bet_amount), 0) as total_bet FROM slot_machine_records WHERE linux_do_id = ? AND date = ? AND slot_mode = 'advanced'"
        ),

        // 免费次数
        getFreeSpin: db.query<UserFreeSpin, string>(
            'SELECT * FROM user_free_spins WHERE linux_do_id = ?'
        ),
        getAllFreeSpin: db.query<UserFreeSpin, never>(
            'SELECT * FROM user_free_spins'
        ),
        setFreeSpin: db.query(
            'INSERT OR REPLACE INTO user_free_spins (linux_do_id, free_spins, banned_until, updated_at) VALUES (?, ?, ?, ?)'
        ),
        incrementFreeSpin: db.query(
            'INSERT INTO user_free_spins (linux_do_id, free_spins, updated_at) VALUES (?, 1, ?) ON CONFLICT(linux_do_id) DO UPDATE SET free_spins = free_spins + 1, updated_at = ?'
        ),
        decrementFreeSpin: db.query(
            'UPDATE user_free_spins SET free_spins = free_spins - 1, updated_at = ? WHERE linux_do_id = ? AND free_spins > 0'
        ),
        setBannedUntil: db.query(
            'INSERT INTO user_free_spins (linux_do_id, free_spins, banned_at, banned_until, ban_slot_mode, ban_hours, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?) ON CONFLICT(linux_do_id) DO UPDATE SET banned_at = ?, banned_until = ?, ban_slot_mode = ?, ban_hours = ?, updated_at = ?'
        ),

        // 用户统计
        getUserStats: db.query<any, string>(
            'SELECT * FROM user_slot_stats WHERE linux_do_id = ?'
        ),
        updateUserStats: db.query(
            'INSERT OR REPLACE INTO user_slot_stats (linux_do_id, username, avatar_url, total_spins, total_bet, total_win, biggest_win, biggest_win_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getLeaderboard: db.query<any, number>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE (s.total_win - s.total_bet) >= 0
            ORDER BY (s.total_win - s.total_bet) DESC 
            LIMIT ?`
        ),
        getLossLeaderboard: db.query<any, number>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE (s.total_win - s.total_bet) < 0
            ORDER BY (s.total_win - s.total_bet) ASC 
            LIMIT ?`
        ),
        getUserRank: db.query<{ rank: number }, string>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_stats WHERE (total_win - total_bet) > (SELECT (total_win - total_bet) FROM user_slot_stats WHERE linux_do_id = ?)'
        ),
        getUserLossRank: db.query<{ rank: number }, string>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_stats WHERE (total_win - total_bet) < (SELECT (total_win - total_bet) FROM user_slot_stats WHERE linux_do_id = ?)'
        ),

        // 日榜相关
        updateDailyStats: db.query(
            `INSERT INTO user_slot_daily_stats (linux_do_id, username, avatar_url, date, total_spins, total_bet, total_win, biggest_win, biggest_win_type, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, date) DO UPDATE SET
                username = excluded.username,
                avatar_url = excluded.avatar_url,
                total_spins = excluded.total_spins,
                total_bet = excluded.total_bet,
                total_win = excluded.total_win,
                biggest_win = excluded.biggest_win,
                biggest_win_type = excluded.biggest_win_type,
                updated_at = excluded.updated_at`
        ),
        getDailyLeaderboard: db.query<any, [string, number]>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_daily_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE s.date = ? AND (s.total_win - s.total_bet) >= 0
            ORDER BY (s.total_win - s.total_bet) DESC 
            LIMIT ?`
        ),
        getDailyLossLeaderboard: db.query<any, [string, number]>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_daily_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE s.date = ? AND (s.total_win - s.total_bet) < 0
            ORDER BY (s.total_win - s.total_bet) ASC 
            LIMIT ?`
        ),
        getUserDailyRank: db.query<{ rank: number }, [string, string]>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_daily_stats WHERE date = ? AND (total_win - total_bet) > (SELECT (total_win - total_bet) FROM user_slot_daily_stats WHERE linux_do_id = ? AND date = ?)'
        ),
        getUserDailyLossRank: db.query<{ rank: number }, [string, string]>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_daily_stats WHERE date = ? AND (total_win - total_bet) < (SELECT (total_win - total_bet) FROM user_slot_daily_stats WHERE linux_do_id = ? AND date = ?)'
        ),
        getUserDailyStats: db.query<any, [string, string]>(
            'SELECT * FROM user_slot_daily_stats WHERE linux_do_id = ? AND date = ?'
        ),
        cleanOldDailyStats: db.query<void, string>(
            'DELETE FROM user_slot_daily_stats WHERE date < ?'
        ),

        // 周榜相关
        updateWeeklyStats: db.query(
            `INSERT INTO user_slot_weekly_stats (linux_do_id, username, avatar_url, week_start, total_spins, total_bet, total_win, biggest_win, biggest_win_type, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, week_start) DO UPDATE SET
                username = excluded.username,
                avatar_url = excluded.avatar_url,
                total_spins = excluded.total_spins,
                total_bet = excluded.total_bet,
                total_win = excluded.total_win,
                biggest_win = excluded.biggest_win,
                biggest_win_type = excluded.biggest_win_type,
                updated_at = excluded.updated_at`
        ),
        getWeeklyLeaderboard: db.query<any, [string, number]>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_weekly_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE s.week_start = ? AND (s.total_win - s.total_bet) >= 0
            ORDER BY (s.total_win - s.total_bet) DESC 
            LIMIT ?`
        ),
        getWeeklyLossLeaderboard: db.query<any, [string, number]>(
            `SELECT 
                s.linux_do_id, 
                COALESCE(u.linux_do_username, s.username, u.username) as username,
                s.avatar_url, 
                s.total_spins, 
                s.total_bet, 
                s.total_win, 
                s.biggest_win, 
                s.biggest_win_type,
                (s.total_win - s.total_bet) as profit
            FROM user_slot_weekly_stats s
            LEFT JOIN users u ON s.linux_do_id = u.linux_do_id
            WHERE s.week_start = ? AND (s.total_win - s.total_bet) < 0
            ORDER BY (s.total_win - s.total_bet) ASC 
            LIMIT ?`
        ),
        getUserWeeklyRank: db.query<{ rank: number }, [string, string]>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_weekly_stats WHERE week_start = ? AND (total_win - total_bet) > (SELECT (total_win - total_bet) FROM user_slot_weekly_stats WHERE linux_do_id = ? AND week_start = ?)'
        ),
        getUserWeeklyLossRank: db.query<{ rank: number }, [string, string]>(
            'SELECT COUNT(*) + 1 as rank FROM user_slot_weekly_stats WHERE week_start = ? AND (total_win - total_bet) < (SELECT (total_win - total_bet) FROM user_slot_weekly_stats WHERE linux_do_id = ? AND week_start = ?)'
        ),
        getUserWeeklyStats: db.query<any, [string, string]>(
            'SELECT * FROM user_slot_weekly_stats WHERE linux_do_id = ? AND week_start = ?'
        ),
        cleanOldWeeklyStats: db.query<void, string>(
            'DELETE FROM user_slot_weekly_stats WHERE week_start < ?'
        ),

        // 购买次数记录
        insertBuySpinsRecord: db.query<void, [string, string, string | null, number, number, number, string]>(
            'INSERT INTO buy_spins_records (linux_do_id, username, linux_do_username, spins_count, price_paid, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ),
        getTodayBuySpinsCount: db.query<{ total: number }, [string, string]>(
            'SELECT COALESCE(SUM(spins_count), 0) as total FROM buy_spins_records WHERE linux_do_id = ? AND date = ?'
        ),
        getBuySpinsRecordsByUser: db.query<any, string>(
            'SELECT * FROM buy_spins_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllBuySpinsRecords: db.query<any, never>(
            'SELECT * FROM buy_spins_records ORDER BY timestamp DESC'
        ),
    };

    // 待发放奖金相关
    pendingRewardQueries = {
        // 插入新的待发放奖金
        insert: db.query(
            'INSERT INTO pending_rewards (linux_do_id, kyx_user_id, username, reward_amount, reason, status, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        // 获取待发放的奖金（status = pending 或 failed）
        getPending: db.query<any, never>(
            "SELECT * FROM pending_rewards WHERE status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT 50"
        ),
        // 获取所有奖金记录（包括成功的，用于管理后台查看）
        getAll: db.query<any, never>(
            "SELECT * FROM pending_rewards ORDER BY created_at DESC LIMIT 200"
        ),
        // 获取用户的待发放奖金
        getByUser: db.query<any, string>(
            "SELECT * FROM pending_rewards WHERE linux_do_id = ? ORDER BY created_at DESC"
        ),
        // 获取用户的待发放奖金数量和总金额
        getUserPendingSummary: db.query<{ count: number; total_amount: number }, string>(
            "SELECT COUNT(*) as count, COALESCE(SUM(reward_amount), 0) as total_amount FROM pending_rewards WHERE linux_do_id = ? AND status IN ('pending', 'processing', 'failed')"
        ),
        // 更新奖金状态
        updateStatus: db.query(
            'UPDATE pending_rewards SET status = ?, updated_at = ?, error_message = ? WHERE id = ?'
        ),
        // 更新为成功
        markSuccess: db.query(
            'UPDATE pending_rewards SET status = ?, processed_at = ?, updated_at = ? WHERE id = ?'
        ),
        // 增加重试次数
        incrementRetry: db.query(
            'UPDATE pending_rewards SET retry_count = retry_count + 1, status = ?, error_message = ?, updated_at = ? WHERE id = ?'
        ),
        // 获取单条记录
        getById: db.query<any, number>(
            'SELECT * FROM pending_rewards WHERE id = ?'
        ),
    };

    // ========== 高级场系统查询 ==========
    advancedSlotQueries = {
        // 入场券和碎片管理
        getTickets: db.query<UserTickets, string>(
            'SELECT * FROM user_tickets WHERE linux_do_id = ?'
        ),
        upsertTickets: db.query(
            `INSERT INTO user_tickets (linux_do_id, tickets, fragments, tickets_expires_at, advanced_mode_until, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tickets = excluded.tickets,
             fragments = excluded.fragments,
             tickets_expires_at = excluded.tickets_expires_at,
             advanced_mode_until = excluded.advanced_mode_until,
             updated_at = excluded.updated_at`
        ),
        addTickets: db.query(
            `INSERT INTO user_tickets (linux_do_id, tickets, tickets_expires_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tickets = MIN(tickets + ?, ?),
             tickets_expires_at = ?,
             updated_at = ?`
        ),
        addFragments: db.query(
            `INSERT INTO user_tickets (linux_do_id, fragments, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             fragments = fragments + ?,
             updated_at = ?`
        ),
        useTicket: db.query(
            `UPDATE user_tickets SET 
             tickets = tickets - 1,
             advanced_mode_until = ?,
             updated_at = ?
             WHERE linux_do_id = ? AND tickets > 0`
        ),
        clearExpiredTickets: db.query(
            `UPDATE user_tickets 
             SET tickets = 0, tickets_expires_at = NULL, updated_at = ?
             WHERE linux_do_id = ? AND tickets_expires_at < ?`
        ),
        exitAdvancedMode: db.query(
            `UPDATE user_tickets
             SET advanced_mode_until = NULL, updated_at = ?
             WHERE linux_do_id = ?`
        ),

        // 高级场配置
        getAdvancedConfig: db.query<AdvancedSlotConfig, never>(
            'SELECT * FROM advanced_slot_config WHERE id = 1'
        ),
        updateAdvancedConfig: db.query(
            `UPDATE advanced_slot_config SET
             enabled = ?,
             bet_min = ?,
             bet_max = ?,
             reward_multiplier = ?,
             penalty_weight_factor = ?,
             rtp_target = ?,
             ticket_valid_hours = ?,
             session_valid_hours = ?,
             fragments_needed = ?,
             drop_rate_triple = ?,
             drop_rate_double = ?,
             max_tickets_hold = ?,
             daily_bet_limit = ?,
             daily_entry_limit = ?,
             daily_ticket_grant_limit = ?,
             updated_at = ?
             WHERE id = 1`
        ),

        // 入场券掉落记录
        insertDropRecord: db.query(
            'INSERT INTO ticket_drop_records (linux_do_id, username, drop_type, drop_count, trigger_win_type, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ),
        getDropRecordsByUser: db.query<TicketDropRecord, string>(
            'SELECT * FROM ticket_drop_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllDropRecords: db.query<TicketDropRecord, never>(
            'SELECT * FROM ticket_drop_records ORDER BY timestamp DESC LIMIT 200'
        ),

        // RTP 统计
        getRTPStats: db.query<AdvancedSlotRTPStats, string>(
            'SELECT * FROM advanced_slot_rtp_stats WHERE linux_do_id = ?'
        ),
        updateRTPStats: db.query(
            `INSERT INTO advanced_slot_rtp_stats (linux_do_id, total_bet, total_win, rtp, games_count, last_updated)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             total_bet = total_bet + ?,
             total_win = total_win + ?,
             rtp = CAST(total_win AS REAL) / CAST(total_bet AS REAL),
             games_count = games_count + 1,
             last_updated = ?`
        ),
        getAllRTPStats: db.query<AdvancedSlotRTPStats, never>(
            'SELECT * FROM advanced_slot_rtp_stats ORDER BY games_count DESC LIMIT 100'
        ),

        // 高级场符号权重
        getAdvancedWeights: db.query<any, never>(
            'SELECT * FROM advanced_slot_symbol_weights WHERE id = 1'
        ),
        updateAdvancedWeights: db.query(
            'UPDATE advanced_slot_symbol_weights SET weight_m = ?, weight_t = ?, weight_n = ?, weight_j = ?, weight_lq = ?, weight_bj = ?, weight_zft = ?, weight_bdk = ?, weight_lsh = ?, updated_at = ? WHERE id = 1'
        ),

        // 用户每日进入高级场记录
        getTodayEntry: db.query<UserAdvancedEntry, [string, string]>(
            'SELECT * FROM user_advanced_entries WHERE linux_do_id = ? AND entry_date = ?'
        ),
        updateTodayEntry: db.query(
            `INSERT INTO user_advanced_entries (linux_do_id, entry_date, entry_count, last_entry_time)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(linux_do_id, entry_date) DO UPDATE SET
             entry_count = entry_count + 1,
             last_entry_time = ?`
        ),

        // 用户每日入场券获得记录
        getTodayGrant: db.query<UserDailyTicketGrant, [string, string]>(
            'SELECT * FROM user_daily_ticket_grants WHERE linux_do_id = ? AND grant_date = ?'
        ),
        updateTodayTicketGrant: db.query(
            `INSERT INTO user_daily_ticket_grants (linux_do_id, grant_date, ticket_granted, fragment_granted, last_grant_time)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, grant_date) DO UPDATE SET
             ticket_granted = ticket_granted + ?,
             fragment_granted = fragment_granted + ?,
             last_grant_time = ?`
        ),
    };

    // ========== 坤呗借款系统查询 ==========
    kunbeiQueries = {
        // 配置管理
        getConfig: db.query<KunbeiConfig, never>(
            'SELECT * FROM kunbei_config WHERE id = 1'
        ),
        updateConfig: db.query(
            `UPDATE kunbei_config SET 
             enabled = ?, max_loan_amount = ?, min_loan_amount = ?,
             repay_multiplier = ?, loan_duration_hours = ?, early_repay_discount = ?,
             overdue_penalty_hours = ?, overdue_ban_advanced = ?, max_active_loans = ?,
             deduct_all_quota_on_overdue = ?, overdue_deduct_multiplier = ?, max_daily_borrows = ?, updated_at = ? WHERE id = 1`
        ),

        // 借款记录管理
        getActiveLoan: db.query<UserLoan, string>(
            'SELECT * FROM user_loans WHERE linux_do_id = ? AND status = "active" LIMIT 1'
        ),
        getLoanById: db.query<UserLoan, number>(
            'SELECT * FROM user_loans WHERE id = ?'
        ),
        getUserLoans: db.query<UserLoan, string>(
            'SELECT * FROM user_loans WHERE linux_do_id = ? ORDER BY created_at DESC LIMIT 20'
        ),
        getAllLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans ORDER BY created_at DESC LIMIT 200'
        ),
        getActiveLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans WHERE status = "active"'
        ),
        getOverdueLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans WHERE status = "overdue"'
        ),
        getTodayBorrowCount: db.query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) as count FROM user_loans 
             WHERE linux_do_id = ? AND DATE(borrowed_at / 1000, 'unixepoch') = ?`
        ),
        insertLoan: db.query(
            `INSERT INTO user_loans (linux_do_id, username, loan_amount, repay_amount, status, borrowed_at, due_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        updateLoanStatus: db.query(
            `UPDATE user_loans SET status = ?, actual_repay_amount = ?, repaid_at = ?, overdue_penalty_until = ?, updated_at = ?
             WHERE id = ?`
        ),
        updateLoanOverdue: db.query(
            `UPDATE user_loans SET status = ?, overdue_penalty_until = ?, auto_deducted_amount = ?, balance_after_deduct = ?, updated_at = ?
             WHERE id = ?`
        ),
        clearOverduePenalty: db.query(
            `UPDATE user_loans SET overdue_penalty_until = NULL, updated_at = ?
             WHERE id = ?`
        ),
        deleteLoan: db.query(
            'DELETE FROM user_loans WHERE id = ?'
        ),

        // 用户统计管理
        getStats: db.query<UserKunbeiStats, string>(
            'SELECT * FROM user_kunbei_stats WHERE linux_do_id = ?'
        ),
        upsertStats: db.query(
            `INSERT INTO user_kunbei_stats (linux_do_id, total_borrowed, total_repaid, total_loans, repaid_loans, overdue_loans, credit_score, is_banned, last_borrow_date, has_daily_buff, buff_multiplier, buff_used, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             total_borrowed = total_borrowed + ?,
             total_repaid = total_repaid + ?,
             total_loans = total_loans + ?,
             repaid_loans = repaid_loans + ?,
             overdue_loans = overdue_loans + ?,
             credit_score = ?,
             last_borrow_date = ?,
             has_daily_buff = ?,
             buff_multiplier = ?,
             buff_used = ?,
             updated_at = ?`
        ),
        updateCreditScore: db.query(
            `INSERT INTO user_kunbei_stats (linux_do_id, credit_score, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             credit_score = MAX(0, MIN(100, credit_score + ?)),
             updated_at = ?`
        ),

        // Buff相关查询
        checkBuff: db.query<UserKunbeiStats, string>(
            'SELECT * FROM user_kunbei_stats WHERE linux_do_id = ? AND has_daily_buff = 1 AND buff_used = 0'
        ),
        useBuff: db.query(
            'UPDATE user_kunbei_stats SET buff_used = 1, updated_at = ? WHERE linux_do_id = ?'
        ),

        // 梯度配置相关查询
        getGradientConfigs: db.query<KunbeiGradientConfig, never>(
            'SELECT * FROM kunbei_gradient_configs WHERE is_active = 1 ORDER BY quota_threshold ASC'
        ),
        getGradientConfigById: db.query<KunbeiGradientConfig, number>(
            'SELECT * FROM kunbei_gradient_configs WHERE id = ?'
        ),
        getAllGradientConfigs: db.query<KunbeiGradientConfig, never>(
            'SELECT * FROM kunbei_gradient_configs ORDER BY quota_threshold ASC'
        ),
        insertGradientConfig: db.query(
            `INSERT INTO kunbei_gradient_configs (quota_threshold, max_loan_amount, priority, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ),
        updateGradientConfig: db.query(
            `UPDATE kunbei_gradient_configs 
             SET quota_threshold = ?, max_loan_amount = ?, priority = ?, is_active = ?, updated_at = ?
             WHERE id = ?`
        ),
        deleteGradientConfig: db.query(
            'DELETE FROM kunbei_gradient_configs WHERE id = ?'
        ),
    };

    // ========== 权重配置方案查询 ==========
    weightConfigQueries = {
        getAll: db.query<any, never>(
            'SELECT * FROM symbol_weight_configs WHERE is_deleted = 0 ORDER BY id ASC'
        ),
        getById: db.query<any, number>(
            'SELECT * FROM symbol_weight_configs WHERE id = ?'
        ),
        getUsageInfo: db.query<any, number>(`
            SELECT 
                (SELECT COUNT(*) FROM slot_machine_config WHERE weight_config_id = ?) +
                (SELECT COUNT(*) FROM advanced_slot_config WHERE weight_config_id = ?) +
                (SELECT COUNT(*) FROM supreme_slot_config WHERE weight_config_id = ?) as usage_count
        `),
        insert: db.query(
            `INSERT INTO symbol_weight_configs (config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, weight_man, description, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ),
        update: db.query(
            `UPDATE symbol_weight_configs SET
             config_name = ?, weight_m = ?, weight_t = ?, weight_n = ?, weight_j = ?, weight_lq = ?, weight_bj = ?, weight_zft = ?, weight_bdk = ?, weight_lsh = ?, weight_man = ?, description = ?, updated_at = ?
             WHERE id = ?`
        ),
        softDelete: db.query(
            'UPDATE symbol_weight_configs SET is_deleted = 1, updated_at = ? WHERE id = ?'
        ),
    };

    // ========== 奖励配置方案查询 ==========
    rewardConfigQueries = {
        // 方案管理
        getAllSchemes: db.query<any, never>(
            'SELECT * FROM reward_config_schemes WHERE is_deleted = 0 ORDER BY id ASC'
        ),
        getSchemeById: db.query<any, number>(
            'SELECT * FROM reward_config_schemes WHERE id = ?'
        ),
        getSchemeUsageInfo: db.query<any, number>(`
            SELECT 
                (SELECT COUNT(*) FROM slot_machine_config WHERE reward_scheme_id = ?) +
                (SELECT COUNT(*) FROM advanced_slot_config WHERE reward_scheme_id = ?) +
                (SELECT COUNT(*) FROM supreme_slot_config WHERE reward_scheme_id = ?) as usage_count
        `),
        insertScheme: db.query(
            `INSERT INTO reward_config_schemes (scheme_name, description, is_deleted, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?)`
        ),
        updateScheme: db.query(
            `UPDATE reward_config_schemes SET scheme_name = ?, description = ?, updated_at = ? WHERE id = ?`
        ),
        softDeleteScheme: db.query(
            'UPDATE reward_config_schemes SET is_deleted = 1, updated_at = ? WHERE id = ?'
        ),

        // 规则管理
        getRulesByScheme: db.query<any, number>(
            'SELECT * FROM reward_rules WHERE scheme_id = ? ORDER BY priority DESC'
        ),
        getRuleById: db.query<any, number>(
            'SELECT * FROM reward_rules WHERE id = ?'
        ),
        insertRule: db.query(
            `INSERT INTO reward_rules (scheme_id, rule_name, rule_type, rule_category, match_pattern, match_count, required_symbols, win_multiplier, grant_free_spin, priority, is_active, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        updateRule: db.query(
            `UPDATE reward_rules SET 
             rule_name = ?, rule_type = ?, rule_category = ?, match_pattern = ?, match_count = ?, required_symbols = ?, win_multiplier = ?, grant_free_spin = ?, priority = ?, is_active = ?, description = ?, updated_at = ?
             WHERE id = ?`
        ),
        deleteRule: db.query(
            'DELETE FROM reward_rules WHERE id = ?'
        ),

        // 律师函惩罚配置
        getPunishmentsByScheme: db.query<any, number>(
            'SELECT * FROM punishment_lsh_configs WHERE scheme_id = ? ORDER BY lsh_count ASC'
        ),
        upsertPunishment: db.query(
            `INSERT INTO punishment_lsh_configs (scheme_id, lsh_count, deduct_multiplier, ban_hours, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scheme_id, lsh_count) DO UPDATE SET
             deduct_multiplier = ?, ban_hours = ?, is_active = ?, updated_at = ?`
        ),
    };

    // ========== 至尊场查询 ==========
    supremeSlotQueries = {
        // 令牌管理
        getTokens: db.query<any, string>(
            'SELECT * FROM supreme_user_tokens WHERE linux_do_id = ?'
        ),
        upsertTokens: db.query(
            `INSERT INTO supreme_user_tokens (linux_do_id, tokens, fragments, tokens_expires_at, supreme_mode_until, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tokens = excluded.tokens, fragments = excluded.fragments, tokens_expires_at = excluded.tokens_expires_at, supreme_mode_until = excluded.supreme_mode_until, updated_at = excluded.updated_at`
        ),
        useToken: db.query(
            `UPDATE supreme_user_tokens SET tokens = tokens - 1, supreme_mode_until = ?, updated_at = ? WHERE linux_do_id = ? AND tokens > 0`
        ),
        exitSupremeMode: db.query(
            `UPDATE supreme_user_tokens SET supreme_mode_until = NULL, updated_at = ? WHERE linux_do_id = ?`
        ),

        // 至尊场配置
        getConfig: db.query<any, never>(
            'SELECT * FROM supreme_slot_config WHERE id = 1'
        ),
        updateConfig: db.query(
            `UPDATE supreme_slot_config SET enabled = ?, fragments_to_token = ?, max_tokens_hold = ?, token_valid_hours = ?, session_valid_hours = ?, min_bet_amount = ?, max_bet_amount = ?, bet_step = ?, daily_entry_limit = ?, daily_token_grant_limit = ?, daily_bet_limit = ?, weight_config_id = ?, reward_scheme_id = ?, updated_at = ? WHERE id = 1`
        ),

        // 游戏记录
        insertRecord: db.query(
            'INSERT INTO supreme_slot_records (linux_do_id, username, linux_do_username, bet_amount, result_symbols, win_type, win_multiplier, win_amount, rule_name, timestamp, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getRecordsByUser: db.query<any, string>(
            'SELECT * FROM supreme_slot_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllRecords: db.query<any, never>(
            'SELECT * FROM supreme_slot_records ORDER BY timestamp DESC LIMIT 200'
        ),
        // 🚀 优化：至尊场记录分页
        getAllRecordsPaginated: db.query<any, [number, number]>(
            'SELECT * FROM supreme_slot_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        // 🚀 优化：按用户筛选至尊场记录
        getRecordsByUserPaginated: db.query<any, [string, string, string, number, number]>(`
            SELECT * FROM supreme_slot_records
            WHERE linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：至尊场记录总数
        countRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM supreme_slot_records'
        ),
        // 🚀 优化：按用户筛选至尊场记录总数
        countRecordsByUser: db.query<{ count: number }, [string, string, string]>(`
            SELECT COUNT(*) as count FROM supreme_slot_records
            WHERE linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?
        `),

        // 掉落记录
        insertDropRecord: db.query(
            'INSERT INTO supreme_token_drop_records (linux_do_id, username, drop_type, drop_count, source, trigger_win_type, timestamp, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getAllDropRecords: db.query<any, never>(
            'SELECT * FROM supreme_token_drop_records ORDER BY timestamp DESC LIMIT 200'
        ),

        // 每日进入记录
        getTodayEntry: db.query<any, [string, string]>(
            'SELECT * FROM supreme_daily_entries WHERE linux_do_id = ? AND entry_date = ?'
        ),
        updateTodayEntry: db.query(
            `INSERT INTO supreme_daily_entries (linux_do_id, entry_date, entry_count, last_entry_time)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(linux_do_id, entry_date) DO UPDATE SET entry_count = entry_count + 1, last_entry_time = ?`
        ),

        // 每日令牌获得记录
        getTodayGrant: db.query<any, [string, string]>(
            'SELECT * FROM supreme_daily_token_grants WHERE linux_do_id = ? AND grant_date = ?'
        ),
        updateTodayGrant: db.query(
            `INSERT INTO supreme_daily_token_grants (linux_do_id, grant_date, tokens_granted, fragments_granted, last_grant_time)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, grant_date) DO UPDATE SET tokens_granted = tokens_granted + ?, fragments_granted = fragments_granted + ?, last_grant_time = ?`
        ),
    };

    // 🔥 注意：Session清理定时器已在下方统一设置，这里移除重复的定时器

    console.log('✅ 数据库查询语句已预编译（含高级场、至尊场和配置方案系统）');

    // 待发放奖金相关
    pendingRewardQueries = {
        // 插入新的待发放奖金
        insert: db.query(
            'INSERT INTO pending_rewards (linux_do_id, kyx_user_id, username, reward_amount, reason, status, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        // 获取待发放的奖金（status = pending 或 failed）
        getPending: db.query<any, never>(
            "SELECT * FROM pending_rewards WHERE status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT 50"
        ),
        // 获取所有奖金记录（包括成功的，用于管理后台查看）
        getAll: db.query<any, never>(
            "SELECT * FROM pending_rewards ORDER BY created_at DESC LIMIT 200"
        ),
        // 获取用户的待发放奖金
        getByUser: db.query<any, string>(
            "SELECT * FROM pending_rewards WHERE linux_do_id = ? ORDER BY created_at DESC"
        ),
        // 获取用户的待发放奖金数量和总金额
        getUserPendingSummary: db.query<{ count: number; total_amount: number }, string>(
            "SELECT COUNT(*) as count, COALESCE(SUM(reward_amount), 0) as total_amount FROM pending_rewards WHERE linux_do_id = ? AND status IN ('pending', 'processing', 'failed')"
        ),
        // 更新奖金状态
        updateStatus: db.query(
            'UPDATE pending_rewards SET status = ?, updated_at = ?, error_message = ? WHERE id = ?'
        ),
        // 更新为成功
        markSuccess: db.query(
            'UPDATE pending_rewards SET status = ?, processed_at = ?, updated_at = ? WHERE id = ?'
        ),
        // 增加重试次数
        incrementRetry: db.query(
            'UPDATE pending_rewards SET retry_count = retry_count + 1, status = ?, error_message = ?, updated_at = ? WHERE id = ?'
        ),
        // 获取单条记录
        getById: db.query<any, number>(
            'SELECT * FROM pending_rewards WHERE id = ?'
        ),
    };

    // ========== 高级场系统查询 ==========
    advancedSlotQueries = {
        // 入场券和碎片管理
        getTickets: db.query<UserTickets, string>(
            'SELECT * FROM user_tickets WHERE linux_do_id = ?'
        ),
        upsertTickets: db.query(
            `INSERT INTO user_tickets (linux_do_id, tickets, fragments, tickets_expires_at, advanced_mode_until, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tickets = excluded.tickets,
             fragments = excluded.fragments,
             tickets_expires_at = excluded.tickets_expires_at,
             advanced_mode_until = excluded.advanced_mode_until,
             updated_at = excluded.updated_at`
        ),
        addTickets: db.query(
            `INSERT INTO user_tickets (linux_do_id, tickets, tickets_expires_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tickets = MIN(tickets + ?, ?),
             tickets_expires_at = ?,
             updated_at = ?`
        ),
        addFragments: db.query(
            `INSERT INTO user_tickets (linux_do_id, fragments, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             fragments = fragments + ?,
             updated_at = ?`
        ),
        useTicket: db.query(
            `UPDATE user_tickets SET 
             tickets = tickets - 1,
             advanced_mode_until = ?,
             updated_at = ?
             WHERE linux_do_id = ? AND tickets > 0`
        ),
        clearExpiredTickets: db.query(
            `UPDATE user_tickets 
             SET tickets = 0, tickets_expires_at = NULL, updated_at = ?
             WHERE linux_do_id = ? AND tickets_expires_at < ?`
        ),
        exitAdvancedMode: db.query(
            `UPDATE user_tickets
             SET advanced_mode_until = NULL, updated_at = ?
             WHERE linux_do_id = ?`
        ),

        // 高级场配置
        getAdvancedConfig: db.query<AdvancedSlotConfig, never>(
            'SELECT * FROM advanced_slot_config WHERE id = 1'
        ),
        updateAdvancedConfig: db.query(
            `UPDATE advanced_slot_config SET
             enabled = ?,
             bet_min = ?,
             bet_max = ?,
             reward_multiplier = ?,
             penalty_weight_factor = ?,
             rtp_target = ?,
             ticket_valid_hours = ?,
             session_valid_hours = ?,
             fragments_needed = ?,
             drop_rate_triple = ?,
             drop_rate_double = ?,
             max_tickets_hold = ?,
             daily_bet_limit = ?,
             daily_entry_limit = ?,
             daily_ticket_grant_limit = ?,
             updated_at = ?
             WHERE id = 1`
        ),

        // 入场券掉落记录
        insertDropRecord: db.query(
            'INSERT INTO ticket_drop_records (linux_do_id, username, drop_type, drop_count, trigger_win_type, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ),
        getDropRecordsByUser: db.query<TicketDropRecord, string>(
            'SELECT * FROM ticket_drop_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllDropRecords: db.query<TicketDropRecord, never>(
            'SELECT * FROM ticket_drop_records ORDER BY timestamp DESC LIMIT 200'
        ),

        // RTP 统计
        getRTPStats: db.query<AdvancedSlotRTPStats, string>(
            'SELECT * FROM advanced_slot_rtp_stats WHERE linux_do_id = ?'
        ),
        updateRTPStats: db.query(
            `INSERT INTO advanced_slot_rtp_stats (linux_do_id, total_bet, total_win, rtp, games_count, last_updated)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             total_bet = total_bet + ?,
             total_win = total_win + ?,
             rtp = CAST(total_win AS REAL) / CAST(total_bet AS REAL),
             games_count = games_count + 1,
             last_updated = ?`
        ),
        getAllRTPStats: db.query<AdvancedSlotRTPStats, never>(
            'SELECT * FROM advanced_slot_rtp_stats ORDER BY games_count DESC LIMIT 100'
        ),

        // 高级场符号权重
        getAdvancedWeights: db.query<any, never>(
            'SELECT * FROM advanced_slot_symbol_weights WHERE id = 1'
        ),
        updateAdvancedWeights: db.query(
            'UPDATE advanced_slot_symbol_weights SET weight_m = ?, weight_t = ?, weight_n = ?, weight_j = ?, weight_lq = ?, weight_bj = ?, weight_zft = ?, weight_bdk = ?, weight_lsh = ?, updated_at = ? WHERE id = 1'
        ),

        // 用户每日进入高级场记录
        getTodayEntry: db.query<UserAdvancedEntry, [string, string]>(
            'SELECT * FROM user_advanced_entries WHERE linux_do_id = ? AND entry_date = ?'
        ),
        updateTodayEntry: db.query(
            `INSERT INTO user_advanced_entries (linux_do_id, entry_date, entry_count, last_entry_time)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(linux_do_id, entry_date) DO UPDATE SET
             entry_count = entry_count + 1,
             last_entry_time = ?`
        ),

        // 用户每日入场券获得记录
        getTodayGrant: db.query<UserDailyTicketGrant, [string, string]>(
            'SELECT * FROM user_daily_ticket_grants WHERE linux_do_id = ? AND grant_date = ?'
        ),
        updateTodayTicketGrant: db.query(
            `INSERT INTO user_daily_ticket_grants (linux_do_id, grant_date, ticket_granted, fragment_granted, last_grant_time)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, grant_date) DO UPDATE SET
             ticket_granted = ticket_granted + ?,
             fragment_granted = fragment_granted + ?,
             last_grant_time = ?`
        ),
    };

    // ========== 坤呗借款系统查询 ==========
    kunbeiQueries = {
        // 配置管理
        getConfig: db.query<KunbeiConfig, never>(
            'SELECT * FROM kunbei_config WHERE id = 1'
        ),
        updateConfig: db.query(
            `UPDATE kunbei_config SET 
             enabled = ?, max_loan_amount = ?, min_loan_amount = ?,
             repay_multiplier = ?, loan_duration_hours = ?, early_repay_discount = ?,
             overdue_penalty_hours = ?, overdue_ban_advanced = ?, max_active_loans = ?,
             deduct_all_quota_on_overdue = ?, overdue_deduct_multiplier = ?, max_daily_borrows = ?, updated_at = ? WHERE id = 1`
        ),

        // 借款记录管理
        getActiveLoan: db.query<UserLoan, string>(
            'SELECT * FROM user_loans WHERE linux_do_id = ? AND status = "active" LIMIT 1'
        ),
        getLoanById: db.query<UserLoan, number>(
            'SELECT * FROM user_loans WHERE id = ?'
        ),
        getUserLoans: db.query<UserLoan, string>(
            'SELECT * FROM user_loans WHERE linux_do_id = ? ORDER BY created_at DESC LIMIT 20'
        ),
        getAllLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans ORDER BY created_at DESC LIMIT 200'
        ),
        getActiveLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans WHERE status = "active"'
        ),
        getOverdueLoans: db.query<UserLoan, never>(
            'SELECT * FROM user_loans WHERE status = "overdue"'
        ),
        getTodayBorrowCount: db.query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) as count FROM user_loans 
             WHERE linux_do_id = ? AND DATE(borrowed_at / 1000, 'unixepoch') = ?`
        ),
        insertLoan: db.query(
            `INSERT INTO user_loans (linux_do_id, username, loan_amount, repay_amount, status, borrowed_at, due_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        updateLoanStatus: db.query(
            `UPDATE user_loans SET status = ?, actual_repay_amount = ?, repaid_at = ?, overdue_penalty_until = ?, updated_at = ?
             WHERE id = ?`
        ),
        updateLoanOverdue: db.query(
            `UPDATE user_loans SET status = ?, overdue_penalty_until = ?, auto_deducted_amount = ?, balance_after_deduct = ?, updated_at = ?
             WHERE id = ?`
        ),
        clearOverduePenalty: db.query(
            `UPDATE user_loans SET overdue_penalty_until = NULL, updated_at = ?
             WHERE id = ?`
        ),
        deleteLoan: db.query(
            'DELETE FROM user_loans WHERE id = ?'
        ),

        // 用户统计管理
        getStats: db.query<UserKunbeiStats, string>(
            'SELECT * FROM user_kunbei_stats WHERE linux_do_id = ?'
        ),
        upsertStats: db.query(
            `INSERT INTO user_kunbei_stats (linux_do_id, total_borrowed, total_repaid, total_loans, repaid_loans, overdue_loans, credit_score, is_banned, last_borrow_date, has_daily_buff, buff_multiplier, buff_used, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             total_borrowed = total_borrowed + ?,
             total_repaid = total_repaid + ?,
             total_loans = total_loans + ?,
             repaid_loans = repaid_loans + ?,
             overdue_loans = overdue_loans + ?,
             credit_score = ?,
             last_borrow_date = ?,
             has_daily_buff = ?,
             buff_multiplier = ?,
             buff_used = ?,
             updated_at = ?`
        ),
        updateCreditScore: db.query(
            `INSERT INTO user_kunbei_stats (linux_do_id, credit_score, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             credit_score = MAX(0, MIN(100, credit_score + ?)),
             updated_at = ?`
        ),

        // Buff相关查询
        checkBuff: db.query<UserKunbeiStats, string>(
            'SELECT * FROM user_kunbei_stats WHERE linux_do_id = ? AND has_daily_buff = 1 AND buff_used = 0'
        ),
        useBuff: db.query(
            'UPDATE user_kunbei_stats SET buff_used = 1, updated_at = ? WHERE linux_do_id = ?'
        ),

        // 梯度配置相关查询
        getGradientConfigs: db.query<KunbeiGradientConfig, never>(
            'SELECT * FROM kunbei_gradient_configs WHERE is_active = 1 ORDER BY quota_threshold ASC'
        ),
        getGradientConfigById: db.query<KunbeiGradientConfig, number>(
            'SELECT * FROM kunbei_gradient_configs WHERE id = ?'
        ),
        getAllGradientConfigs: db.query<KunbeiGradientConfig, never>(
            'SELECT * FROM kunbei_gradient_configs ORDER BY quota_threshold ASC'
        ),
        insertGradientConfig: db.query(
            `INSERT INTO kunbei_gradient_configs (quota_threshold, max_loan_amount, priority, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ),
        updateGradientConfig: db.query(
            `UPDATE kunbei_gradient_configs 
             SET quota_threshold = ?, max_loan_amount = ?, priority = ?, is_active = ?, updated_at = ?
             WHERE id = ?`
        ),
        deleteGradientConfig: db.query(
            'DELETE FROM kunbei_gradient_configs WHERE id = ?'
        ),
    };

    // ========== 权重配置方案查询 ==========
    weightConfigQueries = {
        getAll: db.query<any, never>(
            'SELECT * FROM symbol_weight_configs WHERE is_deleted = 0 ORDER BY id ASC'
        ),
        getById: db.query<any, number>(
            'SELECT * FROM symbol_weight_configs WHERE id = ?'
        ),
        getUsageInfo: db.query<any, number>(`
            SELECT 
                (SELECT COUNT(*) FROM slot_machine_config WHERE weight_config_id = ?) +
                (SELECT COUNT(*) FROM advanced_slot_config WHERE weight_config_id = ?) +
                (SELECT COUNT(*) FROM supreme_slot_config WHERE weight_config_id = ?) as usage_count
        `),
        insert: db.query(
            `INSERT INTO symbol_weight_configs (config_name, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, weight_man, description, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        ),
        update: db.query(
            `UPDATE symbol_weight_configs SET
             config_name = ?, weight_m = ?, weight_t = ?, weight_n = ?, weight_j = ?, weight_lq = ?, weight_bj = ?, weight_zft = ?, weight_bdk = ?, weight_lsh = ?, weight_man = ?, description = ?, updated_at = ?
             WHERE id = ?`
        ),
        softDelete: db.query(
            'UPDATE symbol_weight_configs SET is_deleted = 1, updated_at = ? WHERE id = ?'
        ),
    };

    // ========== 奖励配置方案查询 ==========
    rewardConfigQueries = {
        // 方案管理
        getAllSchemes: db.query<any, never>(
            'SELECT * FROM reward_config_schemes WHERE is_deleted = 0 ORDER BY id ASC'
        ),
        getSchemeById: db.query<any, number>(
            'SELECT * FROM reward_config_schemes WHERE id = ?'
        ),
        getSchemeUsageInfo: db.query<any, number>(`
            SELECT 
                (SELECT COUNT(*) FROM slot_machine_config WHERE reward_scheme_id = ?) +
                (SELECT COUNT(*) FROM advanced_slot_config WHERE reward_scheme_id = ?) +
                (SELECT COUNT(*) FROM supreme_slot_config WHERE reward_scheme_id = ?) as usage_count
        `),
        insertScheme: db.query(
            `INSERT INTO reward_config_schemes (scheme_name, description, is_deleted, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?)`
        ),
        updateScheme: db.query(
            `UPDATE reward_config_schemes SET scheme_name = ?, description = ?, updated_at = ? WHERE id = ?`
        ),
        softDeleteScheme: db.query(
            'UPDATE reward_config_schemes SET is_deleted = 1, updated_at = ? WHERE id = ?'
        ),

        // 规则管理
        getRulesByScheme: db.query<any, number>(
            'SELECT * FROM reward_rules WHERE scheme_id = ? ORDER BY priority DESC'
        ),
        getRuleById: db.query<any, number>(
            'SELECT * FROM reward_rules WHERE id = ?'
        ),
        insertRule: db.query(
            `INSERT INTO reward_rules (scheme_id, rule_name, rule_type, rule_category, match_pattern, match_count, required_symbols, win_multiplier, grant_free_spin, priority, is_active, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        updateRule: db.query(
            `UPDATE reward_rules SET 
             rule_name = ?, rule_type = ?, rule_category = ?, match_pattern = ?, match_count = ?, required_symbols = ?, win_multiplier = ?, grant_free_spin = ?, priority = ?, is_active = ?, description = ?, updated_at = ?
             WHERE id = ?`
        ),
        deleteRule: db.query(
            'DELETE FROM reward_rules WHERE id = ?'
        ),

        // 律师函惩罚配置
        getPunishmentsByScheme: db.query<any, number>(
            'SELECT * FROM punishment_lsh_configs WHERE scheme_id = ? ORDER BY lsh_count ASC'
        ),
        upsertPunishment: db.query(
            `INSERT INTO punishment_lsh_configs (scheme_id, lsh_count, deduct_multiplier, ban_hours, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scheme_id, lsh_count) DO UPDATE SET
             deduct_multiplier = ?, ban_hours = ?, is_active = ?, updated_at = ?`
        ),
    };

    // ========== 至尊场查询 ==========
    supremeSlotQueries = {
        // 令牌管理
        getTokens: db.query<any, string>(
            'SELECT * FROM supreme_user_tokens WHERE linux_do_id = ?'
        ),
        upsertTokens: db.query(
            `INSERT INTO supreme_user_tokens (linux_do_id, tokens, fragments, tokens_expires_at, supreme_mode_until, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id) DO UPDATE SET
             tokens = excluded.tokens, fragments = excluded.fragments, tokens_expires_at = excluded.tokens_expires_at, supreme_mode_until = excluded.supreme_mode_until, updated_at = excluded.updated_at`
        ),
        useToken: db.query(
            `UPDATE supreme_user_tokens SET tokens = tokens - 1, supreme_mode_until = ?, updated_at = ? WHERE linux_do_id = ? AND tokens > 0`
        ),
        exitSupremeMode: db.query(
            `UPDATE supreme_user_tokens SET supreme_mode_until = NULL, updated_at = ? WHERE linux_do_id = ?`
        ),

        // 至尊场配置
        getConfig: db.query<any, never>(
            'SELECT * FROM supreme_slot_config WHERE id = 1'
        ),
        updateConfig: db.query(
            `UPDATE supreme_slot_config SET enabled = ?, fragments_to_token = ?, max_tokens_hold = ?, token_valid_hours = ?, session_valid_hours = ?, min_bet_amount = ?, max_bet_amount = ?, bet_step = ?, daily_entry_limit = ?, daily_token_grant_limit = ?, daily_bet_limit = ?, weight_config_id = ?, reward_scheme_id = ?, updated_at = ? WHERE id = 1`
        ),

        // 游戏记录
        insertRecord: db.query(
            'INSERT INTO supreme_slot_records (linux_do_id, username, linux_do_username, bet_amount, result_symbols, win_type, win_multiplier, win_amount, rule_name, timestamp, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getRecordsByUser: db.query<any, string>(
            'SELECT * FROM supreme_slot_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllRecords: db.query<any, never>(
            'SELECT * FROM supreme_slot_records ORDER BY timestamp DESC LIMIT 200'
        ),
        // 🚀 优化：至尊场记录分页
        getAllRecordsPaginated: db.query<any, [number, number]>(
            'SELECT * FROM supreme_slot_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        // 🚀 优化：按用户筛选至尊场记录
        getRecordsByUserPaginated: db.query<any, [string, string, string, number, number]>(`
            SELECT * FROM supreme_slot_records
            WHERE linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `),
        // 🚀 优化：至尊场记录总数
        countRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM supreme_slot_records'
        ),
        // 🚀 优化：按用户筛选至尊场记录总数
        countRecordsByUser: db.query<{ count: number }, [string, string, string]>(`
            SELECT COUNT(*) as count FROM supreme_slot_records
            WHERE linux_do_id = ? OR linux_do_username LIKE ? OR username LIKE ?
        `),

        // 掉落记录
        insertDropRecord: db.query(
            'INSERT INTO supreme_token_drop_records (linux_do_id, username, drop_type, drop_count, source, trigger_win_type, timestamp, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getAllDropRecords: db.query<any, never>(
            'SELECT * FROM supreme_token_drop_records ORDER BY timestamp DESC LIMIT 200'
        ),

        // 每日进入记录
        getTodayEntry: db.query<any, [string, string]>(
            'SELECT * FROM supreme_daily_entries WHERE linux_do_id = ? AND entry_date = ?'
        ),
        updateTodayEntry: db.query(
            `INSERT INTO supreme_daily_entries (linux_do_id, entry_date, entry_count, last_entry_time)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(linux_do_id, entry_date) DO UPDATE SET entry_count = entry_count + 1, last_entry_time = ?`
        ),

        // 每日令牌获得记录
        getTodayGrant: db.query<any, [string, string]>(
            'SELECT * FROM supreme_daily_token_grants WHERE linux_do_id = ? AND grant_date = ?'
        ),
        updateTodayGrant: db.query(
            `INSERT INTO supreme_daily_token_grants (linux_do_id, grant_date, tokens_granted, fragments_granted, last_grant_time)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(linux_do_id, grant_date) DO UPDATE SET tokens_granted = tokens_granted + ?, fragments_granted = fragments_granted + ?, last_grant_time = ?`
        ),
    };

    // ========== 掉落配置查询 ==========
    dropConfigQueries = {
        getAll: db.query<any, never>(
            'SELECT * FROM drop_configs ORDER BY slot_mode, priority DESC, id ASC'
        ),
        getByMode: db.query<any, string>(
            'SELECT * FROM drop_configs WHERE slot_mode = ? AND is_active = 1 ORDER BY priority DESC'
        ),
        getByModeAndRule: db.query<any, [string, string]>(
            'SELECT * FROM drop_configs WHERE slot_mode = ? AND trigger_rule_name = ? AND is_active = 1 ORDER BY priority DESC'
        ),
        getByModeAndType: db.query<any, [string, string]>(
            'SELECT * FROM drop_configs WHERE slot_mode = ? AND drop_item_type = ? AND is_active = 1 ORDER BY priority DESC'
        ),
        getById: db.query<any, number>(
            'SELECT * FROM drop_configs WHERE id = ?'
        ),
        insert: db.query(
            `INSERT INTO drop_configs (slot_mode, trigger_rule_name, drop_item_type, drop_probability, drop_count, is_active, priority, description, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        update: db.query(
            `UPDATE drop_configs SET 
             slot_mode = ?, trigger_rule_name = ?, drop_item_type = ?, drop_probability = ?, drop_count = ?, is_active = ?, priority = ?, description = ?, updated_at = ?
             WHERE id = ?`
        ),
        delete: db.query(
            'DELETE FROM drop_configs WHERE id = ?'
        ),
    };

    // ========== 成就系统查询 ==========
    // 🛡️ 速率限制封禁记录查询
    rateLimitBanQueries = {
        // 插入封禁记录
        insert: db.query(`
            INSERT INTO rate_limit_bans (
                linux_do_id, username, ban_type, trigger_count, ban_reason,
                banned_at, banned_until, is_active, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `),
        // 获取用户当前活跃的封禁记录
        getActiveBan: db.query<any, string>(`
            SELECT * FROM rate_limit_bans
            WHERE linux_do_id = ? AND is_active = 1 AND banned_until > ?
            ORDER BY banned_until DESC LIMIT 1
        `),
        // 获取所有封禁记录（分页）
        getAllPaginated: db.query<any, [number, number]>(`
            SELECT * FROM rate_limit_bans
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `),
        // 获取总记录数
        getCount: db.query<{ total: number }, never>(`
            SELECT COUNT(*) as total FROM rate_limit_bans
        `),
        // 按用户搜索
        searchByUser: db.query<any, [string, number, number]>(`
            SELECT * FROM rate_limit_bans
            WHERE username LIKE ? OR linux_do_id LIKE ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `),
        // 手动解封
        unban: db.query(`
            UPDATE rate_limit_bans
            SET is_active = 0, unbanned_at = ?, unbanned_by = ?, unban_reason = ?
            WHERE id = ?
        `),
        // 获取统计信息
        getStats: db.query<any, never>(`
            SELECT
                COUNT(*) as total_bans,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_bans,
                COUNT(DISTINCT linux_do_id) as unique_users
            FROM rate_limit_bans
        `)
    };

    achievementQueries = {
        // 成就定义
        getAll: db.query<Achievement, never>('SELECT * FROM achievements WHERE is_active = 1 ORDER BY display_order ASC, id ASC'),
        getByKey: db.query<Achievement, string>('SELECT * FROM achievements WHERE achievement_key = ? AND is_active = 1'),
        getByCategory: db.query<Achievement, string>('SELECT * FROM achievements WHERE category = ? AND is_active = 1 ORDER BY display_order ASC'),
        insert: db.query(`
            INSERT INTO achievements (
                achievement_key, achievement_name, achievement_desc, category, icon,
                condition_type, condition_value, reward_quota, rarity, display_order,
                is_hidden, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        update: db.query(`
            UPDATE achievements SET
                achievement_name = ?, achievement_desc = ?, category = ?, icon = ?,
                condition_type = ?, condition_value = ?, reward_quota = ?, rarity = ?,
                display_order = ?, is_hidden = ?, is_active = ?, updated_at = ?
            WHERE achievement_key = ?
        `),
        delete: db.query('DELETE FROM achievements WHERE achievement_key = ?'),

        // 用户成就
        getUserAchievement: db.query<UserAchievement, [string, string]>(
            'SELECT * FROM user_achievements WHERE linux_do_id = ? AND achievement_key = ?'
        ),
        getUserAchievements: db.query<UserAchievement, string>(
            'SELECT * FROM user_achievements WHERE linux_do_id = ? ORDER BY unlocked_at DESC'
        ),
        insertUserAchievement: db.query(`
            INSERT OR IGNORE INTO user_achievements (
                linux_do_id, achievement_key, unlocked_at, reward_claimed, progress
            ) VALUES (?, ?, ?, 0, ?)
        `),
        claimReward: db.query(`
            UPDATE user_achievements SET reward_claimed = 1, claimed_at = ?
            WHERE linux_do_id = ? AND achievement_key = ?
        `),
        getUnclaimedRewards: db.query<UserAchievement, string>(
            'SELECT * FROM user_achievements WHERE linux_do_id = ? AND reward_claimed = 0'
        ),

        // 成就进度
        getProgress: db.query<AchievementProgress, [string, string]>(
            'SELECT * FROM achievement_progress WHERE linux_do_id = ? AND achievement_key = ?'
        ),
        getUserProgress: db.query<AchievementProgress, string>(
            'SELECT * FROM achievement_progress WHERE linux_do_id = ?'
        ),
        updateProgress: db.query(`
            INSERT INTO achievement_progress (linux_do_id, achievement_key, current_value, target_value, last_updated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(linux_do_id, achievement_key) DO UPDATE SET
                current_value = excluded.current_value,
                last_updated = excluded.last_updated
        `),
        deleteProgress: db.query('DELETE FROM achievement_progress WHERE linux_do_id = ? AND achievement_key = ?'),

        // 用户成就统计
        getStats: db.query<UserAchievementStats, string>(
            'SELECT * FROM user_achievement_stats WHERE linux_do_id = ?'
        ),
        updateStats: db.query(`
            INSERT INTO user_achievement_stats (
                linux_do_id, total_achievements, unlocked_achievements, completion_rate,
                total_rewards, claimed_rewards, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(linux_do_id) DO UPDATE SET
                total_achievements = excluded.total_achievements,
                unlocked_achievements = excluded.unlocked_achievements,
                completion_rate = excluded.completion_rate,
                total_rewards = excluded.total_rewards,
                claimed_rewards = excluded.claimed_rewards,
                updated_at = excluded.updated_at
        `),
        updateBadges: db.query(`
            UPDATE user_achievement_stats SET
                badge_slot_1 = ?, badge_slot_2 = ?, badge_slot_3 = ?, updated_at = ?
            WHERE linux_do_id = ?
        `),
        getLeaderboard: db.query<UserAchievementStats & { username: string, linux_do_username: string }, number>(`
            SELECT s.*, u.username, u.linux_do_username
            FROM user_achievement_stats s
            JOIN users u ON s.linux_do_id = u.linux_do_id
            ORDER BY s.unlocked_achievements DESC, s.claimed_rewards DESC
            LIMIT ?
        `),

        // 成就统计 - 获取每个成就的达成人数
        getAchievementStats: db.query<{ achievement_key: string, unlock_count: number }, never>(`
            SELECT achievement_key, COUNT(*) as unlock_count
            FROM user_achievements
            GROUP BY achievement_key
        `),

        // 获取总用户数（用于计算达成率）
        getTotalUsers: db.query<{ total: number }, never>(`
            SELECT COUNT(DISTINCT linux_do_id) as total FROM users
        `),

        // 获取单个成就的达成人数
        getAchievementUnlockCount: db.query<{ unlock_count: number }, string>(`
            SELECT COUNT(*) as unlock_count
            FROM user_achievements
            WHERE achievement_key = ?
        `),

        // 符号收集追踪
        getSymbolCollection: db.query<any, string>(`SELECT * FROM user_symbol_collection WHERE linux_do_id = ?`),
        recordSymbol: db.query(`
            INSERT INTO user_symbol_collection (
                linux_do_id, symbol_m, symbol_t, symbol_n, symbol_j,
                symbol_lq, symbol_bj, symbol_zft, symbol_bdk, symbol_lsh, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(linux_do_id) DO UPDATE SET
                symbol_m = MAX(symbol_m, excluded.symbol_m),
                symbol_t = MAX(symbol_t, excluded.symbol_t),
                symbol_n = MAX(symbol_n, excluded.symbol_n),
                symbol_j = MAX(symbol_j, excluded.symbol_j),
                symbol_lq = MAX(symbol_lq, excluded.symbol_lq),
                symbol_bj = MAX(symbol_bj, excluded.symbol_bj),
                symbol_zft = MAX(symbol_zft, excluded.symbol_zft),
                symbol_bdk = MAX(symbol_bdk, excluded.symbol_bdk),
                symbol_lsh = MAX(symbol_lsh, excluded.symbol_lsh),
                updated_at = excluded.updated_at
        `),

        // 盈利追踪
        getProfitTracking: db.query<any, string>(`SELECT * FROM user_profit_tracking WHERE linux_do_id = ?`),
        updateProfitTracking: db.query(`
            INSERT INTO user_profit_tracking (linux_do_id, lowest_profit, highest_profit, last_profit, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(linux_do_id) DO UPDATE SET
                lowest_profit = MIN(lowest_profit, excluded.lowest_profit),
                highest_profit = MAX(highest_profit, excluded.highest_profit),
                last_profit = excluded.last_profit,
                updated_at = excluded.updated_at
        `),
    };

    // 🔥 统一的定时清理任务（每6小时执行一次，减少频率）
    setInterval(() => {
        try {
            const now = Date.now();
            sessionQueries.cleanup.run(now);
            logger.info('定时任务', '🧹 已执行过期 Session 清理');
        } catch (error: any) {
            logger.error('定时任务', `❌ Session 清理失败: ${error.message}`);
        }
    }, 21600000);  // 每6小时（从1小时延长，减少日志频率）

    console.log('✅ 数据库查询语句已预编译（含高级场、至尊场、配置方案和掉落系统）');
}

/**
 * 修复奖励规则中错误的 required_symbols 数据
 * 这个函数在数据库初始化时自动执行，清理格式错误的JSON数据
 */
function fixRewardRulesData(): void {
    try {
        console.log('🔧 [数据修复] 开始检查并修复 reward_rules 数据...');

        // 统计修复前的问题数据
        const countBefore = db.query<{ count: number }, never>(`
            SELECT COUNT(*) as count FROM reward_rules
            WHERE required_symbols IS NOT NULL
              AND (
                required_symbols = ''
                OR required_symbols = '[]'
                OR required_symbols IN ('null', 'undefined', 'NULL', 'UNDEFINED')
                OR TRIM(required_symbols) = ''
              )
        `).get();

        if (countBefore && countBefore.count > 0) {
            console.log(`📊 [数据修复] 发现 ${countBefore.count} 条需要修复的规则`);

            // 1. 修复空字符串
            db.exec(`UPDATE reward_rules SET required_symbols = NULL WHERE required_symbols = ''`);

            // 2. 修复空数组
            db.exec(`UPDATE reward_rules SET required_symbols = NULL WHERE required_symbols = '[]'`);

            // 3. 修复 'null' 或 'undefined' 字符串
            db.exec(`UPDATE reward_rules SET required_symbols = NULL WHERE required_symbols IN ('null', 'undefined', 'NULL', 'UNDEFINED')`);

            // 4. 修复只包含空格的字符串
            db.exec(`UPDATE reward_rules SET required_symbols = NULL WHERE TRIM(required_symbols) = ''`);

            console.log(`✅ [数据修复] 已修复 ${countBefore.count} 条规则的 required_symbols 字段`);
        } else {
            console.log('✅ [数据修复] reward_rules 数据完整，无需修复');
        }

        // 统计修复后的数据情况
        const statsAfter = db.query<{ null_count: number, valid_count: number }, never>(`
            SELECT
                SUM(CASE WHEN required_symbols IS NULL THEN 1 ELSE 0 END) as null_count,
                SUM(CASE WHEN required_symbols IS NOT NULL THEN 1 ELSE 0 END) as valid_count
            FROM reward_rules
        `).get();

        if (statsAfter) {
            console.log(`📊 [数据修复] 统计: NULL=${statsAfter.null_count}, 有效JSON=${statsAfter.valid_count}`);
        }

        // 🔥 智能修复Man专用规则的required_symbols字段
        console.log('🔧 [数据修复] 智能检测并修复Man专用规则...');

        const now = Date.now();

        // 方式1：基于规则名称模糊匹配（匹配所有可能的命名方式）
        const manKeywords = ['man', 'kun', 'Man', 'Kun', 'MAN', 'KUN', '男人'];
        const patterns = [
            { name: ['二连', '2连', '两连'], pattern: '2-consecutive', count: 2 },
            { name: ['三连', '3连'], pattern: '3-consecutive', count: 3 },
            { name: ['四连', '4连'], pattern: '4-consecutive', count: 4 }
        ];

        let fixedCount = 0;

        patterns.forEach(p => {
            // 构建匹配条件
            const nameConditions = manKeywords.flatMap(kw =>
                p.name.map(n => `rule_name LIKE '%${kw}${n}%'`)
            ).join(' OR ');

            const sql = `
                UPDATE reward_rules 
                SET required_symbols = '["man"]', updated_at = ${now}
                WHERE (${nameConditions})
                AND match_pattern = '${p.pattern}'
                AND (required_symbols IS NULL OR required_symbols = '' OR required_symbols = '[]' 
                     OR required_symbols = 'null' OR required_symbols = 'undefined')
            `;

            db.exec(sql);

            // 统计修复数量
            const result = db.query<{ changes: number }, never>('SELECT changes() as changes').get();
            if (result && result.changes > 0) {
                console.log(`  ✅ 修复了 ${result.changes} 条 ${p.pattern} 的Man规则`);
                fixedCount += result.changes;
            }
        });

        console.log(`✅ [数据修复] Man专用规则修复完成，共修复 ${fixedCount} 条规则`);

    } catch (error: any) {
        console.error('❌ [数据修复] 修复 reward_rules 数据时出错:', error);
        // 不抛出错误，避免影响系统启动
    }
}

/**
 * 修复成就描述 - 将 quota 单位改为 $
 */
function fixAchievementDescriptions(): void {
    try {
        console.log('🔧 [成就修复] 开始更新成就描述单位...');

        const updates = [
            { key: 'earn_10k', oldDesc: '累计获得10,000 quota', newDesc: '累计盈利$2,000' },
            { key: 'earn_100k', oldDesc: '累计获得100,000 quota', newDesc: '累计盈利$20,000' },
            { key: 'earn_1m', oldDesc: '累计获得1,000,000 quota', newDesc: '累计盈利$2,000,000' },
            { key: 'balance_50k', oldDesc: '账户余额达到50,000', newDesc: '账户余额达到$10,000,000' },
            { key: 'single_win_5k', oldDesc: '单次中奖超过5,000 quota', newDesc: '单次中奖超过$100,000' }
        ];

        let updatedCount = 0;
        const now = Date.now();

        for (const update of updates) {
            // 只更新旧描述的成就
            const result = db.query<{ changes: number }, never>(`
                UPDATE achievements
                SET achievement_desc = ?, updated_at = ?
                WHERE achievement_key = ? AND achievement_desc = ?
            `, [update.newDesc, now, update.key, update.oldDesc]).run();

            if (result && result.changes > 0) {
                console.log(`  ✅ ${update.key}: ${update.oldDesc} → ${update.newDesc}`);
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            console.log(`✅ [成就修复] 成功更新 ${updatedCount} 个成就描述`);
        } else {
            console.log('✅ [成就修复] 成就描述已是最新，无需更新');
        }

    } catch (error: any) {
        console.error('❌ [成就修复] 更新成就描述时出错:', error);
        // 不抛出错误，避免影响系统启动
    }
}
