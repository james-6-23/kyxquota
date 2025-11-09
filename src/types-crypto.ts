// ========== 虚拟币交易系统类型定义 ==========

// 1. 交易对配置
export interface TradingPair {
    id?: number;
    symbol: string;                       // 交易对符号，如 KC/QUOTA
    base_currency: string;                // 基础货币（KC）
    quote_currency: string;               // 计价货币（QUOTA）
    min_order_amount: number;             // 最小订单金额
    max_order_amount: number;             // 最大订单金额
    price_precision: number;              // 价格精度（小数位数）
    amount_precision: number;             // 数量精度
    taker_fee_rate: number;               // Taker手续费率
    maker_fee_rate: number;               // Maker手续费率
    enabled: number;                      // 是否启用
    max_leverage: number;                 // 最大杠杆倍数
    maintenance_margin_rate: number;      // 维持保证金率
    created_at: number;
    updated_at: number;
}

// 2. 用户资产
export interface UserAsset {
    id?: number;
    linux_do_id: string;
    account_type: 'spot' | 'margin';      // 账户类型：现货/杠杆
    currency: string;                     // 币种（KC 或 QUOTA）
    available_balance: number;            // 可用余额
    frozen_balance: number;               // 冻结余额（挂单中）
    borrowed_balance: number;             // 借款余额（仅杠杆账户）
    interest_balance: number;             // 未还利息（仅杠杆账户）
    total_balance: number;                // 总余额
    updated_at: number;
}

// 3. 委托订单
export interface TradeOrder {
    id?: number;
    order_id: string;                     // 订单唯一ID
    linux_do_id: string;
    username: string;
    symbol: string;                       // 交易对
    order_type: 'limit' | 'market' | 'stop_limit';
    side: 'buy' | 'sell';                 // 买/卖
    price: number;                        // 委托价格
    amount: number;                       // 委托数量
    filled_amount: number;                // 已成交数量
    unfilled_amount: number;              // 未成交数量
    total_value: number;                  // 总价值
    status: 'pending' | 'partial_filled' | 'filled' | 'cancelled' | 'expired';
    leverage: number;                     // 杠杆倍数（1=现货）
    margin_mode: 'isolated' | 'cross' | null;  // 保证金模式
    trigger_price: number | null;         // 触发价格（止盈止损）
    fee_amount: number;                   // 手续费
    role: 'maker' | 'taker' | null;       // Maker/Taker
    created_at: number;
    updated_at: number;
    filled_at: number | null;             // 完全成交时间
    cancelled_at: number | null;
}

// 4. 成交记录
export interface TradeFill {
    id?: number;
    trade_id: string;                     // 成交ID
    symbol: string;
    buy_order_id: string;                 // 买单ID
    sell_order_id: string;                // 卖单ID
    buyer_id: string;
    seller_id: string;
    buyer_username: string;
    seller_username: string;
    price: number;                        // 成交价格
    amount: number;                       // 成交数量
    total_value: number;                  // 成交金额
    buyer_fee: number;                    // 买方手续费
    seller_fee: number;                   // 卖方手续费
    buyer_role: 'maker' | 'taker';
    seller_role: 'maker' | 'taker';
    timestamp: number;
    date: string;                         // YYYY-MM-DD
}

// 5. K线数据
export interface KlineData {
    id?: number;
    symbol: string;                       // 交易对
    interval: string;                     // 周期：1m, 5m, 15m, 1h, 4h, 1d
    timestamp: number;                    // K线开始时间戳
    open: number;                         // 开盘价
    high: number;                         // 最高价
    low: number;                          // 最低价
    close: number;                        // 收盘价
    volume: number;                       // 成交量
    quote_volume: number;                 // 成交额
    trades_count: number;                 // 成交笔数
}

// 6. 杠杆持仓
export interface MarginPosition {
    id?: number;
    position_id: string;                  // 持仓ID
    linux_do_id: string;
    username: string;
    symbol: string;
    side: 'long' | 'short';               // 多头/空头
    leverage: number;                     // 杠杆倍数
    margin_mode: 'isolated' | 'cross';    // 保证金模式
    entry_price: number;                  // 开仓均价
    amount: number;                       // 持仓数量
    margin_balance: number;               // 保证金余额
    borrowed_amount: number;              // 借款金额
    interest_rate: number;                // 利率（小时）
    accumulated_interest: number;         // 累计利息
    unrealized_pnl: number;               // 未实现盈亏
    liquidation_price: number;            // 爆仓价格
    maintenance_margin: number;           // 维持保证金
    status: 'open' | 'closed' | 'liquidated';
    opened_at: number;
    closed_at: number | null;
    updated_at: number;
}

// 7. 借贷记录
export interface MarginLoan {
    id?: number;
    loan_id: string;
    linux_do_id: string;
    currency: string;                     // 借款币种
    loan_amount: number;                  // 借款金额
    interest_rate: number;                // 利率（每小时）
    accumulated_interest: number;         // 累计利息
    repaid_principal: number;             // 已还本金
    repaid_interest: number;              // 已还利息
    status: 'active' | 'repaid';
    borrowed_at: number;
    repaid_at: number | null;
    updated_at: number;
}

// 8. 爆仓记录
export interface LiquidationRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    position_id: string;
    symbol: string;
    side: 'long' | 'short';
    leverage: number;
    entry_price: number;
    liquidation_price: number;
    position_amount: number;
    loss_amount: number;                  // 亏损金额
    liquidation_fee: number;              // 爆仓手续费
    timestamp: number;
    date: string;                         // YYYY-MM-DD
}

// 9. 订单簿快照（用于Redis缓存）
export interface OrderbookSnapshot {
    symbol: string;
    bids: [number, number][];             // [[price, amount], ...]
    asks: [number, number][];             // [[price, amount], ...]
    timestamp: number;
}

// 10. 用户每日交易限制
export interface UserDailyCryptoLimit {
    id?: number;
    linux_do_id: string;
    limit_date: string;                   // YYYY-MM-DD
    orders_count: number;                 // 今日下单次数
    trades_count: number;                 // 今日成交次数
    total_trade_volume: number;           // 今日成交量
    last_order_time: number;
    last_trade_time: number;
}

// 11. 虚拟币系统配置
export interface CryptoConfig {
    id?: number;
    enabled: number;                      // 是否启用交易系统
    coin_name: string;                    // 虚拟币名称（如：坤币）
    coin_symbol: string;                  // 虚拟币符号（如：KC）
    exchange_rate: number;                // quota兑换虚拟币比率（1 KC = ? quota）
    min_exchange_quota: number;           // 最小兑换额度
    max_exchange_quota: number;           // 最大兑换额度
    exchange_fee_rate: number;            // 兑换手续费率（0-1）
    max_daily_exchange_quota: number;     // 每日最大兑换quota
    max_daily_trades: number;             // 每日最大交易次数
    price_fluctuation_limit: number;      // 价格波动限制（±%）
    max_orders_per_user: number;          // 单用户最大挂单数
    max_position_value_ratio: number;     // 最大持仓价值比例
    updated_at: number;
}

// 12. 兑换记录
export interface ExchangeRecord {
    id?: number;
    linux_do_id: string;
    username: string;
    exchange_type: 'quota_to_coin' | 'coin_to_quota';  // 兑换方向
    quota_amount: number;                 // quota数量
    coin_amount: number;                  // 虚拟币数量
    exchange_rate: number;                // 兑换汇率
    fee_amount: number;                   // 手续费
    actual_received: number;              // 实际到账
    timestamp: number;
    date: string;                         // YYYY-MM-DD
}

// ========== WebSocket消息类型 ==========

// WebSocket消息基础格式
export interface WebSocketMessage {
    type: 'subscribe' | 'unsubscribe' | 'ticker' | 'kline' | 'depth' | 'trade' | 'order' | 'position' | 'error' | 'pong';
    channel?: string;
    data?: any;
    timestamp?: number;
}

// 行情数据
export interface TickerData {
    symbol: string;
    last_price: number;
    price_change_24h: number;
    price_change_percent_24h: number;
    high_24h: number;
    low_24h: number;
    volume_24h: number;
    quote_volume_24h: number;
    timestamp: number;
}

// 深度数据
export interface DepthData {
    symbol: string;
    bids: [number, number][];             // [[price, amount], ...]
    asks: [number, number][];
    timestamp: number;
}

// 最新成交
export interface TradeData {
    trade_id: string;
    symbol: string;
    price: number;
    amount: number;
    side: 'buy' | 'sell';
    timestamp: number;
}

// ========== 辅助类型 ==========

// 订单创建参数
export interface CreateOrderParams {
    symbol: string;
    order_type: 'limit' | 'market';
    side: 'buy' | 'sell';
    price?: number;                       // 限价单必填
    amount: number;
    leverage?: number;                    // 杠杆倍数，默认1（现货）
    margin_mode?: 'isolated' | 'cross';   // 保证金模式
}

// 持仓开仓参数
export interface OpenPositionParams {
    symbol: string;
    side: 'long' | 'short';
    amount: number;
    leverage: number;
    margin_mode: 'isolated' | 'cross';
}

// 市场统计数据
export interface MarketStats {
    symbol: string;
    total_orders: number;
    total_trades: number;
    total_volume_24h: number;
    active_users_24h: number;
    open_positions: number;
    total_liquidations_24h: number;
}

// 用户交易统计
export interface UserTradingStats {
    linux_do_id: string;
    total_orders: number;
    total_trades: number;
    total_volume: number;
    total_profit: number;
    win_rate: number;
    avg_profit_per_trade: number;
    max_profit: number;
    max_loss: number;
    total_fee_paid: number;
}

