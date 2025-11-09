import type { TradeOrder, OrderbookSnapshot } from '../../types-crypto';
import { redisCache, CacheKeys, CacheExpiry } from '../redis-cache';

/**
 * 优先队列节点
 */
interface PriorityQueueNode {
    order: TradeOrder;
    priority: number;
}

/**
 * 优先队列（用于订单簿）
 */
class PriorityQueue {
    private heap: PriorityQueueNode[] = [];
    private compareFn: (a: number, b: number) => boolean;

    constructor(isMaxHeap: boolean = false) {
        // 最大堆（买单）：价格从高到低
        // 最小堆（卖单）：价格从低到高
        this.compareFn = isMaxHeap
            ? (a, b) => a > b
            : (a, b) => a < b;
    }

    /**
     * 获取父节点索引
     */
    private parent(i: number): number {
        return Math.floor((i - 1) / 2);
    }

    /**
     * 获取左子节点索引
     */
    private leftChild(i: number): number {
        return 2 * i + 1;
    }

    /**
     * 获取右子节点索引
     */
    private rightChild(i: number): number {
        return 2 * i + 2;
    }

    /**
     * 交换两个节点
     */
    private swap(i: number, j: number): void {
        [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    }

    /**
     * 上浮操作
     */
    private heapifyUp(i: number): void {
        while (i > 0) {
            const p = this.parent(i);
            if (!this.compareFn(this.heap[i].priority, this.heap[p].priority)) {
                break;
            }
            this.swap(i, p);
            i = p;
        }
    }

    /**
     * 下沉操作
     */
    private heapifyDown(i: number): void {
        while (true) {
            let target = i;
            const left = this.leftChild(i);
            const right = this.rightChild(i);

            if (left < this.heap.length && 
                this.compareFn(this.heap[left].priority, this.heap[target].priority)) {
                target = left;
            }

            if (right < this.heap.length && 
                this.compareFn(this.heap[right].priority, this.heap[target].priority)) {
                target = right;
            }

            if (target === i) break;

            this.swap(i, target);
            i = target;
        }
    }

    /**
     * 插入订单
     */
    push(order: TradeOrder): void {
        // 优先级：价格优先，时间其次
        // 时间戳越小越早，我们用负数表示时间优先级
        const priority = order.price;
        
        this.heap.push({ order, priority });
        this.heapifyUp(this.heap.length - 1);
    }

    /**
     * 弹出最优订单
     */
    pop(): TradeOrder | null {
        if (this.heap.length === 0) return null;
        if (this.heap.length === 1) return this.heap.pop()!.order;

        const root = this.heap[0].order;
        this.heap[0] = this.heap.pop()!;
        this.heapifyDown(0);

        return root;
    }

    /**
     * 查看最优订单（不移除）
     */
    peek(): TradeOrder | null {
        return this.heap.length > 0 ? this.heap[0].order : null;
    }

    /**
     * 移除指定订单
     */
    remove(orderId: string): boolean {
        const index = this.heap.findIndex(node => node.order.order_id === orderId);
        if (index === -1) return false;

        if (index === this.heap.length - 1) {
            this.heap.pop();
            return true;
        }

        this.heap[index] = this.heap.pop()!;
        
        // 尝试上浮和下沉
        const parent = this.parent(index);
        if (index > 0 && this.compareFn(this.heap[index].priority, this.heap[parent].priority)) {
            this.heapifyUp(index);
        } else {
            this.heapifyDown(index);
        }

        return true;
    }

    /**
     * 获取队列大小
     */
    size(): number {
        return this.heap.length;
    }

    /**
     * 判断是否为空
     */
    isEmpty(): boolean {
        return this.heap.length === 0;
    }

    /**
     * 清空队列
     */
    clear(): void {
        this.heap = [];
    }

    /**
     * 转换为数组（按优先级排序）
     */
    toArray(): TradeOrder[] {
        return [...this.heap]
            .sort((a, b) => {
                if (this.compareFn(a.priority, b.priority)) return -1;
                if (this.compareFn(b.priority, a.priority)) return 1;
                // 价格相同，按时间排序
                return a.order.created_at - b.order.created_at;
            })
            .map(node => node.order);
    }
}

/**
 * 订单簿
 */
export class OrderBook {
    private symbol: string;
    private bids: PriorityQueue;  // 买单队列（价格从高到低）
    private asks: PriorityQueue;  // 卖单队列（价格从低到高）
    private orderMap: Map<string, TradeOrder>;  // 订单快速查找

    constructor(symbol: string) {
        this.symbol = symbol;
        this.bids = new PriorityQueue(true);   // 最大堆
        this.asks = new PriorityQueue(false);  // 最小堆
        this.orderMap = new Map();
    }

    /**
     * 添加订单
     */
    addOrder(order: TradeOrder): void {
        // 只添加未成交的订单
        if (order.status !== 'pending' && order.status !== 'partial_filled') {
            return;
        }

        // 只添加有效数量的订单
        if (order.unfilled_amount <= 0) {
            return;
        }

        this.orderMap.set(order.order_id, order);

        if (order.side === 'buy') {
            this.bids.push(order);
        } else {
            this.asks.push(order);
        }
    }

    /**
     * 移除订单
     */
    removeOrder(orderId: string): boolean {
        const order = this.orderMap.get(orderId);
        if (!order) return false;

        this.orderMap.delete(orderId);

        if (order.side === 'buy') {
            return this.bids.remove(orderId);
        } else {
            return this.asks.remove(orderId);
        }
    }

    /**
     * 更新订单（用于部分成交）
     */
    updateOrder(orderId: string, filledAmount: number): void {
        const order = this.orderMap.get(orderId);
        if (!order) return;

        order.filled_amount += filledAmount;
        order.unfilled_amount -= filledAmount;

        if (order.unfilled_amount <= 0) {
            this.removeOrder(orderId);
        }
    }

    /**
     * 获取最优买单
     */
    getBestBid(): TradeOrder | null {
        return this.bids.peek();
    }

    /**
     * 获取最优卖单
     */
    getBestAsk(): TradeOrder | null {
        return this.asks.peek();
    }

    /**
     * 弹出最优买单
     */
    popBestBid(): TradeOrder | null {
        const order = this.bids.pop();
        if (order) {
            this.orderMap.delete(order.order_id);
        }
        return order;
    }

    /**
     * 弹出最优卖单
     */
    popBestAsk(): TradeOrder | null {
        const order = this.asks.pop();
        if (order) {
            this.orderMap.delete(order.order_id);
        }
        return order;
    }

    /**
     * 获取买单列表（按价格降序）
     */
    getBids(limit: number = 20): TradeOrder[] {
        return this.bids.toArray().slice(0, limit);
    }

    /**
     * 获取卖单列表（按价格升序）
     */
    getAsks(limit: number = 20): TradeOrder[] {
        return this.asks.toArray().slice(0, limit);
    }

    /**
     * 获取订单簿深度（聚合后的价格-数量对）
     */
    getDepth(levels: number = 20): { bids: [number, number][], asks: [number, number][] } {
        const bidOrders = this.getBids(levels * 2);  // 多取一些，以便聚合
        const askOrders = this.getAsks(levels * 2);

        // 聚合买单
        const bidsMap = new Map<number, number>();
        for (const order of bidOrders) {
            const amount = bidsMap.get(order.price) || 0;
            bidsMap.set(order.price, amount + order.unfilled_amount);
        }

        // 聚合卖单
        const asksMap = new Map<number, number>();
        for (const order of askOrders) {
            const amount = asksMap.get(order.price) || 0;
            asksMap.set(order.price, amount + order.unfilled_amount);
        }

        // 转换为数组并排序
        const bids = Array.from(bidsMap.entries())
            .sort((a, b) => b[0] - a[0])  // 价格降序
            .slice(0, levels);

        const asks = Array.from(asksMap.entries())
            .sort((a, b) => a[0] - b[0])  // 价格升序
            .slice(0, levels);

        return { bids, asks };
    }

    /**
     * 获取订单簿快照
     */
    getSnapshot(levels: number = 20): OrderbookSnapshot {
        const depth = this.getDepth(levels);
        return {
            symbol: this.symbol,
            bids: depth.bids,
            asks: depth.asks,
            timestamp: Date.now(),
        };
    }

    /**
     * 获取订单数量统计
     */
    getStats(): { bidCount: number; askCount: number; totalCount: number } {
        return {
            bidCount: this.bids.size(),
            askCount: this.asks.size(),
            totalCount: this.bids.size() + this.asks.size(),
        };
    }

    /**
     * 清空订单簿
     */
    clear(): void {
        this.bids.clear();
        this.asks.clear();
        this.orderMap.clear();
    }

    /**
     * 获取中间价（买一卖一的平均价）
     */
    getMidPrice(): number | null {
        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();

        if (!bestBid || !bestAsk) return null;

        return (bestBid.price + bestAsk.price) / 2;
    }

    /**
     * 获取价差
     */
    getSpread(): number | null {
        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();

        if (!bestBid || !bestAsk) return null;

        return bestAsk.price - bestBid.price;
    }

    /**
     * 保存到Redis缓存
     */
    async saveToCache(): Promise<void> {
        try {
            const snapshot = this.getSnapshot(50);  // 保存50档深度
            const cacheKey = CacheKeys.ORDERBOOK(this.symbol);
            await redisCache.set(cacheKey, snapshot, CacheExpiry.ORDERBOOK);
        } catch (error) {
            console.error(`订单簿缓存保存失败 [${this.symbol}]:`, error);
        }
    }

    /**
     * 从Redis缓存加载
     */
    static async loadFromCache(symbol: string): Promise<OrderbookSnapshot | null> {
        try {
            const cacheKey = CacheKeys.ORDERBOOK(symbol);
            return await redisCache.get<OrderbookSnapshot>(cacheKey);
        } catch (error) {
            console.error(`订单簿缓存加载失败 [${symbol}]:`, error);
            return null;
        }
    }
}

/**
 * 订单簿管理器（管理多个交易对的订单簿）
 */
export class OrderBookManager {
    private orderBooks: Map<string, OrderBook>;

    constructor() {
        this.orderBooks = new Map();
    }

    /**
     * 获取或创建订单簿
     */
    getOrderBook(symbol: string): OrderBook {
        if (!this.orderBooks.has(symbol)) {
            this.orderBooks.set(symbol, new OrderBook(symbol));
        }
        return this.orderBooks.get(symbol)!;
    }

    /**
     * 添加订单到订单簿
     */
    addOrder(order: TradeOrder): void {
        const orderBook = this.getOrderBook(order.symbol);
        orderBook.addOrder(order);
    }

    /**
     * 从订单簿移除订单
     */
    removeOrder(symbol: string, orderId: string): boolean {
        const orderBook = this.orderBooks.get(symbol);
        if (!orderBook) return false;
        return orderBook.removeOrder(orderId);
    }

    /**
     * 更新订单
     */
    updateOrder(symbol: string, orderId: string, filledAmount: number): void {
        const orderBook = this.orderBooks.get(symbol);
        if (orderBook) {
            orderBook.updateOrder(orderId, filledAmount);
        }
    }

    /**
     * 获取所有交易对
     */
    getAllSymbols(): string[] {
        return Array.from(this.orderBooks.keys());
    }

    /**
     * 清空指定交易对的订单簿
     */
    clearOrderBook(symbol: string): void {
        const orderBook = this.orderBooks.get(symbol);
        if (orderBook) {
            orderBook.clear();
        }
    }

    /**
     * 清空所有订单簿
     */
    clearAll(): void {
        for (const orderBook of this.orderBooks.values()) {
            orderBook.clear();
        }
        this.orderBooks.clear();
    }
}

// 导出全局订单簿管理器单例
export const orderBookManager = new OrderBookManager();

