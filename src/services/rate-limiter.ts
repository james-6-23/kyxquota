/**
 * KYX API 请求限流器
 * 防止触发 429 Too Many Requests 错误
 */

class RateLimiter {
    private queue: Array<() => void> = [];
    private running = 0;
    private lastRequestTime = 0;

    // 配置（保守策略，优先避免429而不是追求速度）
    private readonly maxConcurrent = 3; // 最大并发请求数（保守策略）
    private readonly minInterval = 500; // 最小请求间隔（毫秒，留有余地）
    private readonly maxQueueSize = 500; // 最大队列长度（通过队列缓冲峰值）

    // 统计
    private totalRequests = 0;
    private failedRequests = 0;
    private rateLimitHits = 0;
    
    // 动态速率调整
    private currentInterval = 500; // 当前实际间隔（可动态调整）
    private adaptiveMode = true; // 启用自适应模式

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

                    // 成功后缓慢恢复正常速率（避免立即再次触发429）
                    if (this.adaptiveMode && this.currentInterval > this.minInterval) {
                        // 每次只减少 50ms，更稳健的恢复策略
                        this.currentInterval = Math.max(this.minInterval, this.currentInterval - 50);
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

        // 自适应调整：快速增加请求间隔以避免持续触发429
        if (this.adaptiveMode) {
            const oldInterval = this.currentInterval;
            // 激进增加：每次增加 300ms，最多到 1.5 秒
            this.currentInterval = Math.min(this.currentInterval + 300, 1500);

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

