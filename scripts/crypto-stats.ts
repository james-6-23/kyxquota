/**
 * 查看虚拟币交易系统统计数据
 */

import { db } from '../src/database';

async function showCryptoStats() {
    console.log('📊 虚拟币交易系统统计\n');
    console.log('='.repeat(60));

    try {
        // 1. 交易对统计
        console.log('\n💱 交易对信息:');
        const pairs = db.query(`
            SELECT symbol, base_currency, quote_currency, enabled 
            FROM trading_pairs
        `).all() as any[];

        pairs.forEach(pair => {
            console.log(`  ${pair.symbol}: ${pair.enabled ? '✅ 启用' : '❌ 禁用'}`);
        });

        // 2. 订单统计
        console.log('\n📋 订单统计:');
        const orderStats = db.query(`
            SELECT 
                status,
                COUNT(*) as count,
                SUM(amount * COALESCE(price, 0)) as total_value
            FROM trade_orders
            GROUP BY status
        `).all() as any[];

        const totalOrders = orderStats.reduce((sum, s) => sum + s.count, 0);
        console.log(`  总订单数: ${totalOrders}`);
        orderStats.forEach(stat => {
            const statusMap: any = {
                'pending': '⏳ 待成交',
                'partial_filled': '🔄 部分成交',
                'filled': '✅ 已成交',
                'cancelled': '❌ 已取消'
            };
            console.log(`  ${statusMap[stat.status] || stat.status}: ${stat.count} 个`);
        });

        // 3. 成交统计
        console.log('\n💰 成交统计:');
        const fillStats = db.query(`
            SELECT 
                COUNT(*) as count,
                SUM(total_value) as total_value,
                SUM(buyer_fee + seller_fee) as total_fees,
                AVG(price) as avg_price
            FROM trade_fills
        `).get() as any;

        console.log(`  总成交数: ${fillStats.count || 0}`);
        console.log(`  总成交额: ${(fillStats.total_value || 0).toFixed(2)} KC`);
        console.log(`  总手续费: ${(fillStats.total_fees || 0).toFixed(2)} KC`);
        console.log(`  平均成交价: ${(fillStats.avg_price || 0).toFixed(2)} KC`);

        // 4. K线统计
        console.log('\n📈 K线统计:');
        const klineStats = db.query(`
            SELECT 
                interval,
                COUNT(*) as count,
                MIN(timestamp) as first_time,
                MAX(timestamp) as last_time
            FROM klines
            GROUP BY interval
        `).all() as any[];

        if (klineStats.length > 0) {
            klineStats.forEach(stat => {
                const firstDate = new Date(stat.first_time).toLocaleDateString('zh-CN');
                const lastDate = new Date(stat.last_time).toLocaleDateString('zh-CN');
                console.log(`  ${stat.interval}: ${stat.count} 根 (${firstDate} ~ ${lastDate})`);
            });
        } else {
            console.log('  暂无K线数据');
        }

        // 5. 用户资产统计
        console.log('\n👥 用户资产统计:');
        const assetStats = db.query(`
            SELECT 
                currency,
                COUNT(DISTINCT linux_do_id) as user_count,
                SUM(total_balance) as total,
                SUM(available_balance) as available,
                SUM(frozen_balance) as frozen
            FROM user_assets
            GROUP BY currency
        `).all() as any[];

        assetStats.forEach(stat => {
            console.log(`  ${stat.currency}:`);
            console.log(`    持有用户: ${stat.user_count}`);
            console.log(`    总余额: ${stat.total.toFixed(2)}`);
            console.log(`    可用: ${stat.available.toFixed(2)}`);
            console.log(`    冻结: ${stat.frozen.toFixed(2)}`);
        });

        // 6. 风控统计
        console.log('\n🛡️  风控统计:');
        const today = new Date().toISOString().split('T')[0];
        const limitStats = db.query(`
            SELECT 
                COUNT(DISTINCT linux_do_id) as user_count,
                SUM(orders_count) as total_orders,
                SUM(trades_count) as total_trades,
                SUM(total_trade_volume) as total_volume
            FROM user_daily_crypto_limits
            WHERE limit_date = ?
        `).get(today) as any;

        console.log(`  今日活跃用户: ${limitStats.user_count || 0}`);
        console.log(`  今日订单数: ${limitStats.total_orders || 0}`);
        console.log(`  今日成交数: ${limitStats.total_trades || 0}`);
        console.log(`  今日成交额: ${(limitStats.total_volume || 0).toFixed(2)} KC`);

        // 7. 系统配置
        console.log('\n⚙️  系统配置:');
        const config = db.query(`SELECT * FROM crypto_config WHERE id = 1`).get() as any;

        if (config) {
            console.log(`  Maker手续费: ${(config.maker_fee_rate * 100).toFixed(2)}%`);
            console.log(`  Taker手续费: ${(config.taker_fee_rate * 100).toFixed(2)}%`);
            console.log(`  每日最大交易次数: ${config.max_daily_trades}`);
            console.log(`  单用户最大挂单数: ${config.max_orders_per_user}`);
            console.log(`  价格偏离限制: ${(config.price_fluctuation_limit * 100).toFixed(0)}%`);
        } else {
            console.log('  未配置');
        }

        console.log('\n' + '='.repeat(60));
        console.log('✅ 统计完成\n');

    } catch (error) {
        console.error('❌ 统计失败:', error);
        process.exit(1);
    }
}

// 运行统计
showCryptoStats();

