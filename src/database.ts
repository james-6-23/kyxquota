import { Database } from 'bun:sqlite';
import { CONFIG } from './config';
import type {
    User,
    ClaimRecord,
    DonateRecord,
    AdminConfig,
    SessionData,
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
      failed_keys TEXT
    )
  `);
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_donate_linux_do_id ON donate_records(linux_do_id)'
    );
    db.exec(
        'CREATE INDEX IF NOT EXISTS idx_donate_timestamp ON donate_records(timestamp)'
    );

    // 已使用的 Key 表
    db.exec(`
    CREATE TABLE IF NOT EXISTS used_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      linux_do_id TEXT NOT NULL,
      username TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_used_keys_key ON used_keys(key)');

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
      group_id INTEGER DEFAULT 26,
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

    console.log('✅ 数据库初始化完成');

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

/**
 * 初始化预编译查询语句
 * 必须在数据库表创建后调用
 */
function initQueries() {
    // 用户相关
    userQueries = {
        get: db.query<User, string>('SELECT * FROM users WHERE linux_do_id = ?'),
        insert: db.query(
            'INSERT INTO users (linux_do_id, username, kyx_user_id, created_at) VALUES (?, ?, ?, ?)'
        ),
        update: db.query(
            'UPDATE users SET username = ?, kyx_user_id = ? WHERE linux_do_id = ?'
        ),
        getAll: db.query<User, never>('SELECT * FROM users'),
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
            'INSERT INTO donate_records (linux_do_id, username, keys_count, total_quota_added, timestamp, push_status, push_message, failed_keys) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
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
        getByTimestamp: db.query<DonateRecord, [string, number]>(
            'SELECT * FROM donate_records WHERE linux_do_id = ? AND timestamp = ?'
        ),
        update: db.query(
            'UPDATE donate_records SET push_status = ?, push_message = ?, failed_keys = ? WHERE linux_do_id = ? AND timestamp = ?'
        ),
    };

    // 已使用的 Key 相关
    keyQueries = {
        isUsed: db.query<{ count: number }, string>(
            'SELECT COUNT(*) as count FROM used_keys WHERE key = ?'
        ),
        insert: db.query(
            'INSERT INTO used_keys (key, linux_do_id, username, timestamp) VALUES (?, ?, ?, ?)'
        ),
        getAll: db.query<
            { key: string; linux_do_id: string; username: string; timestamp: number },
            never
        >('SELECT * FROM used_keys ORDER BY timestamp DESC'),
        delete: db.query('DELETE FROM used_keys WHERE key = ?'),
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
            'UPDATE admin_config SET session = ?, new_api_user = ?, claim_quota = ?, max_daily_claims = ?, keys_api_url = ?, keys_authorization = ?, group_id = ?, updated_at = ? WHERE id = 1'
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

    console.log('✅ 数据库查询语句已预编译');
}

