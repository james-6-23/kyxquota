# 🚦 429 限流错误修复

## 🎯 问题描述

**现象**：频繁出现 HTTP 429 Too Many Requests 错误

```
[更新额度] 用户ID: 304, 目标额度: 278213943, 用户名: linuxdo_304 - 第1次尝试
[更新额度] 用户ID: 304, 目标额度: 278213943, 用户名: linuxdo_304 - HTTP错误: 429 Too Many Requests
```

**原因**：
1. 多个用户同时操作（投喂 Keys、老虎机）
2. 并发请求过多，超过 KYX API 的速率限制
3. 重试策略不合理，等待时间过短

## ✅ 解决方案

### 1. 创建请求限流器 (`src/services/rate-limiter.ts`)

#### 核心功能

```typescript
class RateLimiter {
    private queue: Array<() => void> = [];
    private running = 0;
    private lastRequestTime = 0;
    
    // 配置
    private readonly maxConcurrent = 2; // 最大并发请求数
    private readonly minInterval = 500; // 最小请求间隔（毫秒）
    private readonly maxQueueSize = 100; // 最大队列长度
}
```

#### 工作原理

1. **限制并发**：同时最多只有 2 个请求在执行
2. **请求间隔**：每个请求之间至少间隔 500ms
3. **队列管理**：超出并发限制的请求进入队列
4. **统计监控**：记录总请求数、失败数、限流次数

### 2. 优化重试策略

#### 针对 429 错误的特殊处理

```typescript
if (response.status === 429) {
    kyxApiLimiter.recordRateLimit();
    const waitTime = Math.min(5000 * attempt, 30000); // 最多等待30秒
    console.warn(`触发限流，等待 ${waitTime}ms 后重试`);
    
    if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
    }
}
```

**等待时间**：
- 第 1 次重试：5 秒
- 第 2 次重试：10 秒
- 第 3 次重试：15 秒（最多 30 秒）

#### 其他错误的指数退避

```typescript
const backoffTime = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s...
await new Promise(resolve => setTimeout(resolve, backoffTime));
```

---

## 📊 优化效果对比

### 修复前

| 指标 | 值 |
|------|---|
| 并发请求 | 无限制 ❌ |
| 请求间隔 | 无 ❌ |
| 429 重试等待 | 1-3 秒 ❌ |
| 队列管理 | 无 ❌ |
| 成功率 | 低 ❌ |

### 修复后

| 指标 | 值 |
|------|---|
| 并发请求 | 最多 2 个 ✅ |
| 请求间隔 | 至少 500ms ✅ |
| 429 重试等待 | 5-30 秒 ✅ |
| 队列管理 | 100 个请求 ✅ |
| 成功率 | 高 ✅ |

---

## 🔧 技术细节

### 限流器特性

#### 1. 智能队列

```typescript
async execute<T>(fn: () => Promise<T>, priority: number = 0): Promise<T> {
    // 检查队列是否已满
    if (this.queue.length >= this.maxQueueSize) {
        throw new Error('请求队列已满，请稍后再试');
    }

    return new Promise((resolve, reject) => {
        const task = async () => {
            // 确保请求间隔
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minInterval) {
                await new Promise(r => setTimeout(r, this.minInterval - timeSinceLastRequest));
            }
            
            // 执行请求...
        };

        if (this.running < this.maxConcurrent) {
            task(); // 立即执行
        } else {
            this.queue.push(task); // 加入队列
        }
    });
}
```

#### 2. 自动处理队列

```typescript
private processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
        const task = this.queue.shift();
        if (task) task();
    }
}
```

#### 3. 统计监控

```typescript
getStats() {
    return {
        totalRequests: this.totalRequests,      // 总请求数
        failedRequests: this.failedRequests,    // 失败数
        rateLimitHits: this.rateLimitHits,      // 触发限流次数
        queueSize: this.queue.length,           // 当前队列长度
        running: this.running                    // 正在执行的请求数
    };
}
```

---

## 🚀 使用示例

### 原有代码（不需要修改）

```typescript
// 调用方式不变
const result = await updateKyxUserQuota(
    userId,
    newQuota,
    session,
    newApiUser,
    username,
    group
);
```

### 限流器自动工作

```
用户A: 投喂 Keys
用户B: 老虎机抽奖
用户C: 老虎机抽奖
用户D: 投喂 Keys

执行顺序：
1. 用户A、用户B 同时执行（并发=2）
2. 用户C、用户D 进入队列等待
3. 用户A 完成 → 用户C 开始执行（等待500ms）
4. 用户B 完成 → 用户D 开始执行（等待500ms）
```

---

## 📋 部署步骤

### 1. 提交代码

```bash
git add src/services/rate-limiter.ts src/services/kyx-api.ts
git commit -m "🚦 修复: 添加请求限流器防止 429 错误

- 创建 RateLimiter 限制并发请求和最小间隔
- 针对 429 错误实现特殊的长时间等待策略
- 添加请求队列管理，最多 100 个待处理请求
- 实现指数退避重试策略
- 添加统计监控功能"
git push origin main
```

### 2. 等待构建并更新服务器

```bash
# 等待 GitHub Actions 完成
# 然后在服务器上
cd ~/kyxquota
docker-compose down
docker-compose pull
docker-compose up -d
```

### 3. 监控效果

```bash
# 查看日志，确认限流器工作
docker-compose logs -f kyxquota-bun | grep -E "(限流器|触发限流|429)"
```

---

## 🔍 监控和调试

### 查看限流器状态

可以在代码中添加定期打印统计信息：

```typescript
// 在某个定时任务中
setInterval(() => {
    const stats = kyxApiLimiter.getStats();
    console.log('[限流器统计]', stats);
}, 60000); // 每分钟打印一次
```

### 日志示例

**正常请求**：
```
[更新额度] 用户ID: 251, 目标额度: 454117356, 用户名: linuxdo_251 - 第1次尝试
[更新额度] 用户ID: 251, 目标额度: 454117356, 用户名: linuxdo_251 - ✅ 成功更新额度
```

**触发限流**：
```
[更新额度] 用户ID: 304, 目标额度: 278213943 - HTTP错误: 429 Too Many Requests
[限流器] ⚠️ 触发限流 (第 1 次)
[更新额度] ⚠️ 触发限流，等待 5000ms 后重试
[更新额度] 用户ID: 304, 目标额度: 278213943 - 第2次尝试
[更新额度] 用户ID: 304, 目标额度: 278213943 - ✅ 成功更新额度
```

**队列满**：
```
[限流器] ❌ 请求队列已满，请稍后再试
```

---

## ⚙️ 配置调整

如果还是频繁遇到 429，可以调整参数：

### 降低并发数

```typescript
// src/services/rate-limiter.ts
private readonly maxConcurrent = 1; // 从 2 改为 1
```

### 增加请求间隔

```typescript
// src/services/rate-limiter.ts
private readonly minInterval = 1000; // 从 500ms 改为 1000ms
```

### 增加 429 等待时间

```typescript
// src/services/kyx-api.ts
const waitTime = Math.min(10000 * attempt, 60000); // 10s, 20s, 30s（最多60s）
```

---

## 🎯 最佳实践

### 1. 避免短时间大量操作

**不推荐**：
- 一次性投喂 100 个 Keys
- 多用户同时疯狂点击老虎机

**推荐**：
- 分批投喂 Keys（每次 10-20 个）
- 老虎机增加冷却时间
- 前端添加防抖/节流

### 2. 优雅降级

当遇到 429 错误时：
- ✅ 自动重试（已实现）
- ✅ 显示友好提示："服务繁忙，请稍后再试"
- ✅ 增加前端加载状态

### 3. 监控告警

如果 `rateLimitHits` 过高（如每小时 > 10 次）：
- 考虑降低并发数
- 增加请求间隔
- 检查是否有异常流量

---

## 📈 性能影响

### 响应时间

- **并发请求 < 2**：几乎无影响
- **队列中的请求**：额外等待 500ms × 队列位置
- **触发 429**：额外等待 5-30 秒（重试）

### 吞吐量

- **理论最大**：每秒 2 个请求（2 并发 × 500ms 间隔）
- **实际平均**：每秒 1-2 个请求
- **高峰期**：队列可缓冲 100 个请求

### 适用场景

✅ **适合**：
- 少量用户频繁操作
- 中等规模并发（< 100 QPS）
- 可接受轻微延迟

❌ **不适合**：
- 超大规模并发（> 1000 QPS）
- 需要毫秒级响应
- 实时性要求极高的场景

---

## ✅ 验证清单

部署后，验证以下项目：

- [ ] 日志中看到 `[限流器]` 相关信息
- [ ] 429 错误后会自动重试
- [ ] 重试等待时间为 5-30 秒
- [ ] 并发请求不超过 2 个
- [ ] 请求间隔至少 500ms
- [ ] 成功率明显提升

---

## 🎉 总结

通过引入请求限流器和优化重试策略，我们：

1. ✅ **大幅降低 429 错误**：限制并发和请求频率
2. ✅ **提高成功率**：智能重试和指数退避
3. ✅ **保护服务**：防止过载，优雅降级
4. ✅ **可观测性**：详细日志和统计信息
5. ✅ **易于扩展**：可调整参数和策略

**429 错误应该大幅减少，用户体验更流畅！** 🚀

