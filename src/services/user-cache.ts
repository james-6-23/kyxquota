/**
 * 用户信息缓存
 * 用于减少对 KYX API 的重复查询，从根源上避免 429 错误
 */

import { KyxUser } from './kyx-api';

interface CacheEntry {
    user: KyxUser;
    timestamp: number;
}

class UserCache {
    private cache: Map<number, CacheEntry> = new Map();
    private readonly TTL = 120000; // 缓存2分钟（大幅减少查询频率，从5秒提升到2分钟）

    // 统计
    private hits = 0;
    private misses = 0;

    /**
     * 获取缓存的用户信息
     */
    get(userId: number): KyxUser | null {
        const entry = this.cache.get(userId);

        if (!entry) {
            this.misses++;
            return null;
        }

        // 检查是否过期
        const now = Date.now();
        if (now - entry.timestamp > this.TTL) {
            this.cache.delete(userId);
            this.misses++;
            return null;
        }

        this.hits++;
        return entry.user;
    }

    /**
     * 设置缓存
     */
    set(userId: number, user: KyxUser): void {
        this.cache.set(userId, {
            user,
            timestamp: Date.now()
        });
    }

    /**
     * 更新用户额度（同时更新缓存）
     */
    updateQuota(userId: number, newQuota: number): void {
        const entry = this.cache.get(userId);
        if (entry) {
            entry.user.quota = newQuota;
            entry.timestamp = Date.now(); // 刷新时间
        }
    }

    /**
     * 删除指定用户的缓存
     */
    delete(userId: number): void {
        this.cache.delete(userId);
    }

    /**
     * 清理过期缓存
     */
    cleanup(): void {
        const now = Date.now();
        const toDelete: number[] = [];

        for (const [userId, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.TTL) {
                toDelete.push(userId);
            }
        }

        toDelete.forEach(userId => this.cache.delete(userId));
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const total = this.hits + this.misses;
        const hitRate = total > 0 ? (this.hits / total * 100).toFixed(2) : '0.00';

        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: `${hitRate}%`,
            total
        };
    }

    /**
     * 清空缓存
     */
    clear(): void {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
}

// 全局缓存实例
export const userCache = new UserCache();

// 每10秒清理一次过期缓存
setInterval(() => {
    userCache.cleanup();
}, 10000);

