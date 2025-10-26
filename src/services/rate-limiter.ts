/**
 * KYX API 请求限流器
 * 防止触发 429 Too Many Requests 错误
 */

class RateLimiter {
    private queue: Array<() => void> = [];
    private running = 0;
    private lastRequestTime = 0;

    // 配置（高性能配置，KYX API RPM=1000，配合缓存可以支持大量用户）
    private readonly maxConcurrent = 8; // 最大并发请求数（充分利用API容量）
    private readonly minInterval = 150; // 最小请求间隔（毫秒，流畅体验）
    private readonly maxQueueSize = 500; // 最大队列长度（通过队列缓冲峰值）

    // 统计
    private totalRequests = 0;
    private failedRequests = 0;
    private rateLimitHits = 0;
    
    // 动态速率调整
    private currentInterval = 150; // 当前实际间隔（可动态调整）
    private adaptiveMode = true; // 启用自适应模式（仅在触发429时才调整）

    /**
     * 执行受限的异步操作
     */
    async execute<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
        // 检查队列是否已满
        if (this.queue.length >= this.maxQueueSize) {
            console.warn(`[限流器] ⚠️ 队列已满 (${this.maxQueueSize}/${this.maxQueueSize})，拒绝新请求`);
            throw new Error('请求队列已满，请稍后再试');
        }

        return new Promise((resolve, reject) => {
            const task = async () => {
                try {
                    this.running++;
                    this.totalRequests++;

                    // 使用动态间隔
                    const effectiveInterval = this.adaptiveMode ? this.currentInterval : this.minInterval;

                    // 确保请求间隔
                    const now = Date.now();
                    const timeSinceLastRequest = now - this.lastRequestTime;
                    if (timeSinceLastRequest < effectiveInterval) {
                        const waitTime = effectiveInterval - timeSinceLastRequest;
                        // 只在等待时间较长时才记录日志（减少日志输出）
                        if (waitTime > 1000) {
                            console.log(`[限流器] ⏱️ 等待 ${waitTime}ms（队列: ${this.queue.length}）`);
                        }
                        await new Promise(r => setTimeout(r, waitTime));
                    }

                    this.lastRequestTime = Date.now();
                    const result = await fn();
                    
                    // 成功后快速恢复正常速率（有高RPM支持，可以快速恢复）
                    if (this.adaptiveMode && this.currentInterval > this.minInterval) {
                        // 每次减少 100ms，快速恢复到正常速率
                        this.currentInterval = Math.max(this.minInterval, this.currentInterval - 100);
                    }

                    resolve(result);
                } catch (error) {
                    this.failedRequests++;
                    reject(error);
                } finally {
                    this.running--;
                    this.processQueue();
                }
            };

            if (this.running < this.maxConcurrent) {
                task();
            } else {
                this.queue.push(task);
            }
        });
    }

    /**
     * 处理队列中的任务
     */
    private processQueue() {
        if (this.queue.length > 0 && this.running < this.maxConcurrent) {
            const task = this.queue.shift();
            if (task) task();
        }
    }

    /**
     * 记录触发限流，并动态增加间隔
     */
    recordRateLimit() {
        this.rateLimitHits++;

        // 自适应调整：温和增加请求间隔（有高RPM支持，不需要太激进）
        if (this.adaptiveMode) {
            const oldInterval = this.currentInterval;
            // 温和增加：每次增加 150ms，最多到 800ms（保持响应速度）
            this.currentInterval = Math.min(this.currentInterval + 150, 800);
            
            // 只在间隔变化时才输出日志（避免日志过多）
            if (oldInterval !== this.currentInterval) {
                console.warn(`[限流器] ⚠️ 触发限流 (第 ${this.rateLimitHits} 次) - 动态调整: ${oldInterval}ms → ${this.currentInterval}ms`);
            }
        } else {
            // 每10次才输出一次（减少日志）
            if (this.rateLimitHits % 10 === 0) {
                console.warn(`[限流器] ⚠️ 触发限流 (第 ${this.rateLimitHits} 次)`);
            }
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            totalRequests: this.totalRequests,
            failedRequests: this.failedRequests,
            rateLimitHits: this.rateLimitHits,
            queueSize: this.queue.length,
            running: this.running,
            currentInterval: this.currentInterval,
            adaptiveMode: this.adaptiveMode
        };
    }

    /**
     * 清空队列
     */
    clear() {
        this.queue = [];
        console.log('[限流器] 队列已清空');
    }
}

// 全局限流器实例
export const kyxApiLimiter = new RateLimiter();

