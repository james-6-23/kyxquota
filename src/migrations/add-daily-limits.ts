/**
 * 添加每日进入高级场限制功能的数据库迁移
 */

import { Database } from 'bun:sqlite';

export function addDailyLimits(db: Database) {
    console.log('[迁移] 添加每日进入高级场限制功能...');

    try {
        // 1. 在高级场配置表中添加新字段（检查字段是否已存在）
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

        console.log('[迁移] ✅ 每日限制功能迁移完成');
        return true;
    } catch (error) {
        console.error('[迁移] ❌ 迁移失败:', error);
        return false;
    }
}
