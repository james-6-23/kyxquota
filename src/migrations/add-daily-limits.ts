/**
 * 添加每日进入高级场限制功能的数据库迁移
 */

import { Database } from 'bun:sqlite';

export function addDailyLimits(db: Database) {
    console.log('[迁移] 添加每日进入高级场限制功能...');

    try {
        // 1. 首先检查是否存在 advanced_slot_config 表（兼容旧系统）
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='advanced_slot_config'").all();
        const hasAdvancedSlotConfig = tables.length > 0;

        if (!hasAdvancedSlotConfig) {
            console.log('[迁移] ⚠️  检测到旧系统，需要先创建高级场相关表...');
            createAdvancedSlotTables(db);
            console.log('[迁移] ✅ 高级场基础表创建完成');
            // 创建新表后，不需要继续添加字段，因为新表已包含所有字段
            return true;
        }

        // 2. 表存在时，检查是否需要添加新字段
        const columns = db.prepare("PRAGMA table_info(advanced_slot_config)").all();
        const hasEntryLimit = columns.some((col: any) => col.name === 'daily_entry_limit');
        const hasTicketGrantLimit = columns.some((col: any) => col.name === 'daily_ticket_grant_limit');

        if (!hasEntryLimit) {
            // 添加每日进入次数限制字段（默认2次）
            db.exec(`
                ALTER TABLE advanced_slot_config 
                ADD COLUMN daily_entry_limit INTEGER DEFAULT 2
            `);
            console.log('[迁移] ✅ 添加 daily_entry_limit 字段');
        } else {
            console.log('[迁移] ℹ️  daily_entry_limit 字段已存在');
        }

        if (!hasTicketGrantLimit) {
            // 添加每日入场券获得数量限制字段（默认2张）
            db.exec(`
                ALTER TABLE advanced_slot_config 
                ADD COLUMN daily_ticket_grant_limit INTEGER DEFAULT 2
            `);
            console.log('[迁移] ✅ 添加 daily_ticket_grant_limit 字段');
        } else {
            console.log('[迁移] ℹ️  daily_ticket_grant_limit 字段已存在');
        }

        // 2. 创建用户每日进入高级场记录表
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
        console.log('[迁移] ✅ 创建 user_advanced_entries 表');

        // 3. 创建用户每日入场券获得记录表
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
        console.log('[迁移] ✅ 创建 user_daily_ticket_grants 表');

        // 4. 检查并添加 slot_mode 字段到游戏记录表（兼容旧系统）
        const slotRecordsColumns = db.prepare("PRAGMA table_info(slot_machine_records)").all();
        const hasSlotMode = slotRecordsColumns.some((col: any) => col.name === 'slot_mode');

        if (!hasSlotMode) {
            db.exec(`
                ALTER TABLE slot_machine_records 
                ADD COLUMN slot_mode TEXT DEFAULT 'normal'
            `);
            db.exec('CREATE INDEX IF NOT EXISTS idx_slot_records_mode ON slot_machine_records(slot_mode)');
            console.log('[迁移] ✅ 添加 slot_mode 字段到游戏记录表');
        }

        console.log('[迁移] ✅ 每日限制功能迁移完成');
        return true;
    } catch (error) {
        console.error('[迁移] ❌ 迁移失败:', error);
        return false;
    }
}

/**
 * 为旧系统创建高级场相关的所有表
 */
function createAdvancedSlotTables(db: Database) {
    // 1. 创建用户入场券和碎片表
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

    // 2. 创建高级场配置表（包含所有新字段）
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

    // 3. 创建高级场符号权重配置表
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
            updated_at INTEGER NOT NULL
        )
    `);

    // 4. 创建入场券掉落记录表
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_drops_user ON ticket_drop_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_drops_date ON ticket_drop_records(date)');

    // 5. 创建高级场RTP统计表
    db.exec(`
        CREATE TABLE IF NOT EXISTS advanced_slot_rtp_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT UNIQUE NOT NULL,
            total_bet INTEGER DEFAULT 0,
            total_win INTEGER DEFAULT 0,
            rtp REAL DEFAULT 0.0,
            games_count INTEGER DEFAULT 0,
            last_updated INTEGER NOT NULL
        )
    `);

    // 6. 插入默认配置数据
    const now = Date.now();

    // 插入默认高级场配置
    db.exec(`
        INSERT OR IGNORE INTO advanced_slot_config (
            id, enabled, bet_min, bet_max, reward_multiplier, penalty_weight_factor, 
            rtp_target, ticket_valid_hours, session_valid_hours, fragments_needed, 
            drop_rate_triple, drop_rate_double, max_tickets_hold, daily_bet_limit, 
            daily_entry_limit, daily_ticket_grant_limit, updated_at
        )
        VALUES (1, 1, 50000000, 250000000, 4.0, 2.0, 0.95, 24, 24, 5, 1.0, 1.0, 2, 5000000000, 2, 2, ${now})
    `);

    // 插入默认高级场符号权重配置
    db.exec(`
        INSERT OR IGNORE INTO advanced_slot_symbol_weights (
            id, weight_m, weight_t, weight_n, weight_j, weight_lq, weight_bj, 
            weight_zft, weight_bdk, weight_lsh, updated_at
        )
        VALUES (1, 100, 100, 100, 100, 100, 100, 100, 100, 50, ${now})
    `);

    console.log('[迁移] ✅ 高级场所有基础表和默认数据创建完成');
}
