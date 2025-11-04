/**
 * KYX API 请求限流器
 * 防止触发 429 Too Many Requests 错误
 */

class RateLimiter {
    private queue: Array<() => void> = [];
    private running = 0;
    private lastRequestTime = 0;

    // 配置（高并发优化：提高吞吐量，智能动态调整）
    // KYX API RPM=1000 约等于 16.7 QPS
    // 优化策略：100并发 + 50ms间隔 = 理论 20 QPS（接近API上限，动态调整保障稳定）
    private readonly maxConcurrent = 100; // 最大并发请求数（大幅提高，应对高并发场景）
    private readonly minInterval = 50; // 最小请求间隔（50ms，提高吞吐量）
    private readonly maxQueueSize = 10000; // 最大队列长度（扩大队列，避免请求被拒绝）
    private readonly maxInterval = 1000; // 最大间隔（1秒，限流时的上限）

    // 统计
    private totalRequests = 0;
    private failedRequests = 0;
    private rateLimitHits = 0;
    private successCount = 0; // 连续成功次数（用于恢复速率）

    // 动态速率调整
    private currentInterval = 50; // 当前实际间隔（从50ms起始）
    private adaptiveMode = true; // 启用自适应模式（触发429时才调整）

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

                    // 成功后逐步恢复正常速率（智能恢复）
                    if (this.adaptiveMode && this.currentInterval > this.minInterval) {
                        this.successCount++;
                        // 每5次成功减少20ms，更快恢复到正常速率
                        if (this.successCount >= 5) {
                            this.currentInterval = Math.max(this.minInterval, this.currentInterval - 20);
                            this.successCount = 0;
                            if (this.currentInterval === this.minInterval) {
                                console.log(`[限流器] ✅ 已恢复到正常速率 (${this.minInterval}ms)`);
                            }
                        }
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
        this.successCount = 0; // 重置成功计数

        // 自适应调整：触发429时快速增加间隔
        if (this.adaptiveMode) {
            const oldInterval = this.currentInterval;
            
            // 智能增加策略：
            // - 如果间隔较小（< 200ms），大幅增加（+200ms）
            // - 如果间隔中等（200-500ms），中等增加（+150ms）
            // - 如果间隔较大（> 500ms），小幅增加（+100ms）
            let increment = 200;
            if (this.currentInterval >= 200 && this.currentInterval < 500) {
                increment = 150;
            } else if (this.currentInterval >= 500) {
                increment = 100;
            }
            
            this.currentInterval = Math.min(this.currentInterval + increment, this.maxInterval);

            // 只在间隔变化时才输出日志（避免日志过多）
            if (oldInterval !== this.currentInterval) {
                console.warn(`[限流器] ⚠️ 触发限流 (第 ${this.rateLimitHits} 次) - 动态调整: ${oldInterval}ms → ${this.currentInterval}ms (队列: ${this.queue.length})`);
            } else {
                // 已经到达最大间隔，仅每100次输出一次
                if (this.rateLimitHits % 100 === 0) {
                    console.warn(`[限流器] ⚠️ 持续限流 (第 ${this.rateLimitHits} 次) - 当前间隔: ${this.currentInterval}ms (已达上限)`);
                }
            }
        } else {
            // 每50次才输出一次（减少日志）
            if (this.rateLimitHits % 50 === 0) {
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
            successCount: this.successCount,
            queueSize: this.queue.length,
            running: this.running,
            currentInterval: this.currentInterval,
            maxConcurrent: this.maxConcurrent,
            minInterval: this.minInterval,
            maxInterval: this.maxInterval,
            adaptiveMode: this.adaptiveMode,
            rateLimitRate: this.totalRequests > 0 ? (this.rateLimitHits / this.totalRequests * 100).toFixed(2) + '%' : '0%'
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

