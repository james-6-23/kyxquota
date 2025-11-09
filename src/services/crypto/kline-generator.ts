import { db } from '../../database';
import type { KlineData, TradeFill } from '../../types-crypto';
import { redisCache, CacheKeys, CacheExpiry } from '../redis-cache';
import { logger } from '../../utils/logger';

/**
 * K线周期
 */
export const KLINE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type KlineInterval = typeof KLINE_INTERVALS[number];

/**
 * K线生成器
 */
export class KlineGenerator {
    private symbol: string;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    /**
     * 根据成交记录更新K线
     */
    async updateKlineFromTrade(trade: TradeFill): Promise<void> {
        for (const interval of KLINE_INTERVALS) {
            try {
                await this.updateKlineForInterval(trade, interval);
            } catch (error) {
                logger.error('KlineGenerator', `更新${interval} K线失败`, error);
            }
        }
    }

    /**
     * 更新指定周期的K线
     */
    private async updateKlineForInterval(trade: TradeFill, interval: KlineInterval): Promise<void> {
        const klineTimestamp = this.getKlineTimestamp(trade.timestamp, interval);
        
        // 查询是否存在该K线
        let kline = db.query(`
            SELECT * FROM kline_data
            WHERE symbol = ? AND interval = ? AND timestamp = ?
        `).get(this.symbol, interval, klineTimestamp) as KlineData | null;

        if (!kline) {
            // 创建新K线
            kline = {
                symbol: this.symbol,
                interval,
                timestamp: klineTimestamp,
                open: trade.price,
                high: trade.price,
                low: trade.price,
                close: trade.price,
                volume: trade.amount,
                quote_volume: trade.total_value,
                trades_count: 1,
            };

            db.run(`
                INSERT INTO kline_data (
                    symbol, interval, timestamp, open, high, low, close,
                    volume, quote_volume, trades_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                kline.symbol, kline.interval, kline.timestamp,
                kline.open, kline.high, kline.low, kline.close,
                kline.volume, kline.quote_volume, kline.trades_count
            ]);
        } else {
            // 更新现有K线
            const updatedKline = {
                high: Math.max(kline.high, trade.price),
                low: Math.min(kline.low, trade.price),
                close: trade.price,
                volume: kline.volume + trade.amount,
                quote_volume: kline.quote_volume + trade.total_value,
                trades_count: kline.trades_count + 1,
            };

            db.run(`
                UPDATE kline_data
                SET high = ?, low = ?, close = ?, volume = ?, 
                    quote_volume = ?, trades_count = ?
                WHERE symbol = ? AND interval = ? AND timestamp = ?
            `, [
                updatedKline.high, updatedKline.low, updatedKline.close,
                updatedKline.volume, updatedKline.quote_volume, updatedKline.trades_count,
                this.symbol, interval, klineTimestamp
            ]);

            kline = { ...kline, ...updatedKline };
        }

        // 缓存K线数据
        await this.cacheKline(kline);
    }

    /**
     * 获取K线时间戳（对齐到周期开始）
     */
    private getKlineTimestamp(timestamp: number, interval: KlineInterval): number {
        const ms = this.intervalToMs(interval);
        return Math.floor(timestamp / ms) * ms;
    }

    /**
     * 周期转换为毫秒
     */
    private intervalToMs(interval: KlineInterval): number {
        const unit = interval.slice(-1);
        const value = parseInt(interval.slice(0, -1));

        switch (unit) {
            case 'm': return value * 60 * 1000;           // 分钟
            case 'h': return value * 60 * 60 * 1000;      // 小时
            case 'd': return value * 24 * 60 * 60 * 1000; // 天
            default: throw new Error(`无效的周期: ${interval}`);
        }
    }

    /**
     * 获取历史K线
     */
    async getHistoricalKlines(
        interval: KlineInterval,
        startTime?: number,
        endTime?: number,
        limit: number = 1000
    ): Promise<KlineData[]> {
        let sql = `
            SELECT * FROM kline_data
            WHERE symbol = ? AND interval = ?
        `;
        const params: any[] = [this.symbol, interval];

        if (startTime) {
            sql += ' AND timestamp >= ?';
            params.push(startTime);
        }

        if (endTime) {
            sql += ' AND timestamp <= ?';
            params.push(endTime);
        }

        sql += ' ORDER BY timestamp ASC LIMIT ?';
        params.push(limit);

        return db.query(sql).all(...params) as KlineData[];
    }

    /**
     * 获取最新K线
     */
    async getLatestKline(interval: KlineInterval): Promise<KlineData | null> {
        return db.query(`
            SELECT * FROM kline_data
            WHERE symbol = ? AND interval = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `).get(this.symbol, interval) as KlineData | null;
    }

    /**
     * 缓存K线数据
     */
    private async cacheKline(kline: KlineData): Promise<void> {
        try {
            const cacheKey = CacheKeys.KLINE(kline.symbol, kline.interval, kline.timestamp);
            await redisCache.set(cacheKey, kline, CacheExpiry.KLINE);
        } catch (error) {
            logger.error('KlineGenerator', '缓存K线失败', error);
        }
    }

    /**
     * 从缓存获取K线
     */
    async getKlineFromCache(
        interval: KlineInterval,
        timestamp: number
    ): Promise<KlineData | null> {
        try {
            const cacheKey = CacheKeys.KLINE(this.symbol, interval, timestamp);
            return await redisCache.get<KlineData>(cacheKey);
        } catch (error) {
            logger.error('KlineGenerator', '从缓存获取K线失败', error);
            return null;
        }
    }

    /**
     * 生成指定时间范围的K线（用于初始化或修复）
     */
    async generateKlinesFromTrades(
        interval: KlineInterval,
        startTime: number,
        endTime: number
    ): Promise<number> {
        // 获取该时间段的所有成交记录
        const trades = db.query(`
            SELECT * FROM trade_fills
            WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(this.symbol, startTime, endTime) as TradeFill[];

        if (trades.length === 0) {
            return 0;
        }

        // 按K线周期分组
        const klineMap = new Map<number, {
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
            quote_volume: number;
            trades_count: number;
        }>();

        for (const trade of trades) {
            const klineTimestamp = this.getKlineTimestamp(trade.timestamp, interval);

            if (!klineMap.has(klineTimestamp)) {
                klineMap.set(klineTimestamp, {
                    open: trade.price,
                    high: trade.price,
                    low: trade.price,
                    close: trade.price,
                    volume: trade.amount,
                    quote_volume: trade.total_value,
                    trades_count: 1,
                });
            } else {
                const kline = klineMap.get(klineTimestamp)!;
                kline.high = Math.max(kline.high, trade.price);
                kline.low = Math.min(kline.low, trade.price);
                kline.close = trade.price;
                kline.volume += trade.amount;
                kline.quote_volume += trade.total_value;
                kline.trades_count += 1;
            }
        }

        // 批量插入K线数据
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO kline_data (
                symbol, interval, timestamp, open, high, low, close,
                volume, quote_volume, trades_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let count = 0;
        for (const [timestamp, data] of klineMap.entries()) {
            insertStmt.run(
                this.symbol, interval, timestamp,
                data.open, data.high, data.low, data.close,
                data.volume, data.quote_volume, data.trades_count
            );
            count++;
        }

        logger.info('KlineGenerator', `生成了 ${count} 条 ${interval} K线数据`);
        return count;
    }

    /**
     * 清理过期的K线数据
     */
    async cleanOldKlines(daysToKeep: number = 90): Promise<number> {
        const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

        const result = db.run(`
            DELETE FROM kline_data
            WHERE symbol = ? AND timestamp < ?
        `, [this.symbol, cutoffTime]);

        logger.info('KlineGenerator', `清理了 ${result.changes} 条过期K线数据`);
        return result.changes || 0;
    }
}

/**
 * K线管理器（管理多个交易对的K线）
 */
export class KlineManager {
    private generators: Map<string, KlineGenerator>;

    constructor() {
        this.generators = new Map();
    }

    /**
     * 获取或创建K线生成器
     */
    getGenerator(symbol: string): KlineGenerator {
        if (!this.generators.has(symbol)) {
            this.generators.set(symbol, new KlineGenerator(symbol));
        }
        return this.generators.get(symbol)!;
    }

    /**
     * 处理新成交记录（自动更新所有周期的K线）
     */
    async handleNewTrade(trade: TradeFill): Promise<void> {
        const generator = this.getGenerator(trade.symbol);
        await generator.updateKlineFromTrade(trade);
    }

    /**
     * 获取K线数据
     */
    async getKlines(
        symbol: string,
        interval: KlineInterval,
        startTime?: number,
        endTime?: number,
        limit?: number
    ): Promise<KlineData[]> {
        const generator = this.getGenerator(symbol);
        return await generator.getHistoricalKlines(interval, startTime, endTime, limit);
    }

    /**
     * 初始化所有交易对的K线数据
     */
    async initializeKlines(symbols: string[]): Promise<void> {
        logger.info('KlineManager', '开始初始化K线数据...');

        for (const symbol of symbols) {
            const generator = this.getGenerator(symbol);

            // 查询第一笔成交记录的时间
            const firstTrade = db.query(`
                SELECT MIN(timestamp) as first_time FROM trade_fills WHERE symbol = ?
            `).get(symbol) as { first_time: number | null };

            if (!firstTrade?.first_time) {
                logger.warn('KlineManager', `${symbol} 暂无成交记录，跳过K线初始化`);
                continue;
            }

            const startTime = firstTrade.first_time;
            const endTime = Date.now();

            // 为每个周期生成K线
            for (const interval of KLINE_INTERVALS) {
                await generator.generateKlinesFromTrades(interval, startTime, endTime);
            }
        }

        logger.info('KlineManager', 'K线数据初始化完成');
    }

    /**
     * 定期清理过期K线数据
     */
    async cleanOldKlinesForAll(symbols: string[], daysToKeep: number = 90): Promise<void> {
        logger.info('KlineManager', `开始清理 ${daysToKeep} 天前的K线数据...`);

        let totalCleaned = 0;
        for (const symbol of symbols) {
            const generator = this.getGenerator(symbol);
            const cleaned = await generator.cleanOldKlines(daysToKeep);
            totalCleaned += cleaned;
        }

        logger.info('KlineManager', `共清理了 ${totalCleaned} 条过期K线数据`);
    }
}

// 导出全局K线管理器单例
export const klineManager = new KlineManager();

/**
 * 初始化K线系统
 */
export async function initKlineSystem(): Promise<void> {
    logger.info('KlineSystem', '初始化K线系统...');

    // 获取所有启用的交易对
    const pairs = db.query('SELECT symbol FROM trading_pairs WHERE enabled = 1').all() as { symbol: string }[];
    const symbols = pairs.map(p => p.symbol);

    // 初始化K线数据
    await klineManager.initializeKlines(symbols);

    // 启动定期清理任务（每天凌晨4点清理）
    setInterval(async () => {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        if (hour === 4 && minute < 5) {
            await klineManager.cleanOldKlinesForAll(symbols, 90);
        }
    }, 5 * 60 * 1000); // 每5分钟检查一次

    logger.info('KlineSystem', 'K线系统初始化完成');
}

