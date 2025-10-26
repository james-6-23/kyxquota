/**
 * 搜索结果缓存
 * 避免重复搜索同一个用户
 */

interface SearchCacheEntry {
    result: any;
    timestamp: number;
}

class SearchCache {
    private cache: Map<string, SearchCacheEntry> = new Map();
    private readonly TTL = 30000; // 缓存30秒（搜索结果不常变）
    
    // 统计
    private hits = 0;
    private misses = 0;

    /**
     * 生成缓存键
     */
    private getKey(username: string, page: number): string {
        return `${username}:${page}`;
    }

    /**
     * 获取缓存的搜索结果
     */
    get(username: string, page: number = 1): any | null {
        const key = this.getKey(username, page);
        const entry = this.cache.get(key);
        
        if (!entry) {
            this.misses++;
            return null;
        }
        
        // 检查是否过期
        const now = Date.now();
        if (now - entry.timestamp > this.TTL) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }
        
        this.hits++;
        return entry.result;
    }

    /**
     * 设置缓存
     */
    set(username: string, page: number, result: any): void {
        const key = this.getKey(username, page);
        this.cache.set(key, {
            result,
            timestamp: Date.now()
        });
    }

    /**
     * 清理过期缓存
     */
    cleanup(): void {
        const now = Date.now();
        const toDelete: string[] = [];
        
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.TTL) {
                toDelete.push(key);
            }
        }
        
        toDelete.forEach(key => this.cache.delete(key));
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
export const searchCache = new SearchCache();

// 每15秒清理一次过期缓存
setInterval(() => {
    searchCache.cleanup();
}, 15000);

