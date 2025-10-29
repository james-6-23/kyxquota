import { Database } from 'bun:sqlite';

export function up(db: Database): void {
  console.log('创建坤呗梯度配置表...');
  
  // 创建梯度配置表
  db.run(`
    CREATE TABLE IF NOT EXISTS kunbei_gradient_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quota_threshold INTEGER NOT NULL,  -- 额度阈值
      max_loan_amount INTEGER NOT NULL,  -- 最大可借金额
      priority INTEGER NOT NULL DEFAULT 0, -- 优先级，数字越大优先级越高
      is_active BOOLEAN NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 创建索引
  db.run('CREATE INDEX IF NOT EXISTS idx_kunbei_gradient_priority ON kunbei_gradient_configs(priority DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_kunbei_gradient_active ON kunbei_gradient_configs(is_active)');
  
  // 插入默认梯度配置
  db.run(`
    INSERT INTO kunbei_gradient_configs (quota_threshold, max_loan_amount, priority)
    VALUES 
      (10000, 10000, 1),    -- 余额小于10000时，可借10000
      (100000, 100000, 2)   -- 余额小于100000时，可借100000
  `);
  
  // 在坤呗配置表中添加逾期扣除所有额度的开关
  db.run(`
    ALTER TABLE kunbei_config 
    ADD COLUMN deduct_all_quota_on_overdue BOOLEAN NOT NULL DEFAULT 1
  `);
  
  console.log('坤呗梯度配置表创建完成');
}

export function down(db: Database): void {
  console.log('回滚坤呗梯度配置...');
  
  db.run('DROP TABLE IF EXISTS kunbei_gradient_configs');
  
  // SQLite不支持删除列，需要重建表
  db.run(`
    CREATE TABLE kunbei_config_new (
      id INTEGER PRIMARY KEY,
      max_loan_amount INTEGER NOT NULL DEFAULT 50000000,
      interest_rate REAL NOT NULL DEFAULT 0.02,
      loan_duration_hours INTEGER NOT NULL DEFAULT 48,
      early_repay_discount REAL NOT NULL DEFAULT 0.1,
      overdue_penalty_rate REAL NOT NULL DEFAULT 0.3,
      min_loan_amount INTEGER NOT NULL DEFAULT 1000000,
      loan_step INTEGER NOT NULL DEFAULT 1000000,
      free_trial_amount INTEGER NOT NULL DEFAULT 10000000,
      ban_duration_hours INTEGER NOT NULL DEFAULT 168,
      max_credit_score INTEGER NOT NULL DEFAULT 150,
      min_credit_score INTEGER NOT NULL DEFAULT 50,
      default_credit_score INTEGER NOT NULL DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    INSERT INTO kunbei_config_new SELECT 
      id, max_loan_amount, interest_rate, loan_duration_hours, 
      early_repay_discount, overdue_penalty_rate, min_loan_amount, 
      loan_step, free_trial_amount, ban_duration_hours, 
      max_credit_score, min_credit_score, default_credit_score,
      created_at, updated_at
    FROM kunbei_config
  `);
  
  db.run('DROP TABLE kunbei_config');
  db.run('ALTER TABLE kunbei_config_new RENAME TO kunbei_config');
  
  console.log('坤呗梯度配置回滚完成');
}
