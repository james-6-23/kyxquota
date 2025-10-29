/**
 * 坤呗借款系统数据库迁移
 */

export function addKunbeiLoanTables(db: any) {
    console.log('📦 创建坤呗借款系统表...');

    // 坤呗配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS kunbei_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,                      -- 是否启用
            max_loan_amount INTEGER DEFAULT 50000000,       -- 最大借款额度（默认$100）
            min_loan_amount INTEGER DEFAULT 5000000,        -- 最小借款额度（默认$10）
            repay_multiplier REAL DEFAULT 2.5,              -- 还款倍数（默认2.5倍）
            loan_duration_hours INTEGER DEFAULT 72,         -- 借款期限（默认72小时=3天）
            early_repay_discount REAL DEFAULT 0.025,        -- 提前还款优惠（默认2.5%）
            overdue_penalty_hours INTEGER DEFAULT 60,       -- 逾期惩罚时长（默认60小时=2.5天）
            overdue_ban_advanced INTEGER DEFAULT 1,         -- 逾期是否禁止高级场（1=是）
            max_active_loans INTEGER DEFAULT 1,             -- 最多同时借款数（默认1笔）
            updated_at INTEGER NOT NULL
        )
    `);

    // 插入默认配置
    const now = Date.now();
    db.exec(`
        INSERT OR IGNORE INTO kunbei_config (
            id, enabled, max_loan_amount, min_loan_amount, repay_multiplier,
            loan_duration_hours, early_repay_discount, overdue_penalty_hours,
            overdue_ban_advanced, max_active_loans, updated_at
        )
        VALUES (1, 1, 50000000, 5000000, 2.5, 72, 0.025, 60, 1, 1, ${now})
    `);

    // 用户借款记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_loans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            loan_amount INTEGER NOT NULL,                   -- 借款金额
            repay_amount INTEGER NOT NULL,                  -- 应还金额
            actual_repay_amount INTEGER,                    -- 实际还款金额
            status TEXT DEFAULT 'active',                   -- 状态：active(借款中), repaid(已还款), overdue(逾期)
            borrowed_at INTEGER NOT NULL,                   -- 借款时间
            due_at INTEGER NOT NULL,                        -- 应还时间
            repaid_at INTEGER,                              -- 实际还款时间
            overdue_penalty_until INTEGER,                  -- 逾期惩罚截止时间
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_linux_do_id ON user_loans(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_status ON user_loans(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_due_at ON user_loans(due_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_loans_created_at ON user_loans(created_at)');

    // 用户坤呗统计表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_kunbei_stats (
            linux_do_id TEXT PRIMARY KEY,
            total_borrowed INTEGER DEFAULT 0,               -- 累计借款总额
            total_repaid INTEGER DEFAULT 0,                 -- 累计还款总额
            total_loans INTEGER DEFAULT 0,                  -- 总借款次数
            repaid_loans INTEGER DEFAULT 0,                 -- 已还款次数
            overdue_loans INTEGER DEFAULT 0,                -- 逾期次数
            credit_score INTEGER DEFAULT 100,               -- 信用分（100为满分）
            is_banned INTEGER DEFAULT 0,                    -- 是否被禁用坤呗
            last_borrow_date TEXT,                          -- 最后借款日期（YYYY-MM-DD）
            has_daily_buff INTEGER DEFAULT 0,               -- 今日是否有buff（1=有）
            buff_multiplier REAL DEFAULT 2.5,               -- buff倍率
            buff_used INTEGER DEFAULT 0,                    -- buff是否已使用（1=已用）
            updated_at INTEGER NOT NULL
        )
    `);

    console.log('✅ 坤呗借款系统表创建完成');
}

