import type { Context } from 'hono';
import { WSContext } from 'hono/ws';
import type { WebSocketMessage, TickerData, DepthData, TradeData } from '../../types-crypto';
import { orderBookManager } from './orderbook';
import { klineManager } from './kline-generator';
import { redisCache } from '../redis-cache';
import { db } from '../../database';
import { logger } from '../../utils/logger';

/**
 * WebSocket连接管理器
 */
class WebSocketConnectionManager {
    // 所有连接
    private connections: Map<string, WSContext> = new Map();
    
    // 订阅管理：频道 -> 连接ID集合
    private subscriptions: Map<string, Set<string>> = new Map();
    
    // 用户连接：linux_do_id -> 连接ID
    private userConnections: Map<string, string> = new Map();

    /**
     * 添加连接
     */
    addConnection(connectionId: string, ws: WSContext, linuxDoId?: string): void {
        this.connections.set(connectionId, ws);
        
        if (linuxDoId) {
            this.userConnections.set(linuxDoId, connectionId);
        }

        logger.info('WebSocket', `连接建立 [${connectionId}]${linuxDoId ? ` 用户: ${linuxDoId}` : ''}`);
    }

    /**
     * 移除连接
     */
    removeConnection(connectionId: string): void {
        this.connections.delete(connectionId);
        
        // 移除所有订阅
        for (const [channel, subscribers] of this.subscriptions.entries()) {
            subscribers.delete(connectionId);
            if (subscribers.size === 0) {
                this.subscriptions.delete(channel);
            }
        }
        
        // 移除用户连接映射
        for (const [userId, connId] of this.userConnections.entries()) {
            if (connId === connectionId) {
                this.userConnections.delete(userId);
                break;
            }
        }

        logger.info('WebSocket', `连接关闭 [${connectionId}]`);
    }

    /**
     * 订阅频道
     */
    subscribe(connectionId: string, channel: string): void {
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, new Set());
        }

        this.subscriptions.get(channel)!.add(connectionId);
        logger.debug('WebSocket', `订阅频道 [${connectionId}] -> ${channel}`);
    }

    /**
     * 取消订阅
     */
    unsubscribe(connectionId: string, channel: string): void {
        const subscribers = this.subscriptions.get(channel);
        if (subscribers) {
            subscribers.delete(connectionId);
            
            if (subscribers.size === 0) {
                this.subscriptions.delete(channel);
            }
        }

        logger.debug('WebSocket', `取消订阅 [${connectionId}] -> ${channel}`);
    }

    /**
     * 向指定连接发送消息
     */
    sendToConnection(connectionId: string, message: WebSocketMessage): void {
        const ws = this.connections.get(connectionId);
        if (ws) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                logger.error('WebSocket', `发送消息失败 [${connectionId}]`, error);
            }
        }
    }

    /**
     * 向频道广播消息
     */
    broadcast(channel: string, message: WebSocketMessage): void {
        const subscribers = this.subscriptions.get(channel);
        if (!subscribers || subscribers.size === 0) return;

        const messageStr = JSON.stringify(message);
        
        for (const connectionId of subscribers) {
            const ws = this.connections.get(connectionId);
            if (ws) {
                try {
                    ws.send(messageStr);
                } catch (error) {
                    logger.error('WebSocket', `广播消息失败 [${connectionId}]`, error);
                }
            }
        }
    }

    /**
     * 向指定用户发送消息
     */
    sendToUser(linuxDoId: string, message: WebSocketMessage): void {
        const connectionId = this.userConnections.get(linuxDoId);
        if (connectionId) {
            this.sendToConnection(connectionId, message);
        }
    }

    /**
     * 获取统计信息
     */
    getStats(): { connections: number; channels: number; subscriptions: number } {
        let totalSubscriptions = 0;
        for (const subscribers of this.subscriptions.values()) {
            totalSubscriptions += subscribers.size;
        }
        
        return {
            connections: this.connections.size,
            channels: this.subscriptions.size,
            subscriptions: totalSubscriptions,
        };
    }
}

// 全局连接管理器
export const wsManager = new WebSocketConnectionManager();

/**
 * WebSocket频道定义
 */
export const WS_CHANNELS = {
    // 行情频道
    TICKER: (symbol: string) => `ticker.${symbol}`,
    // K线频道
    KLINE: (symbol: string, interval: string) => `kline.${symbol}.${interval}`,
    // 深度频道
    DEPTH: (symbol: string) => `depth.${symbol}`,
    // 成交频道
    TRADE: (symbol: string) => `trade.${symbol}`,
    // 用户订单频道
    USER_ORDER: (linuxDoId: string) => `user.order.${linuxDoId}`,
    // 用户持仓频道
    USER_POSITION: (linuxDoId: string) => `user.position.${linuxDoId}`,
};

/**
 * 处理WebSocket消息
 */
export async function handleWebSocketMessage(
    ws: WSContext,
    connectionId: string,
    message: string,
    linuxDoId?: string
): Promise<void> {
    try {
        const data: WebSocketMessage = JSON.parse(message);
        
        switch (data.type) {
            case 'subscribe':
                if (data.channel) {
                    // 验证用户频道权限
                    if (data.channel.startsWith('user.') && !linuxDoId) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            data: { message: '订阅用户频道需要登录' },
                            timestamp: Date.now(),
                        }));
                        return;
                    }
                    
                    wsManager.subscribe(connectionId, data.channel);
                    
                    // 立即发送初始数据
                    await sendInitialData(ws, data.channel);
                }
                break;

            case 'unsubscribe':
                if (data.channel) {
                    wsManager.unsubscribe(connectionId, data.channel);
                }
                break;

            case 'ping':
                // 心跳响应
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now(),
                }));
                break;

            default:
                ws.send(JSON.stringify({
                    type: 'error',
                    data: { message: '未知的消息类型' },
                    timestamp: Date.now(),
                }));
        }
    } catch (error) {
        logger.error('WebSocket', '处理WebSocket消息失败', error);
        ws.send(JSON.stringify({
            type: 'error',
            data: { message: '消息格式错误' },
            timestamp: Date.now(),
        }));
    }
}

/**
 * 发送频道的初始数据
 */
async function sendInitialData(ws: WSContext, channel: string): Promise<void> {
    try {
        // ticker频道
        if (channel.startsWith('ticker.')) {
            const symbol = channel.split('.')[1];
            const ticker = await get24hTicker(symbol);
            
            ws.send(JSON.stringify({
                type: 'ticker',
                channel,
                data: ticker,
                timestamp: Date.now(),
            }));
        }
        
        // depth频道
        else if (channel.startsWith('depth.')) {
            const symbol = channel.split('.')[1];
            const orderBook = orderBookManager.getOrderBook(symbol);
            const snapshot = orderBook.getSnapshot(20);
            
            ws.send(JSON.stringify({
                type: 'depth',
                channel,
                data: snapshot,
                timestamp: Date.now(),
            }));
        }
        
        // trade频道
        else if (channel.startsWith('trade.')) {
            const symbol = channel.split('.')[1];
            const trades = await getRecentTrades(symbol, 20);
            
            ws.send(JSON.stringify({
                type: 'trade',
                channel,
                data: trades,
                timestamp: Date.now(),
            }));
        }
        
        // kline频道
        else if (channel.startsWith('kline.')) {
            const [_, symbol, interval] = channel.split('.');
            const generator = klineManager.getGenerator(symbol);
            const kline = await generator.getLatestKline(interval as any);
            
            if (kline) {
                ws.send(JSON.stringify({
                    type: 'kline',
                    channel,
                    data: kline,
                    timestamp: Date.now(),
                }));
            }
        }
    } catch (error) {
        logger.error('WebSocket', '发送初始数据失败', error);
    }
}

/**
 * 获取24小时行情数据
 */
async function get24hTicker(symbol: string): Promise<TickerData> {
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;

    const fills = db.query(`
        SELECT price, amount, total_value
        FROM trade_fills
        WHERE symbol = ? AND timestamp >= ?
        ORDER BY timestamp ASC
    `).all(symbol, yesterday) as any[];

    if (fills.length === 0) {
        return {
            symbol,
            last_price: 10000,
            price_change_24h: 0,
            price_change_percent_24h: 0,
            high_24h: 10000,
            low_24h: 10000,
            volume_24h: 0,
            quote_volume_24h: 0,
            timestamp: now,
        };
    }

    const firstPrice = fills[0].price;
    const lastPrice = fills[fills.length - 1].price;
    const priceChange = lastPrice - firstPrice;
    const priceChangePercent = (priceChange / firstPrice) * 100;

    return {
        symbol,
        last_price: lastPrice,
        price_change_24h: priceChange,
        price_change_percent_24h: priceChangePercent,
        high_24h: Math.max(...fills.map((f: any) => f.price)),
        low_24h: Math.min(...fills.map((f: any) => f.price)),
        volume_24h: fills.reduce((sum: number, f: any) => sum + f.amount, 0),
        quote_volume_24h: fills.reduce((sum: number, f: any) => sum + f.total_value, 0),
        timestamp: now,
    };
}

/**
 * 获取最新成交
 */
async function getRecentTrades(symbol: string, limit: number): Promise<TradeData[]> {
    const fills = db.query(`
        SELECT trade_id, price, amount, timestamp, buyer_role
        FROM trade_fills
        WHERE symbol = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(symbol, limit) as any[];

    return fills.map(f => ({
        trade_id: f.trade_id,
        symbol,
        price: f.price,
        amount: f.amount,
        side: f.buyer_role === 'taker' ? 'buy' : 'sell',
        timestamp: f.timestamp,
    }));
}

/**
 * 推送行情更新
 */
export async function pushTickerUpdate(symbol: string): Promise<void> {
    const channel = WS_CHANNELS.TICKER(symbol);
    const ticker = await get24hTicker(symbol);
    
    wsManager.broadcast(channel, {
        type: 'ticker',
        channel,
        data: ticker,
        timestamp: Date.now(),
    });
}

/**
 * 推送深度更新
 */
export function pushDepthUpdate(symbol: string): void {
    const channel = WS_CHANNELS.DEPTH(symbol);
    const orderBook = orderBookManager.getOrderBook(symbol);
    const snapshot = orderBook.getSnapshot(20);
    
    wsManager.broadcast(channel, {
        type: 'depth',
        channel,
        data: snapshot,
        timestamp: Date.now(),
    });
}

/**
 * 推送新成交
 */
export function pushTradeUpdate(tradeData: TradeData): void {
    const channel = WS_CHANNELS.TRADE(tradeData.symbol);
    
    wsManager.broadcast(channel, {
        type: 'trade',
        channel,
        data: tradeData,
        timestamp: Date.now(),
    });
}

/**
 * 推送K线更新
 */
export function pushKlineUpdate(symbol: string, interval: string, kline: any): void {
    const channel = WS_CHANNELS.KLINE(symbol, interval);
    
    wsManager.broadcast(channel, {
        type: 'kline',
        channel,
        data: kline,
        timestamp: Date.now(),
    });
}

/**
 * 推送用户订单更新
 */
export function pushUserOrderUpdate(linuxDoId: string, order: any): void {
    const channel = WS_CHANNELS.USER_ORDER(linuxDoId);
    
    wsManager.sendToUser(linuxDoId, {
        type: 'order',
        channel,
        data: order,
        timestamp: Date.now(),
    });
}

/**
 * 推送用户持仓更新
 */
export function pushUserPositionUpdate(linuxDoId: string, position: any): void {
    const channel = WS_CHANNELS.USER_POSITION(linuxDoId);
    
    wsManager.sendToUser(linuxDoId, {
        type: 'position',
        channel,
        data: position,
        timestamp: Date.now(),
    });
}

/**
 * 启动定时推送任务
 */
export function startPeriodicPush(): void {
    // 每5秒推送一次行情（如果有订阅者）
    setInterval(async () => {
        const pairs = db.query('SELECT symbol FROM trading_pairs WHERE enabled = 1').all() as { symbol: string }[];
        
        for (const pair of pairs) {
            const channel = WS_CHANNELS.TICKER(pair.symbol);
            const stats = wsManager.getStats();
            
            // 只有在有订阅者时才推送
            if (stats.subscriptions > 0) {
                await pushTickerUpdate(pair.symbol);
            }
        }
    }, 5000);

    logger.info('WebSocket', 'WebSocket定时推送任务已启动');
}

/**
 * 生成连接ID
 */
export function generateConnectionId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

