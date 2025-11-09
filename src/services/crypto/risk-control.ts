import { db } from '../../database';
import { getCryptoConfig, getTodayDateString } from '../../database-crypto';
import type { TradeOrder, MarginPosition, UserAsset } from '../../types-crypto';

/**
 * 风险控制服务
 */
export class RiskControl {
    /**
     * 检查订单是否允许创建
     */
    async checkOrderAllowed(
        linuxDoId: string,
        orderParams: {
            symbol: string;
            side: 'buy' | 'sell';
            price: number;
            amount: number;
            leverage: number;
        }
    ): Promise<{ allowed: boolean; reason?: string }> {
        const checks = [
            () => this.checkTradingFrequency(linuxDoId),
            () => this.checkDailyOrderLimit(linuxDoId),
            () => this.checkOrderPriceDeviation(orderParams.symbol, orderParams.price),
            () => this.checkOrderSize(orderParams.symbol, orderParams.amount),
            () => this.checkPositionLimit(linuxDoId, orderParams.symbol, orderParams.amount, orderParams.price, orderParams.leverage),
        ];

        for (const check of checks) {
            const result = await check();
            if (!result.allowed) {
                return result;
            }
        }

        return { allowed: true };
    }

    /**
     * 检查交易频率限制
     */
    private async checkTradingFrequency(linuxDoId: string): Promise<{ allowed: boolean; reason?: string }> {
        // 检查最近1分钟的订单数
        const oneMinuteAgo = Date.now() - 60 * 1000;
        const recentOrders = db.query(`
            SELECT COUNT(*) as count
            FROM trade_orders
            WHERE linux_do_id = ? AND created_at >= ?
        `).get(linuxDoId, oneMinuteAgo) as { count: number };

        // 每分钟最多10个订单
        const maxOrdersPerMinute = 10;
        if (recentOrders.count >= maxOrdersPerMinute) {
            return {
                allowed: false,
                reason: `交易频率过高，每分钟最多${maxOrdersPerMinute}个订单，请稍后再试`
            };
        }

        return { allowed: true };
    }

    /**
     * 检查每日订单数量限制
     */
    private async checkDailyOrderLimit(linuxDoId: string): Promise<{ allowed: boolean; reason?: string }> {
        const config = getCryptoConfig();
        if (!config) {
            return { allowed: true };
        }

        const today = getTodayDateString();

        // 查询或创建今日限制记录
        let limit = db.query(`
            SELECT * FROM user_daily_crypto_limits
            WHERE linux_do_id = ? AND limit_date = ?
        `).get(linuxDoId, today) as any;

        if (!limit) {
            // 创建记录
            db.run(`
                INSERT INTO user_daily_crypto_limits (
                    linux_do_id, limit_date, orders_count, trades_count, total_trade_volume,
                    last_order_time, last_trade_time
                ) VALUES (?, ?, 0, 0, 0, NULL, NULL)
            `, [linuxDoId, today]);
            
            return { allowed: true };
        }

        // 检查是否超过每日订单限制
        if (limit.orders_count >= config.max_daily_trades) {
            return {
                allowed: false,
                reason: `已达到每日最大交易次数限制（${config.max_daily_trades}次）`
            };
        }

        return { allowed: true };
    }

    /**
     * 检查订单价格偏离度
     */
    private async checkOrderPriceDeviation(
        symbol: string,
        orderPrice: number
    ): Promise<{ allowed: boolean; reason?: string }> {
        const config = getCryptoConfig();
        if (!config) {
            return { allowed: true };
        }

        // 获取最近成交价格
        const recentTrade = db.query(`
            SELECT price FROM trade_fills
            WHERE symbol = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `).get(symbol) as { price: number } | null;

        if (!recentTrade) {
            // 如果没有历史成交，不限制
            return { allowed: true };
        }

        // 计算价格偏离度
        const marketPrice = recentTrade.price;
        const deviation = Math.abs(orderPrice - marketPrice) / marketPrice;
        const maxDeviation = config.price_fluctuation_limit; // 默认10%

        if (deviation > maxDeviation) {
            return {
                allowed: false,
                reason: `订单价格偏离市场价超过${(maxDeviation * 100).toFixed(1)}%（市场价: ${marketPrice}）`
            };
        }

        return { allowed: true };
    }

    /**
     * 检查订单数量限制
     */
    private async checkOrderSize(
        symbol: string,
        amount: number
    ): Promise<{ allowed: boolean; reason?: string }> {
        // 获取交易对配置
        const pair = db.query(`
            SELECT min_order_amount, max_order_amount
            FROM trading_pairs
            WHERE symbol = ? AND enabled = 1
        `).get(symbol) as { min_order_amount: number; max_order_amount: number } | null;

        if (!pair) {
            return {
                allowed: false,
                reason: '交易对不存在或已禁用'
            };
        }

        if (amount < pair.min_order_amount) {
            return {
                allowed: false,
                reason: `订单数量不能小于${pair.min_order_amount}`
            };
        }

        if (amount > pair.max_order_amount) {
            return {
                allowed: false,
                reason: `订单数量不能大于${pair.max_order_amount}`
            };
        }

        return { allowed: true };
    }

    /**
     * 检查持仓限额
     */
    private async checkPositionLimit(
        linuxDoId: string,
        symbol: string,
        amount: number,
        price: number,
        leverage: number
    ): Promise<{ allowed: boolean; reason?: string }> {
        const config = getCryptoConfig();
        if (!config) {
            return { allowed: true };
        }

        // 如果是现货交易（leverage = 1），不检查持仓限额
        if (leverage === 1) {
            return { allowed: true };
        }

        // 获取用户总资产
        const assets = db.query(`
            SELECT SUM(total_balance * 
                CASE 
                    WHEN currency = 'QUOTA' THEN 1
                    WHEN currency = 'KC' THEN ?
                    ELSE 0
                END
            ) as total_value
            FROM user_assets
            WHERE linux_do_id = ?
        `).get(price, linuxDoId) as { total_value: number } | null;

        const totalValue = assets?.total_value || 0;

        // 获取用户在该交易对的现有持仓
        const existingPosition = db.query(`
            SELECT SUM(amount * entry_price) as position_value
            FROM margin_positions
            WHERE linux_do_id = ? AND symbol = ? AND status = 'open'
        `).get(linuxDoId, symbol) as { position_value: number } | null;

        const existingPositionValue = existingPosition?.position_value || 0;

        // 计算新订单的持仓价值
        const newPositionValue = amount * price * leverage;

        // 总持仓价值
        const totalPositionValue = existingPositionValue + newPositionValue;

        // 持仓价值不能超过总资产的比例
        const maxPositionRatio = config.max_position_value_ratio; // 默认0.5 (50%)
        const positionRatio = totalPositionValue / totalValue;

        if (positionRatio > maxPositionRatio) {
            return {
                allowed: false,
                reason: `持仓价值超过总资产的${(maxPositionRatio * 100).toFixed(0)}%限制`
            };
        }

        return { allowed: true };
    }

    /**
     * 检查单用户挂单数量
     */
    async checkMaxPendingOrders(linuxDoId: string): Promise<{ allowed: boolean; reason?: string }> {
        const config = getCryptoConfig();
        if (!config) {
            return { allowed: true };
        }

        const pendingOrders = db.query(`
            SELECT COUNT(*) as count
            FROM trade_orders
            WHERE linux_do_id = ? AND status IN ('pending', 'partial_filled')
        `).get(linuxDoId) as { count: number };

        const maxOrders = config.max_orders_per_user; // 默认20

        if (pendingOrders.count >= maxOrders) {
            return {
                allowed: false,
                reason: `当前挂单数已达上限（${maxOrders}个），请先取消部分订单`
            };
        }

        return { allowed: true };
    }

    /**
     * 检测异常交易行为
     */
    async detectAnomalousTrading(
        linuxDoId: string,
        orderParams: {
            symbol: string;
            side: 'buy' | 'sell';
            price: number;
            amount: number;
        }
    ): Promise<{ anomalous: boolean; warnings: string[] }> {
        const warnings: string[] = [];

        // 1. 检查是否频繁撤单
        const recentCancellations = db.query(`
            SELECT COUNT(*) as count
            FROM trade_orders
            WHERE linux_do_id = ? 
                AND status = 'cancelled'
                AND created_at >= ?
        `).get(linuxDoId, Date.now() - 3600000) as { count: number };

        if (recentCancellations.count > 20) {
            warnings.push('⚠️ 检测到频繁撤单行为（1小时内撤单超过20次）');
        }

        // 2. 检查是否存在对倒交易（自买自卖）
        const recentTrades = db.query(`
            SELECT buyer_id, seller_id
            FROM trade_fills
            WHERE (buyer_id = ? OR seller_id = ?)
                AND timestamp >= ?
            LIMIT 10
        `).all(linuxDoId, linuxDoId, Date.now() - 3600000) as any[];

        // 检查是否有可疑的交易对手
        const tradePartners = new Set<string>();
        for (const trade of recentTrades) {
            if (trade.buyer_id === linuxDoId) {
                tradePartners.add(trade.seller_id);
            } else {
                tradePartners.add(trade.buyer_id);
            }
        }

        // 如果只和1-2个账户频繁交易，可能异常
        if (recentTrades.length >= 5 && tradePartners.size <= 2) {
            warnings.push('⚠️ 检测到与少数账户频繁交易');
        }

        // 3. 检查订单金额是否异常
        const userAssets = db.query(`
            SELECT SUM(total_balance) as total
            FROM user_assets
            WHERE linux_do_id = ? AND currency = 'QUOTA'
        `).get(linuxDoId) as { total: number } | null;

        const orderValue = orderParams.price * orderParams.amount;
        const userTotal = userAssets?.total || 0;

        if (userTotal > 0 && orderValue > userTotal * 0.5) {
            warnings.push('⚠️ 单笔订单金额超过总资产的50%');
        }

        return {
            anomalous: warnings.length > 0,
            warnings
        };
    }

    /**
     * 更新每日交易统计
     */
    async updateDailyStats(linuxDoId: string, type: 'order' | 'trade', volume?: number): Promise<void> {
        const today = getTodayDateString();
        const now = Date.now();

        // 查询或创建记录
        let limit = db.query(`
            SELECT * FROM user_daily_crypto_limits
            WHERE linux_do_id = ? AND limit_date = ?
        `).get(linuxDoId, today) as any;

        if (!limit) {
            db.run(`
                INSERT INTO user_daily_crypto_limits (
                    linux_do_id, limit_date, orders_count, trades_count, total_trade_volume,
                    last_order_time, last_trade_time
                ) VALUES (?, ?, 0, 0, 0, NULL, NULL)
            `, [linuxDoId, today]);

            limit = db.query(`
                SELECT * FROM user_daily_crypto_limits
                WHERE linux_do_id = ? AND limit_date = ?
            `).get(linuxDoId, today);
        }

        if (type === 'order') {
            db.run(`
                UPDATE user_daily_crypto_limits
                SET orders_count = orders_count + 1, last_order_time = ?
                WHERE linux_do_id = ? AND limit_date = ?
            `, [now, linuxDoId, today]);
        } else if (type === 'trade') {
            db.run(`
                UPDATE user_daily_crypto_limits
                SET trades_count = trades_count + 1,
                    total_trade_volume = total_trade_volume + ?,
                    last_trade_time = ?
                WHERE linux_do_id = ? AND limit_date = ?
            `, [volume || 0, now, linuxDoId, today]);
        }
    }

    /**
     * 系统级风险检查（熔断机制）
     */
    async checkSystemRisk(symbol: string): Promise<{ risk: boolean; reason?: string }> {
        const config = getCryptoConfig();
        if (!config) {
            return { risk: false };
        }

        // 检查24小时价格波动
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const trades = db.query(`
            SELECT MIN(price) as low, MAX(price) as high
            FROM trade_fills
            WHERE symbol = ? AND timestamp >= ?
        `).get(symbol, dayAgo) as { low: number; high: number } | null;

        if (!trades || !trades.low || !trades.high) {
            return { risk: false };
        }

        const volatility = (trades.high - trades.low) / trades.low;
        const maxVolatility = 0.5; // 50%

        if (volatility > maxVolatility) {
            return {
                risk: true,
                reason: `市场波动过大（24小时波动${(volatility * 100).toFixed(1)}%），已触发熔断机制`
            };
        }

        return { risk: false };
    }

    /**
     * 获取用户风险等级
     */
    async getUserRiskLevel(linuxDoId: string): Promise<'low' | 'medium' | 'high' | 'critical'> {
        let riskScore = 0;

        // 1. 检查历史违规记录
        const violations = db.query(`
            SELECT COUNT(*) as count
            FROM user_daily_crypto_limits
            WHERE linux_do_id = ? AND orders_count >= 100
        `).get(linuxDoId) as { count: number };

        riskScore += violations.count * 10;

        // 2. 检查取消订单比率
        const orderStats = db.query(`
            SELECT 
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                COUNT(*) as total
            FROM trade_orders
            WHERE linux_do_id = ? AND created_at >= ?
        `).get(linuxDoId, Date.now() - 7 * 24 * 60 * 60 * 1000) as { cancelled: number; total: number };

        if (orderStats.total > 0) {
            const cancelRate = orderStats.cancelled / orderStats.total;
            if (cancelRate > 0.5) riskScore += 20;
            else if (cancelRate > 0.3) riskScore += 10;
        }

        // 3. 检查亏损情况
        const profitStats = db.query(`
            SELECT 
                SUM(CASE WHEN buyer_id = ? THEN -total_value - buyer_fee ELSE total_value - seller_fee END) as profit
            FROM trade_fills
            WHERE (buyer_id = ? OR seller_id = ?) AND timestamp >= ?
        `).get(linuxDoId, linuxDoId, linuxDoId, Date.now() - 30 * 24 * 60 * 60 * 1000) as { profit: number };

        if (profitStats.profit < -1000000) riskScore += 30;
        else if (profitStats.profit < -500000) riskScore += 20;

        // 根据风险分数返回等级
        if (riskScore >= 50) return 'critical';
        if (riskScore >= 30) return 'high';
        if (riskScore >= 15) return 'medium';
        return 'low';
    }

    /**
     * 获取用户交易统计
     */
    async getUserTradingStats(linuxDoId: string): Promise<{
        total_orders: number;
        total_trades: number;
        cancel_rate: number;
        win_rate: number;
        total_profit: number;
        risk_level: string;
    }> {
        const orders = db.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
            FROM trade_orders
            WHERE linux_do_id = ?
        `).get(linuxDoId) as { total: number; cancelled: number };

        const trades = db.query(`
            SELECT COUNT(*) as count
            FROM trade_fills
            WHERE buyer_id = ? OR seller_id = ?
        `).get(linuxDoId, linuxDoId) as { count: number };

        const profit = db.query(`
            SELECT 
                SUM(CASE 
                    WHEN buyer_id = ? THEN -total_value - buyer_fee 
                    ELSE total_value - seller_fee 
                END) as total_profit,
                SUM(CASE 
                    WHEN buyer_id = ? THEN 
                        CASE WHEN -total_value - buyer_fee > 0 THEN 1 ELSE 0 END
                    ELSE 
                        CASE WHEN total_value - seller_fee > 0 THEN 1 ELSE 0 END
                END) as wins
            FROM trade_fills
            WHERE buyer_id = ? OR seller_id = ?
        `).get(linuxDoId, linuxDoId, linuxDoId, linuxDoId) as { total_profit: number; wins: number };

        const cancelRate = orders.total > 0 ? orders.cancelled / orders.total : 0;
        const winRate = trades.count > 0 ? (profit.wins || 0) / trades.count : 0;
        const riskLevel = await this.getUserRiskLevel(linuxDoId);

        return {
            total_orders: orders.total,
            total_trades: trades.count,
            cancel_rate: cancelRate,
            win_rate: winRate,
            total_profit: profit.total_profit || 0,
            risk_level: riskLevel,
        };
    }
}

// 导出单例
export const riskControl = new RiskControl();

