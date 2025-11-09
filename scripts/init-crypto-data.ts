/**
 * 初始化虚拟币交易系统测试数据
 * 用于快速测试和演示
 */

import { db } from '../src/database';

async function initCryptoData() {
    console.log('🚀 开始初始化虚拟币交易测试数据...\n');

    try {
        // 1. 检查并创建测试用户资产
        console.log('📦 1. 初始化测试用户资产...');
        
        const testUsers = [
            { linuxDoId: 'test_user_1', username: 'Alice' },
            { linuxDoId: 'test_user_2', username: 'Bob' },
            { linuxDoId: 'test_user_3', username: 'Charlie' },
        ];

        for (const user of testUsers) {
            // 检查是否已有资产
            const existingQuota = db.query(`
                SELECT * FROM user_assets 
                WHERE linux_do_id = ? AND currency = 'QUOTA'
            `).get(user.linuxDoId);

            const existingKC = db.query(`
                SELECT * FROM user_assets 
                WHERE linux_do_id = ? AND currency = 'KC'
            `).get(user.linuxDoId);

            if (!existingQuota) {
                db.run(`
                    INSERT INTO user_assets (
                        linux_do_id, currency, total_balance, available_balance, 
                        frozen_balance, updated_at
                    ) VALUES (?, 'QUOTA', 10000, 10000, 0, ?)
                `, [user.linuxDoId, Date.now()]);
                console.log(`  ✅ 创建 ${user.username} 的 QUOTA 资产: 10,000`);
            } else {
                console.log(`  ⏭️  ${user.username} 的 QUOTA 资产已存在`);
            }

            if (!existingKC) {
                db.run(`
                    INSERT INTO user_assets (
                        linux_do_id, currency, total_balance, available_balance, 
                        frozen_balance, updated_at
                    ) VALUES (?, 'KC', 1000000, 1000000, 0, ?)
                `, [user.linuxDoId, Date.now()]);
                console.log(`  ✅ 创建 ${user.username} 的 KC 资产: 1,000,000`);
            } else {
                console.log(`  ⏭️  ${user.username} 的 KC 资产已存在`);
            }
        }

        // 2. 检查交易对配置
        console.log('\n💱 2. 检查交易对配置...');
        const pair = db.query(`
            SELECT * FROM trading_pairs WHERE symbol = 'QUOTA/KC'
        `).get();

        if (!pair) {
            db.run(`
                INSERT INTO trading_pairs (
                    symbol, base_currency, quote_currency, 
                    min_order_amount, max_order_amount, 
                    price_precision, amount_precision,
                    enabled, created_at
                ) VALUES (
                    'QUOTA/KC', 'QUOTA', 'KC',
                    0.01, 10000,
                    2, 4,
                    1, ?
                )
            `, [Date.now()]);
            console.log('  ✅ 创建 QUOTA/KC 交易对');
        } else {
            console.log('  ⏭️  QUOTA/KC 交易对已存在');
        }

        // 3. 检查系统配置
        console.log('\n⚙️  3. 检查系统配置...');
        const config = db.query(`
            SELECT * FROM crypto_config WHERE id = 1
        `).get();

        if (!config) {
            db.run(`
                INSERT INTO crypto_config (
                    id, maker_fee_rate, taker_fee_rate,
                    max_leverage, default_leverage,
                    max_daily_trades, max_orders_per_user,
                    price_fluctuation_limit, max_position_value_ratio,
                    liquidation_threshold, maintenance_margin_rate,
                    created_at, updated_at
                ) VALUES (
                    1, 0.001, 0.0015,
                    10, 1,
                    100, 20,
                    0.1, 0.5,
                    0.8, 0.05,
                    ?, ?
                )
            `, [Date.now(), Date.now()]);
            console.log('  ✅ 创建系统配置');
        } else {
            console.log('  ⏭️  系统配置已存在');
        }

        // 4. 创建一些测试订单（可选）
        console.log('\n📋 4. 创建测试订单（可选）...');
        console.log('  ℹ️  跳过测试订单创建（可通过前端手动创建）');

        console.log('\n✅ 初始化完成！\n');
        console.log('📊 数据摘要:');
        console.log(`  - 测试用户: ${testUsers.length} 个`);
        console.log(`  - QUOTA 资产: 10,000 / 用户`);
        console.log(`  - KC 资产: 1,000,000 / 用户`);
        console.log(`  - 交易对: QUOTA/KC`);
        console.log('\n🎯 你现在可以：');
        console.log('  1. 启动应用: bun run dev');
        console.log('  2. 访问交易大厅: http://localhost:3000/trading');
        console.log('  3. 使用测试账号登录（需要配置LinuxDo OAuth）');
        console.log('  4. 开始交易测试！\n');

    } catch (error) {
        console.error('❌ 初始化失败:', error);
        process.exit(1);
    }
}

// 运行初始化
initCryptoData();

