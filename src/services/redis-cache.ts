import Redis from 'ioredis';

// Redis配置
const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
};

// 创建Redis客户端
let redisClient: Redis | null = null;

/**
 * 获取Redis客户端
 */
export function getRedisClient(): Redis {
    if (!redisClient) {
        redisClient = new Redis(REDIS_CONFIG);

        redisClient.on('connect', () => {
            console.log('✅ Redis 连接成功');
        });

        redisClient.on('error', (err) => {
            console.error('❌ Redis 连接错误:', err.message);
        });

        redisClient.on('ready', () => {
            console.log('🚀 Redis 已就绪');
        });
    }

    return redisClient;
}

/**
 * Redis缓存管理器
 */
export class RedisCache {
    private client: Redis;

    constructor() {
        this.client = getRedisClient();
    }

    /**
     * 设置缓存
     */
    async set(key: string, value: any, expireSeconds?: number): Promise<void> {
        try {
            const data = JSON.stringify(value);
            if (expireSeconds) {
                await this.client.setex(key, expireSeconds, data);
            } else {
                await this.client.set(key, data);
            }
        } catch (error) {
            console.error(`Redis SET 错误 [${key}]:`, error);
        }
    }

    /**
     * 获取缓存
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const data = await this.client.get(key);
            if (!data) return null;
            return JSON.parse(data) as T;
        } catch (error) {
            console.error(`Redis GET 错误 [${key}]:`, error);
            return null;
        }
    }

    /**
     * 删除缓存
     */
    async del(key: string): Promise<void> {
        try {
            await this.client.del(key);
        } catch (error) {
            console.error(`Redis DEL 错误 [${key}]:`, error);
        }
    }

    /**
     * 批量删除缓存（通过模式匹配）
     */
    async delPattern(pattern: string): Promise<void> {
        try {
            const keys = await this.client.keys(pattern);
            if (keys.length > 0) {
                await this.client.del(...keys);
            }
        } catch (error) {
            console.error(`Redis DEL Pattern 错误 [${pattern}]:`, error);
        }
    }

    /**
     * 检查键是否存在
     */
    async exists(key: string): Promise<boolean> {
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            console.error(`Redis EXISTS 错误 [${key}]:`, error);
            return false;
        }
    }

    /**
     * 设置过期时间
     */
    async expire(key: string, seconds: number): Promise<void> {
        try {
            await this.client.expire(key, seconds);
        } catch (error) {
            console.error(`Redis EXPIRE 错误 [${key}]:`, error);
        }
    }

    /**
     * 获取剩余过期时间
     */
    async ttl(key: string): Promise<number> {
        try {
            return await this.client.ttl(key);
        } catch (error) {
            console.error(`Redis TTL 错误 [${key}]:`, error);
            return -1;
        }
    }

    /**
     * 原子自增
     */
    async incr(key: string): Promise<number> {
        try {
            return await this.client.incr(key);
        } catch (error) {
            console.error(`Redis INCR 错误 [${key}]:`, error);
            return 0;
        }
    }

    /**
     * 原子自减
     */
    async decr(key: string): Promise<number> {
        try {
            return await this.client.decr(key);
        } catch (error) {
            console.error(`Redis DECR 错误 [${key}]:`, error);
            return 0;
        }
    }

    /**
     * Hash操作 - 设置字段
     */
    async hset(key: string, field: string, value: any): Promise<void> {
        try {
            const data = JSON.stringify(value);
            await this.client.hset(key, field, data);
        } catch (error) {
            console.error(`Redis HSET 错误 [${key}.${field}]:`, error);
        }
    }

    /**
     * Hash操作 - 获取字段
     */
    async hget<T>(key: string, field: string): Promise<T | null> {
        try {
            const data = await this.client.hget(key, field);
            if (!data) return null;
            return JSON.parse(data) as T;
        } catch (error) {
            console.error(`Redis HGET 错误 [${key}.${field}]:`, error);
            return null;
        }
    }

    /**
     * Hash操作 - 获取所有字段
     */
    async hgetall<T>(key: string): Promise<Record<string, T>> {
        try {
            const data = await this.client.hgetall(key);
            const result: Record<string, T> = {};
            for (const [field, value] of Object.entries(data)) {
                result[field] = JSON.parse(value) as T;
            }
            return result;
        } catch (error) {
            console.error(`Redis HGETALL 错误 [${key}]:`, error);
            return {};
        }
    }

    /**
     * Hash操作 - 删除字段
     */
    async hdel(key: string, field: string): Promise<void> {
        try {
            await this.client.hdel(key, field);
        } catch (error) {
            console.error(`Redis HDEL 错误 [${key}.${field}]:`, error);
        }
    }

    /**
     * List操作 - 左侧推入
     */
    async lpush(key: string, value: any): Promise<void> {
        try {
            const data = JSON.stringify(value);
            await this.client.lpush(key, data);
        } catch (error) {
            console.error(`Redis LPUSH 错误 [${key}]:`, error);
        }
    }

    /**
     * List操作 - 右侧推入
     */
    async rpush(key: string, value: any): Promise<void> {
        try {
            const data = JSON.stringify(value);
            await this.client.rpush(key, data);
        } catch (error) {
            console.error(`Redis RPUSH 错误 [${key}]:`, error);
        }
    }

    /**
     * List操作 - 获取范围
     */
    async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
        try {
            const data = await this.client.lrange(key, start, stop);
            return data.map(item => JSON.parse(item) as T);
        } catch (error) {
            console.error(`Redis LRANGE 错误 [${key}]:`, error);
            return [];
        }
    }

    /**
     * List操作 - 修剪列表
     */
    async ltrim(key: string, start: number, stop: number): Promise<void> {
        try {
            await this.client.ltrim(key, start, stop);
        } catch (error) {
            console.error(`Redis LTRIM 错误 [${key}]:`, error);
        }
    }

    /**
     * Sorted Set操作 - 添加成员
     */
    async zadd(key: string, score: number, member: string): Promise<void> {
        try {
            await this.client.zadd(key, score, member);
        } catch (error) {
            console.error(`Redis ZADD 错误 [${key}]:`, error);
        }
    }

    /**
     * Sorted Set操作 - 获取范围（按分数）
     */
    async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
        try {
            return await this.client.zrangebyscore(key, min, max);
        } catch (error) {
            console.error(`Redis ZRANGEBYSCORE 错误 [${key}]:`, error);
            return [];
        }
    }

    /**
     * Sorted Set操作 - 删除成员
     */
    async zrem(key: string, member: string): Promise<void> {
        try {
            await this.client.zrem(key, member);
        } catch (error) {
            console.error(`Redis ZREM 错误 [${key}]:`, error);
        }
    }

    /**
     * 发布消息
     */
    async publish(channel: string, message: any): Promise<void> {
        try {
            const data = JSON.stringify(message);
            await this.client.publish(channel, data);
        } catch (error) {
            console.error(`Redis PUBLISH 错误 [${channel}]:`, error);
        }
    }

    /**
     * 订阅频道
     */
    async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
        try {
            const subscriber = this.client.duplicate();
            await subscriber.subscribe(channel);
            subscriber.on('message', (ch, msg) => {
                if (ch === channel) {
                    try {
                        const data = JSON.parse(msg);
                        callback(data);
                    } catch (error) {
                        console.error('解析订阅消息错误:', error);
                    }
                }
            });
        } catch (error) {
            console.error(`Redis SUBSCRIBE 错误 [${channel}]:`, error);
        }
    }

    /**
     * 清空所有缓存
     */
    async flushall(): Promise<void> {
        try {
            await this.client.flushall();
            console.log('✅ Redis 缓存已清空');
        } catch (error) {
            console.error('Redis FLUSHALL 错误:', error);
        }
    }

    /**
     * 获取缓存信息
     */
    async info(): Promise<string> {
        try {
            return await this.client.info();
        } catch (error) {
            console.error('Redis INFO 错误:', error);
            return '';
        }
    }

    /**
     * Ping测试
     */
    async ping(): Promise<boolean> {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        } catch (error) {
            console.error('Redis PING 错误:', error);
            return false;
        }
    }
}

// 导出单例
export const redisCache = new RedisCache();

// ========== 交易系统专用缓存键 ==========

export const CacheKeys = {
    // 订单簿
    ORDERBOOK: (symbol: string) => `crypto:orderbook:${symbol}`,
    // K线数据
    KLINE: (symbol: string, interval: string, timestamp: number) =>
        `crypto:kline:${symbol}:${interval}:${timestamp}`,
    // 最新价格
    PRICE: (symbol: string) => `crypto:price:${symbol}`,
    // 24小时行情
    TICKER_24H: (symbol: string) => `crypto:ticker24h:${symbol}`,
    // 用户订单列表
    USER_ORDERS: (linuxDoId: string) => `crypto:user:${linuxDoId}:orders`,
    // 用户持仓
    USER_POSITIONS: (linuxDoId: string) => `crypto:user:${linuxDoId}:positions`,
    // 最新成交
    RECENT_TRADES: (symbol: string) => `crypto:trades:${symbol}`,
    // 用户资产
    USER_ASSET: (linuxDoId: string, accountType: string, currency: string) =>
        `crypto:asset:${linuxDoId}:${accountType}:${currency}`,
};

// ========== 缓存过期时间（秒） ==========

export const CacheExpiry = {
    ORDERBOOK: 5,           // 订单簿 5秒
    KLINE: 60,              // K线 1分钟
    PRICE: 1,               // 最新价格 1秒
    TICKER_24H: 10,         // 24小时行情 10秒
    USER_ORDERS: 30,        // 用户订单 30秒
    USER_POSITIONS: 30,     // 用户持仓 30秒
    RECENT_TRADES: 5,       // 最新成交 5秒
    USER_ASSET: 10,         // 用户资产 10秒
};

