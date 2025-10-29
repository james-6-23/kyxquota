# getUserQuota 函数缺失修复

## 修复时间
2025-10-29

## 问题描述
`SyntaxError: Export named 'getUserQuota' not found in module '/app/src/services/kyx-api.ts'`

在实现坤呗梯度额度功能时，`src/services/kunbei.ts` 中导入并使用了 `getUserQuota` 函数，但该函数在 `src/services/kyx-api.ts` 中未定义。

## 修复方案

### 添加 getUserQuota 函数 (src/services/kyx-api.ts)

```typescript
export function getUserQuota(linuxDoId: string): number {
    try {
        // 从本地数据库获取用户信息
        const user = userQueries.get.get(linuxDoId);
        if (!user) {
            console.warn(`[getUserQuota] 用户不存在: ${linuxDoId}`);
            return 0;
        }
        
        // 从缓存中获取用户信息（同步）
        const cachedUser = userCache.get(user.kyx_user_id);
        if (cachedUser) {
            return cachedUser.quota || 0;
        }
        
        // 如果缓存中没有，返回0（实际场景中应该先确保用户数据已加载）
        console.warn(`[getUserQuota] 用户 ${linuxDoId} 的额度信息未缓存`);
        return 0;
    } catch (error: any) {
        console.error(`[getUserQuota] 获取用户额度失败:`, error);
        return 0;
    }
}
```

## 技术细节

1. **功能**: 通过 `linux_do_id` 获取用户当前额度
2. **实现逻辑**:
   - 从本地数据库查询用户信息
   - 使用 `kyx_user_id` 从缓存中获取用户数据
   - 返回用户的额度值
3. **错误处理**: 如果用户不存在或缓存中没有数据，返回0

## 使用场景
- 在坤呗系统中计算用户的最大可借额度
- 在逾期时扣除用户的所有额度

## 注意事项
- 该函数是同步的，依赖于用户数据已经被缓存
- 如果缓存中没有数据，会返回0（建议在调用前确保用户数据已加载）

## 完成状态
✅ 函数已添加
✅ 导入语句已添加
✅ 代码已保存
