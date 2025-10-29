# 坤呗借款/还款立即更新余额 - 修复完成

## 修复时间
2025-10-29

## 问题描述
用户在娱乐站（老虎机）页面进行坤呗借款后，右上角的余额显示没有立即更新，需要刷新页面或切换页面才能看到最新余额。

## 修复内容

### 1. 借款成功后立即更新余额 (src/templates/user.html)
在 `confirmKunbeiBorrow` 函数中，当借款成功后：
- 立即更新 `slotUserData.quota` 增加借款金额
- 同步更新页面上的余额显示元素：
  - `slotQuota` - 桌面端余额显示
  - `slotQuotaMobile` - 移动端余额显示

```javascript
// 🔥 更新老虎机页面的额度显示
if (currentMode === 'entertain' && slotUserData) {
  // 增加额度
  slotUserData.quota = (slotUserData.quota || 0) + kunbeiCurrentAmount;
  // 立即更新UI显示
  const quotaText = `$${(slotUserData.quota / 500000).toFixed(2)}`;
  const slotQuotaEl = document.getElementById('slotQuota');
  const slotQuotaMobileEl = document.getElementById('slotQuotaMobile');
  if (slotQuotaEl) slotQuotaEl.textContent = quotaText;
  if (slotQuotaMobileEl) slotQuotaMobileEl.textContent = quotaText;
}
```

### 2. 还款成功后立即更新余额 (src/templates/user.html)
在 `confirmKunbeiRepay` 函数中，当还款成功后：
- 立即更新 `slotUserData.quota` 扣除实际还款金额
- 同步更新页面上的余额显示元素

```javascript
// 🔥 更新老虎机页面的额度显示
if (currentMode === 'entertain' && slotUserData && data.data) {
  // 扣除实际还款金额
  const actualRepayAmount = data.data.actual_amount || loan.repay_amount;
  slotUserData.quota = Math.max(0, (slotUserData.quota || 0) - actualRepayAmount);
  // 立即更新UI显示
  const quotaText = `$${(slotUserData.quota / 500000).toFixed(2)}`;
  const slotQuotaEl = document.getElementById('slotQuota');
  const slotQuotaMobileEl = document.getElementById('slotQuotaMobile');
  if (slotQuotaEl) slotQuotaEl.textContent = quotaText;
  if (slotQuotaMobileEl) slotQuotaMobileEl.textContent = quotaText;
}
```

## 技术细节
1. 仅当用户在娱乐站页面（`currentMode === 'entertain'`）时才进行余额更新
2. 使用 `Math.max(0, ...)` 确保余额不会变成负数
3. 同时更新桌面端和移动端的余额显示
4. 保持原有的 `loadQuota()` 调用，确保加油站页面的数据也同步更新

## 测试要点
1. 在娱乐站页面点击坤呗借款，借款成功后余额应立即增加
2. 在娱乐站页面点击坤呗还款，还款成功后余额应立即减少
3. 提前还款时应扣除实际还款金额（打折后的金额）
4. 切换到加油站页面时，余额显示应保持一致

## 完成状态
✅ 已完成所有修改
✅ 代码已保存
⏳ 等待部署验证
