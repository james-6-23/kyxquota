# 高级场进度条调试指南

## 问题
高级场底部没有显示投注限额进度条，但 Toast 提示正常工作。

## 已实现的功能

### 1. HTML 结构
进度条已添加到底部统计区域，默认隐藏：
```html
<div id="dailyBetLimitBar" class="hidden mb-2 sm:mb-3">
  <div class="max-w-2xl mx-auto">
    <span id="dailyBetLimitTitle">今日投注额度限额</span>
    <span id="dailyBetProgress">$0 / $5,000</span>
    <div id="dailyBetProgressBar"></div>
    <p id="dailyBetWarning"></p>
  </div>
</div>
```

### 2. 更新函数
创建了独立的 `updateBetLimitProgressBar()` 函数：
- 检查 `isInAdvancedMode` 标志
- 高级场：移除 hidden 类，显示进度条
- 初级场：添加 hidden 类，隐藏进度条

### 3. 调用时机
在以下位置调用：
- `updateSlotUI()` - 每次UI更新时
- `updateAdvancedTicketsUI()` - 入场券信息更新后
- `showSlotMachine()` - 异步加载入场券后

## 调试步骤

### 第1步：打开浏览器开发者控制台
按 F12 或右键 -> 检查

### 第2步：查看控制台日志
刷新页面后，查找以下日志：

```
[进度条] ========== updateBetLimitProgressBar 被调用 ==========
[进度条] isInAdvancedMode: true/false
[进度条] slotUserData: {...}
[进度条] advancedTicketsData: {...}
[进度条] 找到元素 dailyBetLimitBar: <div>...</div>
[进度条] 元素当前 classList: DOMTokenList
```

### 第3步：检查关键信息

#### 如果看到 `isInAdvancedMode: false`
说明高级场标志没有正确设置，检查：
- 是否成功调用了 `/api/slot/tickets` 接口
- 服务器返回的 `in_advanced_mode` 字段是否为 true
- `updateAdvancedTicketsUI()` 是否被调用

#### 如果看到 `isInAdvancedMode: true`
说明标志正确，检查：
- `[进度条] ✅ 高级场模式 - 准备显示进度条` 是否出现
- `[进度条] ✅ 已移除 hidden 类` 是否出现
- `computed style display` 的值是什么

### 第4步：手动检查元素
在控制台执行：
```javascript
// 检查元素是否存在
console.log('进度条元素:', document.getElementById('dailyBetLimitBar'));

// 检查类名
console.log('类名:', document.getElementById('dailyBetLimitBar')?.className);

// 检查是否隐藏
console.log('是否隐藏:', document.getElementById('dailyBetLimitBar')?.classList.contains('hidden'));

// 检查计算后的样式
console.log('display 样式:', window.getComputedStyle(document.getElementById('dailyBetLimitBar')).display);

// 手动显示
document.getElementById('dailyBetLimitBar')?.classList.remove('hidden');
```

### 第5步：检查 isInAdvancedMode 标志
在控制台执行：
```javascript
console.log('isInAdvancedMode:', window.isInAdvancedMode || '未定义');
```

如果未定义，说明变量作用域有问题。

## 可能的问题

### 问题1：调用顺序
`updateBetLimitProgressBar()` 在 `isInAdvancedMode` 设置为 true 之前被调用。

**解决方案**：确保在 `updateAdvancedTicketsUI()` 设置 `isInAdvancedMode` 后立即调用。

### 问题2：异步加载延迟
`loadAdvancedTickets()` 是异步的，可能还没加载完就调用了 `updateSlotUI()`。

**解决方案**：使用 await 等待加载完成。

### 问题3：CSS 优先级
可能有其他 CSS 规则覆盖了显示状态。

**解决方案**：检查是否有 `!important` 规则或其他冲突样式。

## 快速测试
在浏览器控制台运行：
```javascript
// 强制显示进度条
document.getElementById('dailyBetLimitBar').classList.remove('hidden');
document.getElementById('dailyBetLimitBar').style.display = 'block';
```

如果进度条出现，说明是 JavaScript 逻辑问题；如果还是不出现，说明是 CSS 或 DOM 结构问题。

## 下一步
根据控制台日志输出，我们可以确定具体是哪一步出了问题，然后针对性地修复。
