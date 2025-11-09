import { db } from '../../database';
import type {
    TradeOrder,
    TradeFill,
    CreateOrderParams,
    TradingPair,
    UserAsset,
} from '../../types-crypto';
import { OrderBook, orderBookManager } from './orderbook';
import { redisCache, CacheKeys, CacheExpiry } from '../redis-cache';
import { generateId, getTodayDateString, getUserAsset, updateUserAsset } from '../../database-crypto';
import { klineManager } from './kline-generator';
import {
    pushDepthUpdate,
    pushTradeUpdate,
    pushTickerUpdate,
    pushUserOrderUpdate,
} from './websocket-server';
import { riskControl } from './risk-control';
import { logger } from '../../utils/logger';

/**
 * 撮合引擎
 */
export class TradingEngine {
    /**
     * 创建订单
     */
    async createOrder(
        linuxDoId: string,
        username: string,
        params: CreateOrderParams
    ): Promise<{ success: boolean; orderId?: string; error?: string; fills?: TradeFill[] }> {
        const { symbol, order_type, side, price, amount, leverage = 1, margin_mode } = params;

        try {
            // 1. 风控检查
            const riskCheck = await riskControl.checkOrderAllowed(linuxDoId, {
                symbol,
                side,
                price: price || 0,
                amount,
                leverage,
            });

            if (!riskCheck.allowed) {
                return { success: false, error: riskCheck.reason };
            }

            // 检查挂单数量限制
            const maxOrdersCheck = await riskControl.checkMaxPendingOrders(linuxDoId);
            if (!maxOrdersCheck.allowed) {
                return { success: false, error: maxOrdersCheck.reason };
            }

            // 检测异常交易
            const anomalyDetection = await riskControl.detectAnomalousTrading(linuxDoId, {
                symbol,
                side,
                price: price || 0,
                amount,
            });

            if (anomalyDetection.anomalous) {
                logger.warn('TradingEngine', `异常交易检测 [${linuxDoId}]: ${anomalyDetection.warnings.join(', ')}`);
                // 记录警告但仍允许交易（可根据需求调整）
            }

            // 检查系统级风险
            const systemRisk = await riskControl.checkSystemRisk(symbol);
            if (systemRisk.risk) {
                return { success: false, error: systemRisk.reason };
            }

            // 2. 验证交易对
            const tradingPair = db.query('SELECT * FROM trading_pairs WHERE symbol = ? AND enabled = 1')
                .get(symbol) as TradingPair | null;
            
            if (!tradingPair) {
                return { success: false, error: '交易对不存在或已禁用' };
            }

            // 2. 验证订单参数
            if (amount < tradingPair.min_order_amount || amount > tradingPair.max_order_amount) {
                return {
                    success: false,
                    error: `订单数量必须在 ${tradingPair.min_order_amount} 到 ${tradingPair.max_order_amount} 之间`
                };
            }

            // 3. 限价单必须有价格
            if (order_type === 'limit' && !price) {
                return { success: false, error: '限价单必须指定价格' };
            }

            // 4. 市价单使用当前市场价格
            let orderPrice = price || 0;
            if (order_type === 'market') {
                const marketPrice = await this.getMarketPrice(symbol, side);
                if (!marketPrice) {
                    return { success: false, error: '无法获取市场价格，请稍后重试' };
                }
                orderPrice = marketPrice;
            }

            // 5. 计算订单总价值
            const totalValue = orderPrice * amount;

            // 6. 检查用户余额
            const accountType = leverage > 1 ? 'margin' : 'spot';
            const currency = side === 'buy' ? 'QUOTA' : 'KC';
            const requiredAmount = side === 'buy' ? totalValue : amount;

            const userAsset = getUserAsset(linuxDoId, accountType, currency);
            if (userAsset.available_balance < requiredAmount) {
                return {
                    success: false,
                    error: `余额不足，可用余额：${userAsset.available_balance} ${currency}`
                };
            }

            // 7. 冻结资金
            updateUserAsset(linuxDoId, accountType, currency, {
                available_balance: userAsset.available_balance - requiredAmount,
                frozen_balance: userAsset.frozen_balance + requiredAmount,
                total_balance: userAsset.total_balance,
            });

            // 8. 创建订单记录
            const orderId = generateId('ORDER-');
            const now = Date.now();

            const order: TradeOrder = {
                order_id: orderId,
                linux_do_id: linuxDoId,
                username,
                symbol,
                order_type,
                side,
                price: orderPrice,
                amount,
                filled_amount: 0,
                unfilled_amount: amount,
                total_value: totalValue,
                status: 'pending',
                leverage,
                margin_mode: leverage > 1 ? margin_mode || 'isolated' : null,
                trigger_price: null,
                fee_amount: 0,
                role: null,
                created_at: now,
                updated_at: now,
                filled_at: null,
                cancelled_at: null,
            };

            // 9. 保存到数据库
            db.run(`
                INSERT INTO trade_orders (
                    order_id, linux_do_id, username, symbol, order_type, side, price, amount,
                    filled_amount, unfilled_amount, total_value, status, leverage, margin_mode,
                    trigger_price, fee_amount, role, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                orderId, linuxDoId, username, symbol, order_type, side, orderPrice, amount,
                0, amount, totalValue, 'pending', leverage, margin_mode,
                null, 0, null, now, now
            ]);

            // 10. 更新每日统计
            await riskControl.updateDailyStats(linuxDoId, 'order');

            // 11. 尝试撮合订单
            const fills = await this.matchOrder(order, tradingPair);

            // 12. 如果有成交，更新交易统计
            if (fills.length > 0) {
                const totalVolume = fills.reduce((sum, f) => sum + f.total_value, 0);
                await riskControl.updateDailyStats(linuxDoId, 'trade', totalVolume);
            }

            // 13. 如果是市价单且未完全成交，取消剩余部分
            if (order_type === 'market' && order.unfilled_amount > 0) {
                await this.cancelOrder(orderId, linuxDoId, '市价单部分成交后自动取消');
            }

            return {
                success: true,
                orderId,
                fills: fills.length > 0 ? fills : undefined,
            };
        } catch (error) {
            logger.error('TradingEngine', '创建订单失败', error);
            return { success: false, error: '创建订单失败，请稍后重试' };
        }
    }

    /**
     * 撮合订单（核心逻辑）
     */
    private async matchOrder(newOrder: TradeOrder, tradingPair: TradingPair): Promise<TradeFill[]> {
        const fills: TradeFill[] = [];
        const orderBook = orderBookManager.getOrderBook(newOrder.symbol);

        try {
            if (newOrder.side === 'buy') {
                // 买单：匹配最低的卖单
                while (newOrder.unfilled_amount > 0) {
                    const bestAsk = orderBook.getBestAsk();
                    if (!bestAsk) break;

                    // 限价单：只匹配价格 <= 委托价的卖单
                    if (newOrder.order_type === 'limit' && bestAsk.price > newOrder.price) {
                        break;
                    }

                    // 计算成交数量
                    const matchAmount = Math.min(newOrder.unfilled_amount, bestAsk.unfilled_amount);
                    const matchPrice = bestAsk.price;  // 使用卖单价格

                    // 创建成交记录
                    const fill = await this.createFill(
                        newOrder,
                        bestAsk,
                        matchPrice,
                        matchAmount,
                        tradingPair
                    );
                    fills.push(fill);

                    // 更新订单状态
                    await this.updateOrderFilled(newOrder, matchAmount);
                    await this.updateOrderFilled(bestAsk, matchAmount);

                    // 如果卖单完全成交，从订单簿移除
                    if (bestAsk.unfilled_amount <= 0) {
                        orderBook.popBestAsk();
                    }
                }
            } else {
                // 卖单：匹配最高的买单
                while (newOrder.unfilled_amount > 0) {
                    const bestBid = orderBook.getBestBid();
                    if (!bestBid) break;

                    // 限价单：只匹配价格 >= 委托价的买单
                    if (newOrder.order_type === 'limit' && bestBid.price < newOrder.price) {
                        break;
                    }

                    // 计算成交数量
                    const matchAmount = Math.min(newOrder.unfilled_amount, bestBid.unfilled_amount);
                    const matchPrice = bestBid.price;  // 使用买单价格

                    // 创建成交记录
                    const fill = await this.createFill(
                        bestBid,
                        newOrder,
                        matchPrice,
                        matchAmount,
                        tradingPair
                    );
                    fills.push(fill);

                    // 更新订单状态
                    await this.updateOrderFilled(newOrder, matchAmount);
                    await this.updateOrderFilled(bestBid, matchAmount);

                    // 如果买单完全成交，从订单簿移除
                    if (bestBid.unfilled_amount <= 0) {
                        orderBook.popBestBid();
                    }
                }
            }

            // 如果订单未完全成交，加入订单簿
            if (newOrder.unfilled_amount > 0 && newOrder.order_type === 'limit') {
                orderBook.addOrder(newOrder);
            }

            // 保存订单簿快照到Redis
            await orderBook.saveToCache();

            // WebSocket推送：深度更新（如果订单有变化）
            if (fills.length > 0 || (newOrder.unfilled_amount > 0 && newOrder.order_type === 'limit')) {
                pushDepthUpdate(newOrder.symbol);
            }

            return fills;
        } catch (error) {
            logger.error('TradingEngine', '订单撮合失败', error);
            throw error;
        }
    }

    /**
     * 创建成交记录
     */
    private async createFill(
        buyOrder: TradeOrder,
        sellOrder: TradeOrder,
        price: number,
        amount: number,
        tradingPair: TradingPair
    ): Promise<TradeFill> {
        const tradeId = generateId('TRADE-');
        const totalValue = price * amount;
        const now = Date.now();
        const date = getTodayDateString();

        // 确定Maker和Taker角色
        // 先挂单的是Maker，后下单的是Taker
        const buyerIsMaker = buyOrder.created_at < sellOrder.created_at;
        const buyerRole = buyerIsMaker ? 'maker' : 'taker';
        const sellerRole = buyerIsMaker ? 'taker' : 'maker';

        // 计算手续费
        const buyerFee = this.calculateFee(totalValue, buyerRole, tradingPair);
        const sellerFee = this.calculateFee(totalValue, sellerRole, tradingPair);

        // 创建成交记录
        const fill: TradeFill = {
            trade_id: tradeId,
            symbol: buyOrder.symbol,
            buy_order_id: buyOrder.order_id,
            sell_order_id: sellOrder.order_id,
            buyer_id: buyOrder.linux_do_id,
            seller_id: sellOrder.linux_do_id,
            buyer_username: buyOrder.username,
            seller_username: sellOrder.username,
            price,
            amount,
            total_value: totalValue,
            buyer_fee: buyerFee,
            seller_fee: sellerFee,
            buyer_role: buyerRole,
            seller_role: sellerRole,
            timestamp: now,
            date,
        };

        // 保存到数据库
        db.run(`
            INSERT INTO trade_fills (
                trade_id, symbol, buy_order_id, sell_order_id, buyer_id, seller_id,
                buyer_username, seller_username, price, amount, total_value,
                buyer_fee, seller_fee, buyer_role, seller_role, timestamp, date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            tradeId, buyOrder.symbol, buyOrder.order_id, sellOrder.order_id,
            buyOrder.linux_do_id, sellOrder.linux_do_id,
            buyOrder.username, sellOrder.username,
            price, amount, totalValue, buyerFee, sellerFee, buyerRole, sellerRole, now, date
        ]);

        // 执行资金清算
        await this.settleTrade(fill, buyOrder, sellOrder);

        // 更新订单的角色和手续费
        this.updateOrderRole(buyOrder, buyerRole, buyerFee);
        this.updateOrderRole(sellOrder, sellerRole, sellerFee);

        // 缓存最新成交到Redis
        await this.cacheRecentTrade(fill);

        // 更新K线数据
        await klineManager.handleNewTrade(fill);

        // WebSocket推送：深度更新
        pushDepthUpdate(fill.symbol);

        // WebSocket推送：新成交
        pushTradeUpdate({
            trade_id: fill.trade_id,
            symbol: fill.symbol,
            price: fill.price,
            amount: fill.amount,
            side: fill.buyer_role === 'taker' ? 'buy' : 'sell',
            timestamp: fill.timestamp,
        });

        // WebSocket推送：行情更新（异步，不阻塞）
        pushTickerUpdate(fill.symbol).catch(err =>
            logger.error('TradingEngine', '推送行情更新失败', err)
        );

        return fill;
    }

    /**
     * 计算手续费
     */
    private calculateFee(totalValue: number, role: 'maker' | 'taker', tradingPair: TradingPair): number {
        const feeRate = role === 'maker' ? tradingPair.maker_fee_rate : tradingPair.taker_fee_rate;
        return totalValue * feeRate;
    }

    /**
     * 资金清算
     */
    private async settleTrade(fill: TradeFill, buyOrder: TradeOrder, sellOrder: TradeOrder): Promise<void> {
        const accountType = buyOrder.leverage > 1 || sellOrder.leverage > 1 ? 'margin' : 'spot';

        // 买方：扣除冻结的QUOTA，增加KC
        const buyerQuotaAsset = getUserAsset(fill.buyer_id, accountType, 'QUOTA');
        const buyerKCAsset = getUserAsset(fill.buyer_id, accountType, 'KC');

        const buyerQuotaCost = fill.total_value + fill.buyer_fee;
        
        updateUserAsset(fill.buyer_id, accountType, 'QUOTA', {
            frozen_balance: Math.max(0, buyerQuotaAsset.frozen_balance - buyerQuotaCost),
            total_balance: buyerQuotaAsset.total_balance - fill.buyer_fee,  // 扣除手续费
        });

        updateUserAsset(fill.buyer_id, accountType, 'KC', {
            available_balance: buyerKCAsset.available_balance + fill.amount,
            total_balance: buyerKCAsset.total_balance + fill.amount,
        });

        // 卖方：扣除冻结的KC，增加QUOTA
        const sellerKCAsset = getUserAsset(fill.seller_id, accountType, 'KC');
        const sellerQuotaAsset = getUserAsset(fill.seller_id, accountType, 'QUOTA');

        const sellerQuotaReceived = fill.total_value - fill.seller_fee;

        updateUserAsset(fill.seller_id, accountType, 'KC', {
            frozen_balance: Math.max(0, sellerKCAsset.frozen_balance - fill.amount),
            total_balance: sellerKCAsset.total_balance - fill.amount,
        });

        updateUserAsset(fill.seller_id, accountType, 'QUOTA', {
            available_balance: sellerQuotaAsset.available_balance + sellerQuotaReceived,
            total_balance: sellerQuotaAsset.total_balance + sellerQuotaReceived,
        });
    }

    /**
     * 更新订单成交情况
     */
    private async updateOrderFilled(order: TradeOrder, filledAmount: number): Promise<void> {
        order.filled_amount += filledAmount;
        order.unfilled_amount -= filledAmount;
        order.updated_at = Date.now();

        // 判断订单状态
        if (order.unfilled_amount <= 0) {
            order.status = 'filled';
            order.filled_at = Date.now();
        } else if (order.filled_amount > 0) {
            order.status = 'partial_filled';
        }

        // 更新数据库
        db.run(`
            UPDATE trade_orders
            SET filled_amount = ?, unfilled_amount = ?, status = ?, filled_at = ?, updated_at = ?
            WHERE order_id = ?
        `, [
            order.filled_amount,
            order.unfilled_amount,
            order.status,
            order.filled_at,
            order.updated_at,
            order.order_id
        ]);
    }

    /**
     * 更新订单角色和手续费
     */
    private updateOrderRole(order: TradeOrder, role: 'maker' | 'taker', fee: number): void {
        if (!order.role) {
            order.role = role;
        }
        order.fee_amount += fee;

        db.run(`
            UPDATE trade_orders SET role = ?, fee_amount = ? WHERE order_id = ?
        `, [role, order.fee_amount, order.order_id]);
    }

    /**
     * 取消订单
     */
    async cancelOrder(
        orderId: string,
        linuxDoId: string,
        reason?: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // 查询订单
            const order = db.query('SELECT * FROM trade_orders WHERE order_id = ? AND linux_do_id = ?')
                .get(orderId, linuxDoId) as TradeOrder | null;

            if (!order) {
                return { success: false, error: '订单不存在' };
            }

            if (order.status === 'filled') {
                return { success: false, error: '订单已完全成交，无法取消' };
            }

            if (order.status === 'cancelled') {
                return { success: false, error: '订单已取消' };
            }

            // 从订单簿移除
            orderBookManager.removeOrder(order.symbol, orderId);

            // 更新订单状态
            const now = Date.now();
            db.run(`
                UPDATE trade_orders
                SET status = 'cancelled', cancelled_at = ?, updated_at = ?
                WHERE order_id = ?
            `, [now, now, orderId]);

            // 解冻资金
            const accountType = order.leverage > 1 ? 'margin' : 'spot';
            const currency = order.side === 'buy' ? 'QUOTA' : 'KC';
            const frozenAmount = order.side === 'buy' 
                ? order.unfilled_amount * order.price 
                : order.unfilled_amount;

            const userAsset = getUserAsset(linuxDoId, accountType, currency);
            updateUserAsset(linuxDoId, accountType, currency, {
                available_balance: userAsset.available_balance + frozenAmount,
                frozen_balance: Math.max(0, userAsset.frozen_balance - frozenAmount),
            });

            // WebSocket推送：订单更新
            pushUserOrderUpdate(linuxDoId, {
                order_id: orderId,
                status: 'cancelled',
                updated_at: now,
            });

            // WebSocket推送：深度更新
            pushDepthUpdate(order.symbol);

            return { success: true };
        } catch (error) {
            logger.error('TradingEngine', '取消订单失败', error);
            return { success: false, error: '取消订单失败' };
        }
    }

    /**
     * 获取市场价格（用于市价单）
     */
    private async getMarketPrice(symbol: string, side: 'buy' | 'sell'): Promise<number | null> {
        const orderBook = orderBookManager.getOrderBook(symbol);
        
        if (side === 'buy') {
            // 买单使用卖一价
            const bestAsk = orderBook.getBestAsk();
            return bestAsk ? bestAsk.price : null;
        } else {
            // 卖单使用买一价
            const bestBid = orderBook.getBestBid();
            return bestBid ? bestBid.price : null;
        }
    }

    /**
     * 缓存最新成交到Redis
     */
    private async cacheRecentTrade(fill: TradeFill): Promise<void> {
        try {
            const key = CacheKeys.RECENT_TRADES(fill.symbol);
            
            // 添加到列表头部
            await redisCache.lpush(key, {
                trade_id: fill.trade_id,
                price: fill.price,
                amount: fill.amount,
                side: fill.buyer_role === 'taker' ? 'buy' : 'sell',  // Taker方向
                timestamp: fill.timestamp,
            });

            // 只保留最近100条
            await redisCache.ltrim(key, 0, 99);
            
            // 设置过期时间
            await redisCache.expire(key, CacheExpiry.RECENT_TRADES);
        } catch (error) {
            logger.error('TradingEngine', '缓存最新成交失败', error);
        }
    }
}

// 导出单例
export const tradingEngine = new TradingEngine();

