// 全局变量
let currentTab = 'pairs';
let riskChart = null;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadTradingPairs();
    initRiskChart();
    
    // 每30秒刷新统计数据
    setInterval(loadStats, 30000);
});

// 切换Tab
function switchTab(tab) {
    currentTab = tab;
    
    // 更新Tab按钮样式
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.className = 'tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm';
    });
    event.target.className = 'tab-btn border-indigo-500 text-indigo-600 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm';
    
    // 显示对应内容
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    document.getElementById(`${tab}-tab`).classList.remove('hidden');
    
    // 加载对应数据
    switch(tab) {
        case 'pairs':
            loadTradingPairs();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'risk':
            loadRiskData();
            break;
        case 'config':
            loadConfig();
            break;
    }
}

// 加载统计数据
async function loadStats() {
    try {
        // 加载总订单数
        const ordersRes = await fetch('/api/crypto/admin/stats/orders');
        const ordersData = await ordersRes.json();
        if (ordersData.success) {
            document.getElementById('totalOrders').textContent = ordersData.total.toLocaleString();
        }
        
        // 加载24h成交量
        const volumeRes = await fetch('/api/crypto/ticker?symbol=QUOTA/KC');
        const volumeData = await volumeRes.json();
        if (volumeData.success && volumeData.ticker) {
            document.getElementById('volume24h').textContent = volumeData.ticker.volume_24h.toFixed(2);
        }
        
        // 加载活跃用户
        const usersRes = await fetch('/api/crypto/admin/stats/active-users');
        const usersData = await usersRes.json();
        if (usersData.success) {
            document.getElementById('activeUsers').textContent = usersData.count.toLocaleString();
        }
        
        // 加载风险警报
        const riskRes = await fetch('/api/crypto/admin/risk-stats');
        const riskData = await riskRes.json();
        if (riskData.success) {
            const criticalCount = riskData.riskGroups.critical.length;
            const highCount = riskData.riskGroups.high.length;
            document.getElementById('riskAlerts').textContent = criticalCount + highCount;
        }
    } catch (error) {
        console.error('加载统计数据失败:', error);
    }
}

// 加载交易对列表
async function loadTradingPairs() {
    try {
        const response = await fetch('/api/crypto/pairs');
        const data = await response.json();
        
        if (data.success && data.pairs) {
            const tbody = document.getElementById('pairsTableBody');
            tbody.innerHTML = '';
            
            for (const pair of data.pairs) {
                // 获取当前价格
                const tickerRes = await fetch(`/api/crypto/ticker?symbol=${pair.symbol}`);
                const tickerData = await tickerRes.json();
                const ticker = tickerData.success ? tickerData.ticker : null;
                
                const row = document.createElement('tr');
                row.className = 'hover:bg-gray-50';
                row.innerHTML = `
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="flex items-center">
                            <span class="font-medium text-gray-900">${pair.symbol}</span>
                        </div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="text-gray-900">${ticker ? ticker.last_price.toFixed(2) : '-'}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="text-gray-900">${ticker ? ticker.volume_24h.toFixed(2) : '-'}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="px-2 py-1 text-xs rounded-full ${pair.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                            ${pair.enabled ? '启用' : '禁用'}
                        </span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">
                        <button onclick="togglePair('${pair.symbol}')" class="text-indigo-600 hover:text-indigo-900 mr-3">
                            ${pair.enabled ? '禁用' : '启用'}
                        </button>
                        <button onclick="editPair('${pair.symbol}')" class="text-blue-600 hover:text-blue-900">
                            编辑
                        </button>
                    </td>
                `;
                tbody.appendChild(row);
            }
        }
    } catch (error) {
        console.error('加载交易对失败:', error);
        document.getElementById('pairsTableBody').innerHTML = `
            <tr><td colspan="5" class="px-6 py-8 text-center text-red-500">加载失败</td></tr>
        `;
    }
}

// 加载订单列表
async function loadOrders() {
    try {
        const status = document.getElementById('orderStatusFilter').value;
        const url = status ? `/api/crypto/admin/orders?status=${status}&limit=100` : '/api/crypto/admin/orders?limit=100';
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.success && data.orders) {
            const tbody = document.getElementById('ordersTableBody');
            tbody.innerHTML = '';
            
            data.orders.forEach(order => {
                const row = document.createElement('tr');
                row.className = 'hover:bg-gray-50';
                
                const sideClass = order.side === 'buy' ? 'text-green-600' : 'text-red-600';
                const typeText = order.order_type === 'limit' ? '限价' : '市价';
                const statusMap = {
                    'pending': { text: '待成交', class: 'bg-yellow-100 text-yellow-800' },
                    'partial_filled': { text: '部分成交', class: 'bg-blue-100 text-blue-800' },
                    'filled': { text: '已成交', class: 'bg-green-100 text-green-800' },
                    'cancelled': { text: '已取消', class: 'bg-gray-100 text-gray-800' },
                };
                const status = statusMap[order.status] || { text: order.status, class: 'bg-gray-100 text-gray-800' };
                
                row.innerHTML = `
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-mono">${order.order_id.substring(0, 8)}...</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">${order.username}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">${order.symbol}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">
                        <span class="${sideClass} font-medium">${order.side === 'buy' ? '买入' : '卖出'}</span>
                        <span class="text-gray-500 ml-1">${typeText}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">${order.price ? order.price.toFixed(2) : '市价'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">${order.amount.toFixed(4)}</td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="px-2 py-1 text-xs rounded-full ${status.class}">${status.text}</span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        ${new Date(order.created_at).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                `;
                tbody.appendChild(row);
            });
            
            if (data.orders.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="px-6 py-8 text-center text-gray-500">暂无订单</td></tr>';
            }
        }
    } catch (error) {
        console.error('加载订单失败:', error);
        document.getElementById('ordersTableBody').innerHTML = `
            <tr><td colspan="8" class="px-6 py-8 text-center text-red-500">加载失败</td></tr>
        `;
    }
}

// 加载风控数据
async function loadRiskData() {
    try {
        const response = await fetch('/api/crypto/admin/risk-stats');
        const data = await response.json();
        
        if (data.success) {
            // 更新风险用户列表
            const usersList = document.getElementById('riskUsersList');
            usersList.innerHTML = '';
            
            const criticalUsers = data.riskGroups.critical || [];
            const highUsers = data.riskGroups.high || [];
            const riskUsers = [...criticalUsers, ...highUsers].slice(0, 10);
            
            if (riskUsers.length === 0) {
                usersList.innerHTML = '<p class="text-center text-gray-500 py-8">暂无高风险用户</p>';
            } else {
                riskUsers.forEach(user => {
                    const levelClass = user.risk_level === 'critical' ? 'bg-red-100 text-red-800' : 'bg-orange-100 text-orange-800';
                    const levelText = user.risk_level === 'critical' ? '严重' : '高';
                    
                    const card = document.createElement('div');
                    card.className = 'border border-gray-200 rounded-lg p-4';
                    card.innerHTML = `
                        <div class="flex justify-between items-start">
                            <div>
                                <p class="font-medium text-gray-900">${user.linuxDoId}</p>
                                <p class="text-sm text-gray-500 mt-1">
                                    总订单: ${user.total_orders} | 总交易: ${user.total_trades}<br>
                                    撤单率: ${(user.cancel_rate * 100).toFixed(1)}% | 胜率: ${(user.win_rate * 100).toFixed(1)}%
                                </p>
                            </div>
                            <span class="px-2 py-1 text-xs rounded-full ${levelClass}">${levelText}</span>
                        </div>
                    `;
                    usersList.appendChild(card);
                });
            }
            
            // 更新风险等级图表
            updateRiskChart(data.riskGroups);
        }
    } catch (error) {
        console.error('加载风控数据失败:', error);
    }
}

// 初始化风险图表
function initRiskChart() {
    const ctx = document.getElementById('riskChart').getContext('2d');
    riskChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['低风险', '中风险', '高风险', '严重'],
            datasets: [{
                data: [0, 0, 0, 0],
                backgroundColor: [
                    'rgba(34, 197, 94, 0.8)',
                    'rgba(234, 179, 8, 0.8)',
                    'rgba(249, 115, 22, 0.8)',
                    'rgba(239, 68, 68, 0.8)'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'bottom',
                }
            }
        }
    });
}

// 更新风险图表
function updateRiskChart(riskGroups) {
    if (riskChart) {
        riskChart.data.datasets[0].data = [
            riskGroups.low.length,
            riskGroups.medium.length,
            riskGroups.high.length,
            riskGroups.critical.length,
        ];
        riskChart.update();
    }
}

// 加载配置
async function loadConfig() {
    try {
        const response = await fetch('/api/crypto/config');
        const data = await response.json();
        
        if (data.success && data.config) {
            const config = data.config;
            document.getElementById('makerFee').value = (config.maker_fee_rate * 100).toFixed(2);
            document.getElementById('takerFee').value = (config.taker_fee_rate * 100).toFixed(2);
            document.getElementById('maxDailyTrades').value = config.max_daily_trades;
            document.getElementById('maxOrdersPerUser').value = config.max_orders_per_user;
            document.getElementById('priceFluctuationLimit').value = (config.price_fluctuation_limit * 100).toFixed(2);
            document.getElementById('maxPositionValueRatio').value = (config.max_position_value_ratio * 100).toFixed(2);
        }
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}

// 保存配置
async function saveConfig() {
    try {
        const config = {
            maker_fee_rate: parseFloat(document.getElementById('makerFee').value) / 100,
            taker_fee_rate: parseFloat(document.getElementById('takerFee').value) / 100,
            max_daily_trades: parseInt(document.getElementById('maxDailyTrades').value),
            max_orders_per_user: parseInt(document.getElementById('maxOrdersPerUser').value),
            price_fluctuation_limit: parseFloat(document.getElementById('priceFluctuationLimit').value) / 100,
            max_position_value_ratio: parseFloat(document.getElementById('maxPositionValueRatio').value) / 100,
        };
        
        const response = await fetch('/api/crypto/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ 配置保存成功！');
        } else {
            alert('❌ 保存失败: ' + data.error);
        }
    } catch (error) {
        console.error('保存配置失败:', error);
        alert('❌ 保存失败，请稍后重试');
    }
}

// 切换交易对状态
async function togglePair(symbol) {
    if (!confirm(`确认要切换 ${symbol} 的状态吗？`)) {
        return;
    }
    
    try {
        const response = await fetch('/api/crypto/admin/pair/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ 操作成功！');
            loadTradingPairs();
        } else {
            alert('❌ 操作失败: ' + data.error);
        }
    } catch (error) {
        console.error('切换交易对状态失败:', error);
        alert('❌ 操作失败，请稍后重试');
    }
}

// 编辑交易对
function editPair(symbol) {
    // TODO: 实现编辑功能
    alert('编辑功能待实现');
}

// 添加交易对
function addTradingPair() {
    // TODO: 实现添加功能
    alert('添加功能待实现');
}

// 刷新订单
function refreshOrders() {
    loadOrders();
}

// 过滤订单
function filterOrders() {
    loadOrders();
}

