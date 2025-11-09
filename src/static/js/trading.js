// 全局变量
let ws = null;
let currentSymbol = 'QUOTA/KC';
let currentSide = 'buy';
let currentOrderType = 'limit';
let currentInterval = '1d';
let currentChart = 'kline';
let chart = null;
let candlestickSeries = null;
let depthChart = null;
let userAssets = {};

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initUI();
    loadUserInfo();
    loadMarketData();
    initWebSocket();
    initChart();
    initDepthChart();
    loadOrderbook();
    loadRecentTrades();
    loadUserOrders();
    loadUserAssets();
    
    // 每30秒刷新一次市场数据
    setInterval(loadMarketData, 30000);
    
    // 每10秒刷新一次用户订单
    setInterval(loadUserOrders, 10000);
});

// 初始化UI事件
function initUI() {
    // 市场选择
    document.getElementById('marketSelect').addEventListener('change', (e) => {
        currentSymbol = e.target.value;
        loadMarketData();
        loadOrderbook();
        loadRecentTrades();
        loadKlineData();
        reconnectWebSocket();
    });

    // 买卖切换
    document.querySelectorAll('.order-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.order-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentSide = tab.dataset.side;
            updateOrderButton();
        });
    });

    // 订单类型切换
    document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentOrderType = btn.dataset.type;
            togglePriceInput();
        });
    });

    // K线周期切换
    document.querySelectorAll('[data-interval]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-interval]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentInterval = tab.dataset.interval;
            loadKlineData();
        });
    });

    // 图表切换
    document.querySelectorAll('[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentChart = tab.dataset.tab;
            toggleChart();
        });
    });

    // 提交订单
    document.getElementById('submitOrder').addEventListener('click', submitOrder);
}

// 加载用户信息
async function loadUserInfo() {
    try {
        const response = await fetch('/api/crypto/user/info');
        const data = await response.json();
        if (data.success) {
            document.getElementById('userName').textContent = data.user.username;
            document.getElementById('userAvatar').src = data.user.avatar || '/static/images/default-avatar.png';
        }
    } catch (error) {
        console.error('加载用户信息失败:', error);
    }
}

// 加载市场数据
async function loadMarketData() {
    try {
        const response = await fetch(`/api/crypto/ticker?symbol=${currentSymbol}`);
        const data = await response.json();
        if (data.success && data.ticker) {
            const ticker = data.ticker;
            document.getElementById('currentPrice').textContent = ticker.last_price.toFixed(2);
            document.getElementById('priceChange').textContent = `${ticker.change_24h > 0 ? '+' : ''}${(ticker.change_24h * 100).toFixed(2)}%`;
            document.getElementById('high24h').textContent = ticker.high_24h.toFixed(2);
            document.getElementById('low24h').textContent = ticker.low_24h.toFixed(2);
            document.getElementById('volume24h').textContent = ticker.volume_24h.toFixed(2);
            
            // 更新价格颜色
            const priceElement = document.getElementById('currentPrice');
            const changeElement = document.getElementById('priceChange');
            if (ticker.change_24h > 0) {
                priceElement.className = 'info-value price-up';
                changeElement.className = 'info-value price-up';
            } else {
                priceElement.className = 'info-value price-down';
                changeElement.className = 'info-value price-down';
            }
        }
    } catch (error) {
        console.error('加载市场数据失败:', error);
    }
}

// 初始化WebSocket
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/trading`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket连接已建立');
        // 订阅市场数据
        ws.send(JSON.stringify({
            type: 'subscribe',
            channels: [`market:${currentSymbol}`, `depth:${currentSymbol}`, `trades:${currentSymbol}`, 'user:orders']
        }));
    };
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (error) {
            console.error('处理WebSocket消息失败:', error);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
    };
    
    ws.onclose = () => {
        console.log('WebSocket连接已关闭，5秒后重连...');
        setTimeout(initWebSocket, 5000);
    };
}

// 处理WebSocket消息
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'ticker':
            updateTicker(data.data);
            break;
        case 'depth':
            updateOrderbook(data.data);
            break;
        case 'trade':
            addRecentTrade(data.data);
            break;
        case 'kline':
            updateKline(data.data);
            break;
        case 'order':
            loadUserOrders();
            loadUserAssets();
            break;
        default:
            console.log('未知的消息类型:', data.type);
    }
}

// 重连WebSocket
function reconnectWebSocket() {
    if (ws) {
        ws.close();
    }
    initWebSocket();
}

// 初始化K线图
function initChart() {
    const chartContainer = document.getElementById('tradingview-chart');
    chart = LightweightCharts.createChart(chartContainer, {
        width: chartContainer.clientWidth,
        height: chartContainer.clientHeight,
        layout: {
            background: { color: '#1E2329' },
            textColor: '#B7BDC6',
        },
        grid: {
            vertLines: { color: '#2B3139' },
            horzLines: { color: '#2B3139' },
        },
        timeScale: {
            timeVisible: true,
            secondsVisible: false,
        },
    });

    candlestickSeries = chart.addCandlestickSeries({
        upColor: '#0ECB81',
        downColor: '#F6465D',
        borderUpColor: '#0ECB81',
        borderDownColor: '#F6465D',
        wickUpColor: '#0ECB81',
        wickDownColor: '#F6465D',
    });

    // 响应式调整
    window.addEventListener('resize', () => {
        chart.applyOptions({
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
        });
    });

    loadKlineData();
}

// 加载K线数据
async function loadKlineData() {
    try {
        const endTime = Date.now();
        const startTime = endTime - getIntervalMillis(currentInterval) * 500; // 最近500根K线
        
        const response = await fetch(`/api/crypto/klines?symbol=${currentSymbol}&interval=${currentInterval}&startTime=${startTime}&endTime=${endTime}&limit=500`);
        const data = await response.json();
        
        if (data.success && data.klines && data.klines.length > 0) {
            const klineData = data.klines.map(k => ({
                time: Math.floor(k.timestamp / 1000),
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
            }));
            candlestickSeries.setData(klineData);
        }
    } catch (error) {
        console.error('加载K线数据失败:', error);
    }
}

// 更新K线
function updateKline(kline) {
    if (kline.interval === currentInterval && kline.symbol === currentSymbol) {
        candlestickSeries.update({
            time: Math.floor(kline.timestamp / 1000),
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
        });
    }
}

// 初始化深度图
function initDepthChart() {
    const chartContainer = document.getElementById('depth-chart');
    depthChart = echarts.init(chartContainer);
    
    const option = {
        backgroundColor: '#1E2329',
        tooltip: {
            trigger: 'axis',
            axisPointer: {
                type: 'line'
            }
        },
        grid: {
            left: '3%',
            right: '4%',
            bottom: '3%',
            containLabel: true
        },
        xAxis: {
            type: 'value',
            axisLine: { lineStyle: { color: '#2B3139' } },
            axisLabel: { color: '#B7BDC6' },
            splitLine: { lineStyle: { color: '#2B3139' } }
        },
        yAxis: {
            type: 'value',
            axisLine: { lineStyle: { color: '#2B3139' } },
            axisLabel: { color: '#B7BDC6' },
            splitLine: { lineStyle: { color: '#2B3139' } }
        },
        series: [
            {
                name: '买单',
                type: 'line',
                smooth: false,
                symbol: 'none',
                lineStyle: { color: '#0ECB81', width: 2 },
                areaStyle: { color: 'rgba(14, 203, 129, 0.3)' },
                data: []
            },
            {
                name: '卖单',
                type: 'line',
                smooth: false,
                symbol: 'none',
                lineStyle: { color: '#F6465D', width: 2 },
                areaStyle: { color: 'rgba(246, 70, 93, 0.3)' },
                data: []
            }
        ]
    };
    
    depthChart.setOption(option);
    
    // 响应式调整
    window.addEventListener('resize', () => {
        depthChart.resize();
    });
}

// 加载订单簿
async function loadOrderbook() {
    try {
        const response = await fetch(`/api/crypto/orderbook?symbol=${currentSymbol}&levels=20`);
        const data = await response.json();
        if (data.success && data.depth) {
            updateOrderbook(data.depth);
        }
    } catch (error) {
        console.error('加载订单簿失败:', error);
    }
}

// 更新订单簿
function updateOrderbook(depth) {
    if (depth.symbol !== currentSymbol) return;
    
    // 更新卖单（倒序显示）
    const asksContainer = document.getElementById('orderbookAsks');
    asksContainer.innerHTML = '';
    const asks = depth.asks.slice(0, 10).reverse();
    let askTotal = 0;
    asks.forEach(ask => {
        askTotal += ask.amount;
        const row = createOrderbookRow(ask.price, ask.amount, askTotal, 'ask');
        asksContainer.appendChild(row);
    });
    
    // 更新买单
    const bidsContainer = document.getElementById('orderbookBids');
    bidsContainer.innerHTML = '';
    const bids = depth.bids.slice(0, 10);
    let bidTotal = 0;
    bids.forEach(bid => {
        bidTotal += bid.amount;
        const row = createOrderbookRow(bid.price, bid.amount, bidTotal, 'bid');
        bidsContainer.appendChild(row);
    });
    
    // 更新深度图
    if (currentChart === 'depth') {
        updateDepthChart(depth.asks, depth.bids);
    }
}

// 创建订单簿行
function createOrderbookRow(price, amount, total, type) {
    const row = document.createElement('div');
    row.className = `orderbook-row ${type}`;
    row.innerHTML = `
        <span>${price.toFixed(2)}</span>
        <span>${amount.toFixed(4)}</span>
        <span>${total.toFixed(4)}</span>
        <div class="orderbook-depth ${type}-depth" style="width: ${Math.min(total / 100, 1) * 100}%"></div>
    `;
    row.onclick = () => {
        document.getElementById('orderPrice').value = price.toFixed(2);
    };
    return row;
}

// 更新深度图
function updateDepthChart(asks, bids) {
    const bidData = [];
    const askData = [];
    let bidTotal = 0;
    let askTotal = 0;
    
    // 买单数据（从高到低）
    for (let i = Math.min(bids.length, 50) - 1; i >= 0; i--) {
        bidTotal += bids[i].amount;
        bidData.push([bids[i].price, bidTotal]);
    }
    
    // 卖单数据（从低到高）
    for (let i = 0; i < Math.min(asks.length, 50); i++) {
        askTotal += asks[i].amount;
        askData.push([asks[i].price, askTotal]);
    }
    
    depthChart.setOption({
        series: [
            { data: bidData },
            { data: askData }
        ]
    });
}

// 加载最近成交
async function loadRecentTrades() {
    try {
        const response = await fetch(`/api/crypto/trades?symbol=${currentSymbol}&limit=50`);
        const data = await response.json();
        if (data.success && data.trades) {
            const container = document.getElementById('tradesList');
            container.innerHTML = '';
            data.trades.forEach(trade => {
                addRecentTrade(trade, false);
            });
        }
    } catch (error) {
        console.error('加载最近成交失败:', error);
    }
}

// 添加最近成交
function addRecentTrade(trade, prepend = true) {
    if (trade.symbol !== currentSymbol) return;
    
    const container = document.getElementById('tradesList');
    const row = document.createElement('div');
    row.className = 'trade-row';
    
    const side = trade.buyer_id ? 'buy' : 'sell';
    const priceClass = side === 'buy' ? 'price-up' : 'price-down';
    const time = new Date(trade.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    
    row.innerHTML = `
        <span class="${priceClass}">${trade.price.toFixed(2)}</span>
        <span>${trade.amount.toFixed(4)}</span>
        <span>${time}</span>
    `;
    
    if (prepend) {
        container.insertBefore(row, container.firstChild);
        // 限制最多显示50条
        while (container.children.length > 50) {
            container.removeChild(container.lastChild);
        }
    } else {
        container.appendChild(row);
    }
}

// 加载用户资产
async function loadUserAssets() {
    try {
        const response = await fetch('/api/crypto/assets');
        const data = await response.json();
        if (data.success && data.assets) {
            userAssets = {};
            data.assets.forEach(asset => {
                userAssets[asset.currency] = asset;
            });
            updateAvailableBalance();
        }
    } catch (error) {
        console.error('加载用户资产失败:', error);
    }
}

// 更新可用余额显示
function updateAvailableBalance() {
    const currency = currentSide === 'buy' ? 'KC' : 'QUOTA';
    const asset = userAssets[currency];
    const balance = asset ? asset.available_balance.toFixed(2) : '0.00';
    document.getElementById('availableBalance').textContent = `${balance} ${currency}`;
}

// 加载用户订单
async function loadUserOrders() {
    try {
        const response = await fetch('/api/crypto/orders?status=pending,partial_filled');
        const data = await response.json();
        if (data.success && data.orders) {
            const container = document.getElementById('userOrdersList');
            container.innerHTML = '';
            
            if (data.orders.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 2rem; color: #848E9C;">暂无委托</div>';
                return;
            }
            
            data.orders.forEach(order => {
                const row = document.createElement('div');
                row.className = 'order-item';
                
                const sideText = order.side === 'buy' ? '买入' : '卖出';
                const sideClass = order.side === 'buy' ? 'price-up' : 'price-down';
                const typeText = order.order_type === 'limit' ? '限价' : '市价';
                const priceText = order.order_type === 'limit' ? order.price.toFixed(2) : '市价';
                
                row.innerHTML = `
                    <span>${order.symbol}</span>
                    <span class="${sideClass}">${sideText} ${typeText}</span>
                    <span>${priceText}</span>
                    <span>${order.unfilled_amount.toFixed(4)}/${order.amount.toFixed(4)}</span>
                    <span><button class="cancel-btn" onclick="cancelOrder('${order.order_id}')">取消</button></span>
                `;
                
                container.appendChild(row);
            });
        }
    } catch (error) {
        console.error('加载用户订单失败:', error);
    }
}

// 切换价格输入框
function togglePriceInput() {
    const priceGroup = document.getElementById('priceGroup');
    if (currentOrderType === 'market') {
        priceGroup.style.display = 'none';
    } else {
        priceGroup.style.display = 'flex';
    }
}

// 切换图表
function toggleChart() {
    if (currentChart === 'kline') {
        document.getElementById('tradingview-chart').style.display = 'block';
        document.getElementById('depth-chart').style.display = 'none';
    } else {
        document.getElementById('tradingview-chart').style.display = 'none';
        document.getElementById('depth-chart').style.display = 'block';
        loadOrderbook(); // 重新加载深度数据
    }
}

// 更新订单按钮
function updateOrderButton() {
    const btn = document.getElementById('submitOrder');
    if (currentSide === 'buy') {
        btn.className = 'buy-btn';
        btn.textContent = '买入 QUOTA';
    } else {
        btn.className = 'sell-btn';
        btn.textContent = '卖出 QUOTA';
    }
    updateAvailableBalance();
}

// 提交订单
async function submitOrder() {
    const price = parseFloat(document.getElementById('orderPrice').value);
    const amount = parseFloat(document.getElementById('orderAmount').value);
    
    if (!amount || amount <= 0) {
        alert('请输入有效的数量');
        return;
    }
    
    if (currentOrderType === 'limit' && (!price || price <= 0)) {
        alert('请输入有效的价格');
        return;
    }
    
    const orderData = {
        symbol: currentSymbol,
        side: currentSide,
        order_type: currentOrderType,
        amount: amount,
        leverage: 1,
    };
    
    if (currentOrderType === 'limit') {
        orderData.price = price;
    }
    
    try {
        const btn = document.getElementById('submitOrder');
        btn.disabled = true;
        btn.textContent = '提交中...';
        
        const response = await fetch('/api/crypto/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData),
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('订单提交成功！');
            document.getElementById('orderPrice').value = '';
            document.getElementById('orderAmount').value = '';
            loadUserOrders();
            loadUserAssets();
        } else {
            alert('订单提交失败: ' + data.error);
        }
    } catch (error) {
        console.error('提交订单失败:', error);
        alert('订单提交失败，请稍后重试');
    } finally {
        const btn = document.getElementById('submitOrder');
        btn.disabled = false;
        updateOrderButton();
    }
}

// 取消订单
async function cancelOrder(orderId) {
    if (!confirm('确认取消该订单？')) {
        return;
    }
    
    try {
        const response = await fetch('/api/crypto/order/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: orderId }),
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('订单已取消');
            loadUserOrders();
            loadUserAssets();
        } else {
            alert('取消订单失败: ' + data.error);
        }
    } catch (error) {
        console.error('取消订单失败:', error);
        alert('取消订单失败，请稍后重试');
    }
}

// 更新行情
function updateTicker(ticker) {
    if (ticker.symbol !== currentSymbol) return;
    
    document.getElementById('currentPrice').textContent = ticker.last_price.toFixed(2);
    document.getElementById('priceChange').textContent = `${ticker.change_24h > 0 ? '+' : ''}${(ticker.change_24h * 100).toFixed(2)}%`;
    document.getElementById('high24h').textContent = ticker.high_24h.toFixed(2);
    document.getElementById('low24h').textContent = ticker.low_24h.toFixed(2);
    document.getElementById('volume24h').textContent = ticker.volume_24h.toFixed(2);
}

// 获取周期毫秒数
function getIntervalMillis(interval) {
    const map = {
        '1m': 60 * 1000,
        '5m': 5 * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
    };
    return map[interval] || 24 * 60 * 60 * 1000;
}

