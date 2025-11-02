import type { CacheStats } from './types';
import logger from './utils/logger';

interface CacheEntry {
    value: any;
    expiry: number;
    hits: number;
    size: number;
    createdAt: number;
}

/**
 * 高性能 LRU 缓存管理器
 * 
 * 特性：
 * - LRU 淘汰策略
 * - 内存自动管理
 * - 防缓存击穿
 * - 防缓存穿透
 * - 定期清理
 */
export class CacheManager {
    private cache: Map<string, CacheEntry> = new Map();
    private readonly DEFAULT_TTL = 60000; // 默认 60 秒
    private readonly MAX_CACHE_SIZE = 1000; // 最大 1000 条
    private readonly MAX_MEMORY_MB = 50; // 最大 50MB
    private cleanupTimer: Timer | null = null;
    private loading: Map<string, Promise<any>> = new Map();

    private stats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        memoryUsage: 0,
    };

    constructor() {
        this.startPeriodicCleanup();
    }

    /**
     * 启动定期清理任务
     */
    private startPeriodicCleanup(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpiredCache();
        }, 1800000); // 30 分钟（从5分钟延长，减少日志频率）
    }

    /**
     * 清理过期缓存
     */
    private cleanupExpiredCache(): void {
        const now = Date.now();
        const keysToDelete: string[] = [];

        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiry < now) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            const entry = this.cache.get(key);
            if (entry) {
                this.stats.memoryUsage -= entry.size;
            }
            this.cache.delete(key);
            this.stats.evictions++;
        }

        // 只在有过期项时输出日志
        if (keysToDelete.length > 0) {
            logger.info('定时任务', `🧹 缓存清理完成 - 清理 ${keysToDelete.length} 个过期项，内存: ${(this.stats.memoryUsage / 1024 / 1024).toFixed(2)}MB`);
        }
    }

    /**
     * 估算对象大小（字节）
     */
    private estimateSize(value: any): number {
        if (value === null || value === undefined) return 8;

        const type = typeof value;
        if (type === 'boolean') return 4;
        if (type === 'number') return 8;
        if (type === 'string') return value.length * 2;

        if (type === 'object') {
            try {
                return JSON.stringify(value).length * 2;
            } catch {
                return 1024;
            }
        }

        return 64;
    }

    /**
     * LRU 淘汰策略
     */
    private evictLRU(): void {
        let minHits = Infinity;
        let oldestTime = Infinity;
        let lruKey: string | null = null;

        for (const [key, entry] of this.cache.entries()) {
            if (
                entry.hits < minHits ||
                (entry.hits === minHits && entry.createdAt < oldestTime)
            ) {
                minHits = entry.hits;
                oldestTime = entry.createdAt;
                lruKey = key;
            }
        }

        if (lruKey) {
            const entry = this.cache.get(lruKey);
            if (entry) {
                this.stats.memoryUsage -= entry.size;
            }
            this.cache.delete(lruKey);
            this.stats.evictions++;
        }
    }

    /**
     * 检查是否需要淘汰缓存
     */
    private shouldEvict(): boolean {
        const memoryLimitBytes = this.MAX_MEMORY_MB * 1024 * 1024;
        return (
            this.cache.size >= this.MAX_CACHE_SIZE ||
            this.stats.memoryUsage >= memoryLimitBytes
        );
    }

    /**
     * 从缓存获取数据
     */
    get(key: string): any | null {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return null;
        }

        if (entry.expiry <= Date.now()) {
            this.stats.memoryUsage -= entry.size;
            this.cache.delete(key);
            this.stats.misses++;
            return null;
        }

        entry.hits++;
        this.stats.hits++;

        return entry.value;
    }

    /**
     * 设置缓存
     */
    set(key: string, value: any, ttl: number = this.DEFAULT_TTL): void {
        while (this.shouldEvict()) {
            this.evictLRU();
        }

        const size = this.estimateSize(value);

        const oldEntry = this.cache.get(key);
        if (oldEntry) {
            this.stats.memoryUsage -= oldEntry.size;
        }

        this.cache.set(key, {
            value,
            expiry: Date.now() + ttl,
            hits: 0,
            size,
            createdAt: Date.now(),
        });

        this.stats.memoryUsage += size;
    }

    /**
     * 删除缓存
     */
    delete(key: string): boolean {
        const entry = this.cache.get(key);
        if (entry) {
            this.stats.memoryUsage -= entry.size;
            return this.cache.delete(key);
        }
        return false;
    }

    /**
     * 清除匹配模式的缓存
     */
    clear(pattern?: string): void {
        if (!pattern) {
            this.cache.clear();
            this.stats.memoryUsage = 0;
            return;
        }

        const keysToDelete: string[] = [];
        for (const key of this.cache.keys()) {
            if (key.startsWith(pattern)) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.delete(key);
        }
    }

    /**
     * 防止缓存击穿：确保同一个 key 不会并发加载
     */
    async getOrLoad<T>(
        key: string,
        loader: () => Promise<T>,
        ttl: number = this.DEFAULT_TTL
    ): Promise<T> {
        const cached = this.get(key);
        if (cached !== null) {
            return cached;
        }

        const loadingPromise = this.loading.get(key);
        if (loadingPromise) {
            return await loadingPromise;
        }

        const promise = (async () => {
            try {
                const value = await loader();

                if (value === null || value === undefined) {
                    this.set(key, null, Math.min(ttl, 5000));
                } else {
                    this.set(key, value, ttl);
                }

                return value;
            } finally {
                this.loading.delete(key);
            }
        })();

        this.loading.set(key, promise);
        return await promise;
    }

    /**
     * 获取缓存统计信息
     */
    getStats(): CacheStats {
        const total = this.stats.hits + this.stats.misses;
        const hitRate =
            total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) : '0.00';

        return {
            ...this.stats,
            size: this.cache.size,
            hitRate: `${hitRate}%`,
            memoryUsage: this.stats.memoryUsage,
        };
    }

    /**
     * 关闭缓存管理器
     */
    shutdown(): void {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.cache.clear();
        this.loading.clear();
        console.log('🛑 缓存管理器已关闭');
    }
}

// 导出全局缓存实例
export const cacheManager = new CacheManager();

