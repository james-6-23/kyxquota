# 坤呗梯度额度与逾期扣除功能 - 实现完成

## 实现时间
2025-10-29

## 功能概述
1. **梯度额度配置**: 根据用户余额动态调整最大可借款额度
   - 余额小于10000时，可借10000
   - 余额小于100000时，可借100000
   - 管理员可自定义配置梯度

2. **逾期扣除所有额度**: 用户逾期未还款时扣除其所有额度作为惩罚

## 技术实现

### 1. 数据库结构 (src/migrations/add-kunbei-gradient.ts)
- 创建 `kunbei_gradient_configs` 表：
  - `quota_threshold`: 额度阈值
  - `max_loan_amount`: 最大可借金额
  - `priority`: 优先级（数字越大优先级越高）
  - `is_active`: 是否启用

- 在 `kunbei_config` 表添加字段：
  - `deduct_all_quota_on_overdue`: 是否在逾期时扣除所有额度

### 2. 后端逻辑

#### 2.1 梯度额度计算 (src/services/kunbei.ts)
```typescript
export function calculateUserMaxLoanAmount(linuxDoId: string): number {
  const userQuota = getUserQuota(linuxDoId);
  const gradientConfigs = kunbeiQueries.getGradientConfigs.all();
  
  // 根据用户额度匹配梯度配置
  for (const gradient of gradientConfigs) {
    if (userQuota < gradient.quota_threshold) {
      return gradient.max_loan_amount;
    }
  }
  
  return config.max_loan_amount; // 默认最大值
}
```

#### 2.2 逾期扣除额度 (src/services/kunbei.ts)
```typescript
export async function checkOverdueLoans(): Promise<number> {
  // ... 处理逾期借款
  if (config.deduct_all_quota_on_overdue) {
    const userQuota = getUserQuota(loan.linux_do_id);
    if (userQuota > 0) {
      await deductQuota(loan.linux_do_id, userQuota);
    }
  }
}
```

### 3. 管理员界面 (src/templates/admin.html)

#### 3.1 梯度配置管理
- 添加/编辑/删除梯度配置
- 设置额度阈值、最大借款金额、优先级
- 启用/禁用配置

#### 3.2 逾期扣除配置
- 复选框控制是否启用逾期扣除所有额度

### 4. 用户界面更新 (src/templates/user.html)

#### 4.1 动态显示最大可借额度
- 根据用户当前余额显示对应的最大可借额度
- 滑块和金额限制自动调整

#### 4.2 规则说明更新
- 显示用户当前的最大可借额度
- 提示最大可借额度根据余额动态调整

## API 端点

### 梯度配置管理
- `GET /api/admin/kunbei/gradient-configs` - 获取所有梯度配置
- `POST /api/admin/kunbei/gradient-configs` - 创建梯度配置
- `PUT /api/admin/kunbei/gradient-configs/:id` - 更新梯度配置
- `DELETE /api/admin/kunbei/gradient-configs/:id` - 删除梯度配置

## 默认配置
- 余额 < $20 (10000) → 可借 $20 (10000)
- 余额 < $200 (100000) → 可借 $200 (100000)
- 逾期扣除所有额度：默认启用

## 使用场景
1. **新用户保护**: 余额较少的用户可获得相对较高的借款额度
2. **风险控制**: 通过梯度限制大额借款
3. **逾期惩罚**: 严厉的逾期惩罚机制，扣除所有额度

## 测试要点
1. 不同余额用户的最大借款额度显示
2. 管理员添加/修改梯度配置后的生效情况
3. 用户逾期后是否正确扣除所有额度
4. 前端UI显示是否准确反映梯度限制

## 注意事项
1. 梯度配置按优先级从高到低匹配
2. 逾期扣除额度为异步操作，需要确保成功执行
3. 修改梯度配置后，用户需要刷新页面才能看到新的限制

## 完成状态
✅ 数据库迁移文件创建
✅ 后端逻辑实现
✅ 管理员界面完成
✅ 用户界面更新
✅ 所有功能测试通过
