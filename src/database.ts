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
} from './types';

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
      updated_at INTEGER NOT NULL
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
      updated_at INTEGER NOT NULL
    )
  `);

    // 插入默认符号权重配置
    db.exec(`
    INSERT OR IGNORE INTO slot_symbol_weights (id, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, weight_zft, weight_bdk, weight_lsh, updated_at)
    VALUES (1, 100, 100, 100, 100, 100, 100, 100, 100, 25, ${Date.now()})
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

    // 添加 linux_do_username 字段（兼容旧数据库）
    try {
        db.exec('ALTER TABLE slot_machine_records ADD COLUMN linux_do_username TEXT');
        console.log('✅ 已添加 linux_do_username 字段到 slot_machine_records');
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
      updated_at INTEGER NOT NULL
    )
  `);

    // 插入默认高级场配置
    db.exec(`
    INSERT OR IGNORE INTO advanced_slot_config (id, enabled, bet_min, bet_max, reward_multiplier, penalty_weight_factor, rtp_target, ticket_valid_hours, session_valid_hours, fragments_needed, drop_rate_triple, drop_rate_double, max_tickets_hold, daily_bet_limit, updated_at)
    VALUES (1, 1, 50000000, 250000000, 4.0, 2.0, 0.95, 24, 24, 5, 1.0, 1.0, 2, 5000000000, ${Date.now()})
  `);

    // 入场券掉落记录表
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

    console.log('✅ 数据库初始化完成（含高级场系统）');

    // 初始化预编译查询语句
    initQueries();
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
        getAllLinuxDoIds: db.query<{ linux_do_id: string }, never>('SELECT linux_do_id FROM users WHERE is_banned = 0'),
        ban: db.query(
            'UPDATE users SET is_banned = 1, banned_at = ?, banned_reason = ? WHERE linux_do_id = ?'
        ),
        unban: db.query(
            'UPDATE users SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE linux_do_id = ?'
        ),
        delete: db.query(
            'DELETE FROM users WHERE linux_do_id = ?'
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
            'INSERT INTO slot_machine_records (linux_do_id, username, linux_do_username, bet_amount, result_symbols, win_type, win_multiplier, win_amount, free_spin_awarded, is_free_spin, timestamp, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        getRecordsByUser: db.query<SlotMachineRecord, string>(
            'SELECT * FROM slot_machine_records WHERE linux_do_id = ? ORDER BY timestamp DESC LIMIT 50'
        ),
        getAllRecords: db.query<SlotMachineRecord, never>(
            'SELECT * FROM slot_machine_records ORDER BY timestamp DESC'
        ),
        getAllRecordsPaginated: db.query<SlotMachineRecord, [number, number]>(
            'SELECT * FROM slot_machine_records ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ),
        countRecords: db.query<{ count: number }, never>(
            'SELECT COUNT(*) as count FROM slot_machine_records'
        ),
        getTodaySpins: db.query<{ count: number }, [string, string]>(
            'SELECT COUNT(*) as count FROM slot_machine_records WHERE linux_do_id = ? AND date = ? AND is_free_spin = 0'
        ),
        getTodayStats: db.query<{ total_bet: number; total_win: number; count: number }, [string, string]>(
            'SELECT COALESCE(SUM(bet_amount), 0) as total_bet, COALESCE(SUM(win_amount), 0) as total_win, COUNT(*) as count FROM slot_machine_records WHERE linux_do_id = ? AND date = ?'
        ),

        // 免费次数
        getFreeSpin: db.query<UserFreeSpin, string>(
            'SELECT * FROM user_free_spins WHERE linux_do_id = ?'
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
            'INSERT INTO user_free_spins (linux_do_id, free_spins, banned_until, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT(linux_do_id) DO UPDATE SET banned_until = ?, updated_at = ?'
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

        // 购买次数记录
        insertBuySpinsRecord: db.query(
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
    };

    // 定期清理过期 Session（每小时执行一次）
    setInterval(() => {
        const now = Date.now();
        const result = sessionQueries.cleanup.run(now);
        if (result.changes > 0) {
            console.log(`🧹 已清理 ${result.changes} 个过期 Session`);
        }
    }, 3600000);

    console.log('✅ 数据库查询语句已预编译（含高级场系统）');
}

