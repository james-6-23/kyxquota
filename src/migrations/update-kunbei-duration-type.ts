import { Database } from 'bun:sqlite';

export function up(db: Database): void {
    console.log('更新坤呗借款期限字段类型为支持小数...');

    // SQLite不支持直接修改列类型，需要重建表
    // 1. 创建新的坤呗配置表
    db.run(`
    CREATE TABLE kunbei_config_new (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_loan_amount INTEGER NOT NULL DEFAULT 50000000,
      min_loan_amount INTEGER NOT NULL DEFAULT 5000000,
      repay_multiplier REAL NOT NULL DEFAULT 2.5,
      loan_duration_hours REAL NOT NULL DEFAULT 72,          -- 修改为REAL类型，支持小数
      early_repay_discount REAL NOT NULL DEFAULT 0.025,
      overdue_penalty_hours INTEGER NOT NULL DEFAULT 60,
      overdue_ban_advanced INTEGER NOT NULL DEFAULT 1,
      max_active_loans INTEGER NOT NULL DEFAULT 1,
      deduct_all_quota_on_overdue INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

    // 2. 复制数据到新表
    db.run(`
    INSERT INTO kunbei_config_new 
    SELECT 
      id, enabled, max_loan_amount, min_loan_amount, repay_multiplier,
      CAST(loan_duration_hours AS REAL),  -- 确保转换为REAL
      early_repay_discount, overdue_penalty_hours, overdue_ban_advanced,
      max_active_loans, 
      COALESCE(deduct_all_quota_on_overdue, 1),  -- 处理可能的NULL值
      updated_at
    FROM kunbei_config
  `);

    // 3. 删除旧表
    db.run('DROP TABLE kunbei_config');

    // 4. 重命名新表
    db.run('ALTER TABLE kunbei_config_new RENAME TO kunbei_config');

    console.log('坤呗借款期限字段类型更新完成，现在支持小数时长');
}

export function down(db: Database): void {
    console.log('回滚坤呗借款期限字段类型...');

    // 回滚时将REAL改回INTEGER
    db.run(`
    CREATE TABLE kunbei_config_new (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_loan_amount INTEGER NOT NULL DEFAULT 50000000,
      min_loan_amount INTEGER NOT NULL DEFAULT 5000000,
      repay_multiplier REAL NOT NULL DEFAULT 2.5,
      loan_duration_hours INTEGER NOT NULL DEFAULT 72,        -- 改回INTEGER类型
      early_repay_discount REAL NOT NULL DEFAULT 0.025,
      overdue_penalty_hours INTEGER NOT NULL DEFAULT 60,
      overdue_ban_advanced INTEGER NOT NULL DEFAULT 1,
      max_active_loans INTEGER NOT NULL DEFAULT 1,
      deduct_all_quota_on_overdue INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

    db.run(`
    INSERT INTO kunbei_config_new 
    SELECT 
      id, enabled, max_loan_amount, min_loan_amount, repay_multiplier,
      CAST(loan_duration_hours AS INTEGER),  -- 转换为整数
      early_repay_discount, overdue_penalty_hours, overdue_ban_advanced,
      max_active_loans, deduct_all_quota_on_overdue, updated_at
    FROM kunbei_config
  `);

    db.run('DROP TABLE kunbei_config');
    db.run('ALTER TABLE kunbei_config_new RENAME TO kunbei_config');

    console.log('坤呗借款期限字段类型回滚完成');
}
