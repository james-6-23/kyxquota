import { Hono } from 'hono';
import { tradingEngine } from '../services/crypto/trading-engine';
import { orderBookManager } from '../services/crypto/orderbook';
import { klineManager, KLINE_INTERVALS, type KlineInterval } from '../services/crypto/kline-generator';
import { riskControl } from '../services/crypto/risk-control';
import { db } from '../database';
import { getCryptoConfig, getUserAsset, getUserAllAssets } from '../database-crypto';
import type { TradeOrder, TradeFill, CreateOrderParams } from '../types-crypto';
import { logger } from '../utils/logger';

const crypto = new Hono();

// ========== 订单相关API ==========

/**
 * 创建订单
 * POST /api/crypto/order
 */
crypto.post('/order', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const body = await c.req.json();
        const params: CreateOrderParams = {
            symbol: body.symbol,
            order_type: body.order_type,
            side: body.side,
            price: body.price,
            amount: body.amount,
            leverage: body.leverage || 1,
            margin_mode: body.margin_mode,
        };

        const result = await tradingEngine.createOrder(
            session.linux_do_id,
            session.username || session.linux_do_id,
            params
        );

        return c.json(result);
    } catch (error) {
        logger.error('CryptoAPI', '创建订单失败', error);
        return c.json({ success: false, error: '创建订单失败' }, 500);
    }
});

/**
 * 取消订单
 * POST /api/crypto/order/cancel
 */
crypto.post('/order/cancel', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const body = await c.req.json();
        const { order_id } = body;

        if (!order_id) {
            return c.json({ success: false, error: '缺少订单ID' }, 400);
        }

        const result = await tradingEngine.cancelOrder(order_id, session.linux_do_id);
        return c.json(result);
    } catch (error) {
        logger.error('CryptoAPI', '取消订单失败', error);
        return c.json({ success: false, error: '取消订单失败' }, 500);
    }
});

/**
 * 获取用户当前订单列表
 * GET /api/crypto/orders
 */
crypto.get('/orders', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const status = c.req.query('status') || 'pending,partial_filled';
        const symbol = c.req.query('symbol');
        const limit = parseInt(c.req.query('limit') || '50');

        let sql = 'SELECT * FROM trade_orders WHERE linux_do_id = ?';
        const params: any[] = [session.linux_do_id];

        if (symbol) {
            sql += ' AND symbol = ?';
            params.push(symbol);
        }

        sql += ' AND status IN (' + status.split(',').map(() => '?').join(',') + ')';
        params.push(...status.split(','));

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const orders = db.query(sql).all(...params) as TradeOrder[];

        return c.json({ success: true, orders });
    } catch (error) {
        logger.error('CryptoAPI', '获取订单列表失败', error);
        return c.json({ success: false, error: '获取订单列表失败' }, 500);
    }
});

/**
 * 获取用户历史订单
 * GET /api/crypto/order/history
 */
crypto.get('/order/history', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const symbol = c.req.query('symbol');
        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        let sql = 'SELECT * FROM trade_orders WHERE linux_do_id = ?';
        const params: any[] = [session.linux_do_id];

        if (symbol) {
            sql += ' AND symbol = ?';
            params.push(symbol);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(pageSize, offset);

        const orders = db.query(sql).all(...params) as TradeOrder[];

        // 获取总数
        let countSql = 'SELECT COUNT(*) as count FROM trade_orders WHERE linux_do_id = ?';
        const countParams: any[] = [session.linux_do_id];
        if (symbol) {
            countSql += ' AND symbol = ?';
            countParams.push(symbol);
        }
        const { count } = db.query(countSql).get(...countParams) as { count: number };

        return c.json({
            success: true,
            orders,
            pagination: {
                page,
                pageSize,
                total: count,
                totalPages: Math.ceil(count / pageSize),
            },
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取历史订单失败', error);
        return c.json({ success: false, error: '获取历史订单失败' }, 500);
    }
});

/**
 * 获取成交记录
 * GET /api/crypto/fills
 */
crypto.get('/fills', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const symbol = c.req.query('symbol');
        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        let sql = 'SELECT * FROM trade_fills WHERE (buyer_id = ? OR seller_id = ?)';
        const params: any[] = [session.linux_do_id, session.linux_do_id];

        if (symbol) {
            sql += ' AND symbol = ?';
            params.push(symbol);
        }

        sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(pageSize, offset);

        const fills = db.query(sql).all(...params) as TradeFill[];

        // 获取总数
        let countSql = 'SELECT COUNT(*) as count FROM trade_fills WHERE (buyer_id = ? OR seller_id = ?)';
        const countParams: any[] = [session.linux_do_id, session.linux_do_id];
        if (symbol) {
            countSql += ' AND symbol = ?';
            countParams.push(symbol);
        }
        const { count } = db.query(countSql).get(...countParams) as { count: number };

        return c.json({
            success: true,
            fills,
            pagination: {
                page,
                pageSize,
                total: count,
                totalPages: Math.ceil(count / pageSize),
            },
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取成交记录失败', error);
        return c.json({ success: false, error: '获取成交记录失败' }, 500);
    }
});

// ========== 市场数据API ==========

/**
 * 获取订单簿
 * GET /api/crypto/orderbook
 */
crypto.get('/orderbook', async (c) => {
    try {
        const symbol = c.req.query('symbol') || 'KC/QUOTA';
        const levels = parseInt(c.req.query('levels') || '20');

        const orderBook = orderBookManager.getOrderBook(symbol);
        const snapshot = orderBook.getSnapshot(levels);

        return c.json({ success: true, depth: snapshot });
    } catch (error) {
        logger.error('CryptoAPI', '获取订单簿失败', error);
        return c.json({ success: false, error: '获取订单簿失败' }, 500);
    }
});

/**
 * 获取最新成交
 * GET /api/crypto/trades
 */
crypto.get('/trades', async (c) => {
    try {
        const symbol = c.req.query('symbol') || 'KC/QUOTA';
        const limit = parseInt(c.req.query('limit') || '50');

        const fills = db.query(`
            SELECT * FROM trade_fills
            WHERE symbol = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(symbol, limit) as TradeFill[];

        return c.json({ success: true, trades: fills });
    } catch (error) {
        logger.error('CryptoAPI', '获取最新成交失败', error);
        return c.json({ success: false, error: '获取最新成交失败' }, 500);
    }
});

/**
 * 获取24小时行情
 * GET /api/crypto/ticker
 */
crypto.get('/ticker', async (c) => {
    try {
        const symbol = c.req.query('symbol') || 'KC/QUOTA';
        const now = Date.now();
        const yesterday = now - 24 * 60 * 60 * 1000;

        // 获取24小时内的成交记录
        const fills = db.query(`
            SELECT price, amount, total_value, timestamp
            FROM trade_fills
            WHERE symbol = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        `).all(symbol, yesterday) as TradeFill[];

        if (fills.length === 0) {
            return c.json({
                success: true,
                ticker: {
                    symbol,
                    last_price: 10000,
                    price_change_24h: 0,
                    change_24h: 0, // 添加前端期望的字段
                    high_24h: 10000,
                    low_24h: 10000,
                    volume_24h: 0,
                    quote_volume_24h: 0,
                    trades_count_24h: 0,
                    timestamp: now,
                },
            });
        }

        const firstPrice = fills[0].price;
        const lastPrice = fills[fills.length - 1].price;
        const priceChange = lastPrice - firstPrice;
        const priceChangePercent = (priceChange / firstPrice) * 100;
        
        const high24h = Math.max(...fills.map(f => f.price));
        const low24h = Math.min(...fills.map(f => f.price));
        const volume24h = fills.reduce((sum, f) => sum + f.amount, 0);
        const quoteVolume24h = fills.reduce((sum, f) => sum + f.total_value, 0);

        return c.json({
            success: true,
            ticker: {
                symbol,
                last_price: lastPrice,
                price_change_24h: priceChange,
                change_24h: priceChangePercent / 100, // 添加前端期望的字段（小数形式）
                high_24h: high24h,
                low_24h: low24h,
                volume_24h: volume24h,
                quote_volume_24h: quoteVolume24h,
                trades_count_24h: fills.length,
                timestamp: now,
            },
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取行情失败', error);
        return c.json({ success: false, error: '获取行情失败' }, 500);
    }
});

// ========== 资产管理API ==========

/**
 * 获取用户资产
 * GET /api/crypto/assets
 */
crypto.get('/assets', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const assets = getUserAllAssets(session.linux_do_id);

        return c.json({ success: true, assets });
    } catch (error) {
        logger.error('CryptoAPI', '获取资产失败', error);
        return c.json({ success: false, error: '获取资产失败' }, 500);
    }
});

/**
 * 获取用户信息
 * GET /api/user/info
 */
crypto.get('/user/info', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.linux_do_id) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        return c.json({
            success: true,
            user: {
                username: session.username,
                linuxDoId: session.linux_do_id,
                avatar: session.avatar_url,
                admin: session.admin || false,
            },
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取用户信息失败', error);
        return c.json({ success: false, error: '获取用户信息失败' }, 500);
    }
});

/**
 * 获取系统配置
 * GET /api/crypto/config
 */
crypto.get('/config', async (c) => {
    try {
        const config = getCryptoConfig();
        return c.json({ success: true, config });
    } catch (error) {
        logger.error('CryptoAPI', '获取配置失败', error);
        return c.json({ success: false, error: '获取配置失败' }, 500);
    }
});

/**
 * 获取交易对列表
 * GET /api/crypto/pairs
 */
crypto.get('/pairs', async (c) => {
    try {
        const pairs = db.query('SELECT * FROM trading_pairs WHERE enabled = 1').all();
        return c.json({ success: true, pairs });
    } catch (error) {
        logger.error('CryptoAPI', '获取交易对失败', error);
        return c.json({ success: false, error: '获取交易对失败' }, 500);
    }
});

// ========== K线数据API ==========

/**
 * 获取K线数据
 * GET /api/crypto/klines
 */
crypto.get('/klines', async (c) => {
    try {
        const symbol = c.req.query('symbol') || 'KC/QUOTA';
        const interval = c.req.query('interval') as KlineInterval || '1h';
        const startTime = c.req.query('startTime') ? parseInt(c.req.query('startTime')!) : undefined;
        const endTime = c.req.query('endTime') ? parseInt(c.req.query('endTime')!) : undefined;
        const limit = parseInt(c.req.query('limit') || '500');

        // 验证周期
        if (!KLINE_INTERVALS.includes(interval)) {
            return c.json({
                success: false,
                error: `无效的周期，支持: ${KLINE_INTERVALS.join(', ')}`
            }, 400);
        }

        // 获取K线数据
        const klines = await klineManager.getKlines(symbol, interval, startTime, endTime, limit);

        return c.json({
            success: true,
            symbol,
            interval,
            klines,
            count: klines.length,
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取K线数据失败', error);
        return c.json({ success: false, error: '获取K线数据失败' }, 500);
    }
});

/**
 * 获取最新K线
 * GET /api/crypto/kline/latest
 */
crypto.get('/kline/latest', async (c) => {
    try {
        const symbol = c.req.query('symbol') || 'KC/QUOTA';
        const interval = c.req.query('interval') as KlineInterval || '1h';

        if (!KLINE_INTERVALS.includes(interval)) {
            return c.json({
                success: false,
                error: `无效的周期，支持: ${KLINE_INTERVALS.join(', ')}`
            }, 400);
        }

        const generator = klineManager.getGenerator(symbol);
        const kline = await generator.getLatestKline(interval);

        if (!kline) {
            return c.json({
                success: false,
                error: '暂无K线数据'
            }, 404);
        }

        return c.json({
            success: true,
            kline,
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取最新K线失败', error);
        return c.json({ success: false, error: '获取最新K线失败' }, 500);
    }
});

/**
 * 初始化K线数据（管理员）
 * POST /api/crypto/admin/klines/initialize
 */
crypto.post('/admin/klines/initialize', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const body = await c.req.json();
        const { symbol, interval, startTime, endTime } = body;

        if (!symbol || !interval) {
            return c.json({ success: false, error: '缺少必要参数' }, 400);
        }

        if (!KLINE_INTERVALS.includes(interval)) {
            return c.json({
                success: false,
                error: `无效的周期，支持: ${KLINE_INTERVALS.join(', ')}`
            }, 400);
        }

        const generator = klineManager.getGenerator(symbol);
        const count = await generator.generateKlinesFromTrades(
            interval,
            startTime || 0,
            endTime || Date.now()
        );

        return c.json({
            success: true,
            message: `成功生成${count}条K线数据`,
            count,
        });
    } catch (error) {
        logger.error('CryptoAPI', '初始化K线数据失败', error);
        return c.json({ success: false, error: '初始化K线数据失败' }, 500);
    }
});

/**
 * 清理过期K线数据（管理员）
 * POST /api/crypto/admin/klines/clean
 */
crypto.post('/admin/klines/clean', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const body = await c.req.json();
        const { daysToKeep = 90 } = body;

        // 获取所有交易对
        const pairs = db.query('SELECT symbol FROM trading_pairs WHERE enabled = 1').all() as { symbol: string }[];
        const symbols = pairs.map(p => p.symbol);

        await klineManager.cleanOldKlinesForAll(symbols, daysToKeep);

        return c.json({
            success: true,
            message: `成功清理${daysToKeep}天前的K线数据`,
        });
    } catch (error) {
        logger.error('CryptoAPI', '清理K线数据失败', error);
        return c.json({ success: false, error: '清理K线数据失败' }, 500);
    }
});

/**
 * 获取用户交易统计
 * GET /api/crypto/user/stats
 */
crypto.get('/user/stats', async (c) => {
    try {
        const session = c.get('session');
        if (!session) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const stats = await riskControl.getUserTradingStats(session.linuxDoId);

        return c.json({
            success: true,
            stats,
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取用户统计失败', error);
        return c.json({ success: false, error: '获取用户统计失败' }, 500);
    }
});

/**
 * 获取用户风险等级
 * GET /api/crypto/user/risk-level
 */
crypto.get('/user/risk-level', async (c) => {
    try {
        const session = c.get('session');
        if (!session) {
            return c.json({ success: false, error: '未登录' }, 401);
        }

        const riskLevel = await riskControl.getUserRiskLevel(session.linuxDoId);

        return c.json({
            success: true,
            riskLevel,
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取用户风险等级失败', error);
        return c.json({ success: false, error: '获取用户风险等级失败' }, 500);
    }
});

/**
 * 获取用户今日交易限额（管理员）
 * GET /api/crypto/admin/user-limits/:linuxDoId
 */
crypto.get('/admin/user-limits/:linuxDoId', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const linuxDoId = c.req.param('linuxDoId');
        const today = new Date().toISOString().split('T')[0];

        const limits = db.query(`
            SELECT * FROM user_daily_crypto_limits
            WHERE linux_do_id = ? AND limit_date = ?
        `).get(linuxDoId, today);

        return c.json({
            success: true,
            limits,
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取用户限额失败', error);
        return c.json({ success: false, error: '获取用户限额失败' }, 500);
    }
});

/**
 * 获取所有用户风控统计（管理员）
 * GET /api/crypto/admin/risk-stats
 */
crypto.get('/admin/risk-stats', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        // 获取所有活跃用户
        const activeUsers = db.query(`
            SELECT DISTINCT linux_do_id
            FROM trade_orders
            WHERE created_at >= ?
            ORDER BY created_at DESC
            LIMIT 100
        `).all(Date.now() - 7 * 24 * 60 * 60 * 1000) as { linux_do_id: string }[];

        // 为每个用户获取风险统计
        const statsPromises = activeUsers.map(async (user) => {
            const stats = await riskControl.getUserTradingStats(user.linux_do_id);
            return {
                linuxDoId: user.linux_do_id,
                ...stats,
            };
        });

        const stats = await Promise.all(statsPromises);

        // 按风险等级分组
        const riskGroups = {
            critical: stats.filter(s => s.risk_level === 'critical'),
            high: stats.filter(s => s.risk_level === 'high'),
            medium: stats.filter(s => s.risk_level === 'medium'),
            low: stats.filter(s => s.risk_level === 'low'),
        };

        return c.json({
            success: true,
            totalUsers: stats.length,
            riskGroups,
            stats: stats.sort((a, b) => {
                const order = { critical: 4, high: 3, medium: 2, low: 1 };
                return (order[b.risk_level as keyof typeof order] || 0) - (order[a.risk_level as keyof typeof order] || 0);
            }),
        });
    } catch (error) {
        logger.error('CryptoAPI', '获取风控统计失败', error);
        return c.json({ success: false, error: '获取风控统计失败' }, 500);
    }
});

/**
 * 获取订单统计（管理员）
 * GET /api/crypto/admin/stats/orders
 */
crypto.get('/admin/stats/orders', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const result = db.query('SELECT COUNT(*) as total FROM trade_orders').get() as { total: number };
        return c.json({ success: true, total: result.total });
    } catch (error) {
        logger.error('CryptoAPI', '获取订单统计失败', error);
        return c.json({ success: false, error: '获取订单统计失败' }, 500);
    }
});

/**
 * 获取活跃用户统计（管理员）
 * GET /api/crypto/admin/stats/active-users
 */
crypto.get('/admin/stats/active-users', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const result = db.query(`
            SELECT COUNT(DISTINCT linux_do_id) as count
            FROM trade_orders
            WHERE created_at >= ?
        `).get(Date.now() - 24 * 60 * 60 * 1000) as { count: number };

        return c.json({ success: true, count: result.count });
    } catch (error) {
        logger.error('CryptoAPI', '获取活跃用户统计失败', error);
        return c.json({ success: false, error: '获取活跃用户统计失败' }, 500);
    }
});

/**
 * 获取所有订单（管理员）
 * GET /api/crypto/admin/orders
 */
crypto.get('/admin/orders', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const { status, limit = 100 } = c.req.query();
        
        let query = 'SELECT * FROM trade_orders';
        let params: any[] = [];
        
        if (status) {
            const statuses = status.split(',');
            query += ` WHERE status IN (${statuses.map(() => '?').join(',')})`;
            params = statuses;
        }
        
        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const orders = db.query(query).all(...params);

        return c.json({ success: true, orders });
    } catch (error) {
        logger.error('CryptoAPI', '获取订单列表失败', error);
        return c.json({ success: false, error: '获取订单列表失败' }, 500);
    }
});

/**
 * 切换交易对状态（管理员）
 * POST /api/crypto/admin/pair/toggle
 */
crypto.post('/admin/pair/toggle', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const body = await c.req.json();
        const { symbol } = body;

        if (!symbol) {
            return c.json({ success: false, error: '缺少交易对符号' }, 400);
        }

        db.run('UPDATE trading_pairs SET enabled = NOT enabled WHERE symbol = ?', [symbol]);

        return c.json({ success: true, message: '操作成功' });
    } catch (error) {
        logger.error('CryptoAPI', '切换交易对状态失败', error);
        return c.json({ success: false, error: '操作失败' }, 500);
    }
});

/**
 * 更新系统配置（管理员）
 * POST /api/crypto/admin/config
 */
crypto.post('/admin/config', async (c) => {
    try {
        const session = c.get('session');
        if (!session?.admin) {
            return c.json({ success: false, error: '需要管理员权限' }, 403);
        }

        const body = await c.req.json();
        const {
            maker_fee_rate,
            taker_fee_rate,
            max_daily_trades,
            max_orders_per_user,
            price_fluctuation_limit,
            max_position_value_ratio,
        } = body;

        db.run(`
            UPDATE crypto_config SET
                maker_fee_rate = ?,
                taker_fee_rate = ?,
                max_daily_trades = ?,
                max_orders_per_user = ?,
                price_fluctuation_limit = ?,
                max_position_value_ratio = ?,
                updated_at = ?
            WHERE id = 1
        `, [
            maker_fee_rate,
            taker_fee_rate,
            max_daily_trades,
            max_orders_per_user,
            price_fluctuation_limit,
            max_position_value_ratio,
            Date.now(),
        ]);

        return c.json({ success: true, message: '配置更新成功' });
    } catch (error) {
        logger.error('CryptoAPI', '更新配置失败', error);
        return c.json({ success: false, error: '更新配置失败' }, 500);
    }
});

export default crypto;

