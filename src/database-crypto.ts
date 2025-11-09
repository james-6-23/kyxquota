import { db } from './database';
import type {
    TradingPair,
    UserAsset,
    TradeOrder,
    TradeFill,
    KlineData,
    MarginPosition,
    MarginLoan,
    LiquidationRecord,
    UserDailyCryptoLimit,
    CryptoConfig,
    ExchangeRecord,
} from './types-crypto';
import { logger } from './utils/logger';

/**
 * 初始化交易系统数据库表
 */
export function initCryptoDatabase() {
    logger.info('DatabaseCrypto', '初始化虚拟币交易系统数据库...');

    // 1. 虚拟币系统配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS crypto_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enabled INTEGER DEFAULT 1,
            coin_name TEXT DEFAULT '坤币',
            coin_symbol TEXT DEFAULT 'KC',
            exchange_rate REAL DEFAULT 10000,
            min_exchange_quota REAL DEFAULT 10000,
            max_exchange_quota REAL DEFAULT 10000000,
            exchange_fee_rate REAL DEFAULT 0.01,
            max_daily_exchange_quota REAL DEFAULT 50000000,
            max_daily_trades INTEGER DEFAULT 100,
            price_fluctuation_limit REAL DEFAULT 0.1,
            max_orders_per_user INTEGER DEFAULT 20,
            max_position_value_ratio REAL DEFAULT 0.5,
            updated_at INTEGER NOT NULL
        )
    `);

    // 初始化默认配置
    const configCount = db.query('SELECT COUNT(*) as count FROM crypto_config').get() as { count: number };
    if (configCount.count === 0) {
        db.run(`
            INSERT INTO crypto_config (
                enabled, coin_name, coin_symbol, exchange_rate,
                min_exchange_quota, max_exchange_quota, exchange_fee_rate,
                max_daily_exchange_quota, max_daily_trades, price_fluctuation_limit,
                max_orders_per_user, max_position_value_ratio, updated_at
            ) VALUES (1, '坤币', 'KC', 10000, 10000, 10000000, 0.01, 50000000, 100, 0.1, 20, 0.5, ?)
        `, [Date.now()]);
        logger.info('DatabaseCrypto', '已创建默认交易系统配置');
    }

    // 2. 交易对配置表
    db.exec(`
        CREATE TABLE IF NOT EXISTS trading_pairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT UNIQUE NOT NULL,
            base_currency TEXT NOT NULL,
            quote_currency TEXT NOT NULL,
            min_order_amount REAL NOT NULL,
            max_order_amount REAL NOT NULL,
            price_precision INTEGER DEFAULT 2,
            amount_precision INTEGER DEFAULT 4,
            taker_fee_rate REAL DEFAULT 0.001,
            maker_fee_rate REAL DEFAULT 0.0005,
            enabled INTEGER DEFAULT 1,
            max_leverage INTEGER DEFAULT 10,
            maintenance_margin_rate REAL DEFAULT 0.05,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trading_pairs_symbol ON trading_pairs(symbol)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trading_pairs_enabled ON trading_pairs(enabled)');

    // 初始化默认交易对 KC/QUOTA
    const pairCount = db.query('SELECT COUNT(*) as count FROM trading_pairs WHERE symbol = ?').get('KC/QUOTA') as { count: number };
    if (pairCount.count === 0) {
        db.run(`
            INSERT INTO trading_pairs (
                symbol, base_currency, quote_currency, min_order_amount, max_order_amount,
                price_precision, amount_precision, taker_fee_rate, maker_fee_rate,
                enabled, max_leverage, maintenance_margin_rate, created_at, updated_at
            ) VALUES ('KC/QUOTA', 'KC', 'QUOTA', 0.01, 10000, 2, 4, 0.001, 0.0005, 1, 10, 0.05, ?, ?)
        `, [Date.now(), Date.now()]);
        logger.info('DatabaseCrypto', '已创建默认交易对 KC/QUOTA');
    }

    // 3. 用户资产表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            account_type TEXT NOT NULL CHECK(account_type IN ('spot', 'margin')),
            currency TEXT NOT NULL,
            available_balance REAL DEFAULT 0,
            frozen_balance REAL DEFAULT 0,
            borrowed_balance REAL DEFAULT 0,
            interest_balance REAL DEFAULT 0,
            total_balance REAL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            UNIQUE(linux_do_id, account_type, currency)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_assets_linux_do_id ON user_assets(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_assets_account_type ON user_assets(account_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_assets_currency ON user_assets(currency)');

    // 4. 委托订单表
    db.exec(`
        CREATE TABLE IF NOT EXISTS trade_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE NOT NULL,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            symbol TEXT NOT NULL,
            order_type TEXT NOT NULL CHECK(order_type IN ('limit', 'market', 'stop_limit')),
            side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
            price REAL NOT NULL,
            amount REAL NOT NULL,
            filled_amount REAL DEFAULT 0,
            unfilled_amount REAL NOT NULL,
            total_value REAL NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'partial_filled', 'filled', 'cancelled', 'expired')),
            leverage INTEGER DEFAULT 1,
            margin_mode TEXT CHECK(margin_mode IN ('isolated', 'cross') OR margin_mode IS NULL),
            trigger_price REAL,
            fee_amount REAL DEFAULT 0,
            role TEXT CHECK(role IN ('maker', 'taker') OR role IS NULL),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            filled_at INTEGER,
            cancelled_at INTEGER
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_order_id ON trade_orders(order_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_linux_do_id ON trade_orders(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_symbol ON trade_orders(symbol)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_status ON trade_orders(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_side ON trade_orders(side)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_orders_created_at ON trade_orders(created_at)');

    // 5. 成交记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS trade_fills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id TEXT UNIQUE NOT NULL,
            symbol TEXT NOT NULL,
            buy_order_id TEXT NOT NULL,
            sell_order_id TEXT NOT NULL,
            buyer_id TEXT NOT NULL,
            seller_id TEXT NOT NULL,
            buyer_username TEXT NOT NULL,
            seller_username TEXT NOT NULL,
            price REAL NOT NULL,
            amount REAL NOT NULL,
            total_value REAL NOT NULL,
            buyer_fee REAL NOT NULL,
            seller_fee REAL NOT NULL,
            buyer_role TEXT NOT NULL CHECK(buyer_role IN ('maker', 'taker')),
            seller_role TEXT NOT NULL CHECK(seller_role IN ('maker', 'taker')),
            timestamp INTEGER NOT NULL,
            date TEXT NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_fills_symbol ON trade_fills(symbol)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_fills_buyer_id ON trade_fills(buyer_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_fills_seller_id ON trade_fills(seller_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_fills_timestamp ON trade_fills(timestamp)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trade_fills_date ON trade_fills(date)');

    // 6. K线数据表
    db.exec(`
        CREATE TABLE IF NOT EXISTS kline_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL CHECK(interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
            timestamp INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            quote_volume REAL NOT NULL,
            trades_count INTEGER DEFAULT 0,
            UNIQUE(symbol, interval, timestamp)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_kline_symbol_interval ON kline_data(symbol, interval)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kline_timestamp ON kline_data(timestamp)');

    // 7. 杠杆持仓表
    db.exec(`
        CREATE TABLE IF NOT EXISTS margin_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position_id TEXT UNIQUE NOT NULL,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('long', 'short')),
            leverage INTEGER NOT NULL,
            margin_mode TEXT NOT NULL CHECK(margin_mode IN ('isolated', 'cross')),
            entry_price REAL NOT NULL,
            amount REAL NOT NULL,
            margin_balance REAL NOT NULL,
            borrowed_amount REAL NOT NULL,
            interest_rate REAL NOT NULL,
            accumulated_interest REAL DEFAULT 0,
            unrealized_pnl REAL DEFAULT 0,
            liquidation_price REAL NOT NULL,
            maintenance_margin REAL NOT NULL,
            status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'liquidated')),
            opened_at INTEGER NOT NULL,
            closed_at INTEGER,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_positions_position_id ON margin_positions(position_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_positions_linux_do_id ON margin_positions(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_positions_status ON margin_positions(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_positions_symbol ON margin_positions(symbol)');

    // 8. 借贷记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS margin_loans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loan_id TEXT UNIQUE NOT NULL,
            linux_do_id TEXT NOT NULL,
            currency TEXT NOT NULL,
            loan_amount REAL NOT NULL,
            interest_rate REAL NOT NULL,
            accumulated_interest REAL DEFAULT 0,
            repaid_principal REAL DEFAULT 0,
            repaid_interest REAL DEFAULT 0,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'repaid')),
            borrowed_at INTEGER NOT NULL,
            repaid_at INTEGER,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_loans_linux_do_id ON margin_loans(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_margin_loans_status ON margin_loans(status)');

    // 9. 爆仓记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS liquidation_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            position_id TEXT NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('long', 'short')),
            leverage INTEGER NOT NULL,
            entry_price REAL NOT NULL,
            liquidation_price REAL NOT NULL,
            position_amount REAL NOT NULL,
            loss_amount REAL NOT NULL,
            liquidation_fee REAL NOT NULL,
            timestamp INTEGER NOT NULL,
            date TEXT NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_liquidation_records_linux_do_id ON liquidation_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_liquidation_records_timestamp ON liquidation_records(timestamp)');

    // 10. 用户每日交易限制表
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_daily_crypto_limits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            limit_date TEXT NOT NULL,
            orders_count INTEGER DEFAULT 0,
            trades_count INTEGER DEFAULT 0,
            total_trade_volume REAL DEFAULT 0,
            last_order_time INTEGER,
            last_trade_time INTEGER,
            UNIQUE(linux_do_id, limit_date)
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_daily_crypto_limits_linux_do_id ON user_daily_crypto_limits(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_daily_crypto_limits_limit_date ON user_daily_crypto_limits(limit_date)');

    // 11. 兑换记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS exchange_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            linux_do_id TEXT NOT NULL,
            username TEXT NOT NULL,
            exchange_type TEXT NOT NULL CHECK(exchange_type IN ('quota_to_coin', 'coin_to_quota')),
            quota_amount REAL NOT NULL,
            coin_amount REAL NOT NULL,
            exchange_rate REAL NOT NULL,
            fee_amount REAL NOT NULL,
            actual_received REAL NOT NULL,
            timestamp INTEGER NOT NULL,
            date TEXT NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_exchange_records_linux_do_id ON exchange_records(linux_do_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_exchange_records_timestamp ON exchange_records(timestamp)');

    logger.info('DatabaseCrypto', '虚拟币交易系统数据库初始化完成');
}

// ========== 辅助函数 ==========

/**
 * 生成唯一ID
 */
export function generateId(prefix: string = ''): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${prefix}${timestamp}${random}`.toUpperCase();
}

/**
 * 获取今天的日期字符串 (YYYY-MM-DD)
 */
export function getTodayDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ========== 配置操作 ==========

/**
 * 获取交易系统配置
 */
export function getCryptoConfig(): CryptoConfig | null {
    const stmt = db.query('SELECT * FROM crypto_config WHERE id = 1');
    return stmt.get() as CryptoConfig | null;
}

/**
 * 更新交易系统配置
 */
export function updateCryptoConfig(config: Partial<CryptoConfig>): void {
    const fields = Object.keys(config).filter(k => k !== 'id').map(k => `${k} = ?`).join(', ');
    const values = Object.keys(config).filter(k => k !== 'id').map(k => (config as any)[k]);
    values.push(Date.now());
    
    db.run(`UPDATE crypto_config SET ${fields}, updated_at = ? WHERE id = 1`, values);
}

// ========== 交易对操作 ==========

/**
 * 获取交易对
 */
export function getTradingPair(symbol: string): TradingPair | null {
    const stmt = db.query('SELECT * FROM trading_pairs WHERE symbol = ? AND enabled = 1');
    return stmt.get(symbol) as TradingPair | null;
}

/**
 * 获取所有启用的交易对
 */
export function getAllTradingPairs(): TradingPair[] {
    const stmt = db.query('SELECT * FROM trading_pairs WHERE enabled = 1');
    return stmt.all() as TradingPair[];
}

// ========== 用户资产操作 ==========

/**
 * 获取或创建用户资产
 */
export function getUserAsset(
    linuxDoId: string,
    accountType: 'spot' | 'margin',
    currency: string
): UserAsset {
    let asset = db.query(
        'SELECT * FROM user_assets WHERE linux_do_id = ? AND account_type = ? AND currency = ?'
    ).get(linuxDoId, accountType, currency) as UserAsset | null;

    if (!asset) {
        // 创建新资产记录
        db.run(`
            INSERT INTO user_assets (
                linux_do_id, account_type, currency, available_balance, frozen_balance,
                borrowed_balance, interest_balance, total_balance, updated_at
            ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?)
        `, [linuxDoId, accountType, currency, Date.now()]);

        asset = db.query(
            'SELECT * FROM user_assets WHERE linux_do_id = ? AND account_type = ? AND currency = ?'
        ).get(linuxDoId, accountType, currency) as UserAsset;
    }

    return asset!;
}

/**
 * 更新用户资产
 */
export function updateUserAsset(
    linuxDoId: string,
    accountType: 'spot' | 'margin',
    currency: string,
    updates: Partial<UserAsset>
): void {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.keys(updates).map(k => (updates as any)[k]);
    
    db.run(`
        UPDATE user_assets 
        SET ${fields}, updated_at = ? 
        WHERE linux_do_id = ? AND account_type = ? AND currency = ?
    `, [...values, Date.now(), linuxDoId, accountType, currency]);
}

/**
 * 获取用户所有资产
 */
export function getUserAllAssets(linuxDoId: string): UserAsset[] {
    const stmt = db.query('SELECT * FROM user_assets WHERE linux_do_id = ?');
    return stmt.all(linuxDoId) as UserAsset[];
}

// 更多数据库操作将在后续实现...

