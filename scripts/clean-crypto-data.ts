/**
 * 清理虚拟币交易系统数据
 * 用于重置测试环境
 */

import { db } from '../src/database';

async function cleanCryptoData() {
    console.log('🧹 开始清理虚拟币交易数据...\n');

    try {
        // 确认操作
        const tables = [
            'trade_orders',
            'trade_fills',
            'klines',
            'margin_positions',
            'liquidations',
            'user_daily_crypto_limits',
            'market_tickers',
            'order_book_depths'
        ];

        console.log('⚠️  警告：此操作将删除以下表的所有数据：');
        tables.forEach(table => console.log(`  - ${table}`));
        console.log('\n❓ 确认要继续吗？（脚本会在5秒后自动执行）\n');

        // 等待5秒
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 开始清理
        for (const table of tables) {
            const result = db.run(`DELETE FROM ${table}`);
            console.log(`✅ 清理 ${table}: 删除了 ${result.changes} 条记录`);
        }

        // 重置用户资产（可选）
        console.log('\n💰 重置用户资产（可选）...');
        console.log('  ℹ️  跳过资产重置（如需重置，请手动执行）');

        console.log('\n✅ 清理完成！\n');
        console.log('📊 已清理的数据：');
        console.log('  - 所有订单记录');
        console.log('  - 所有成交记录');
        console.log('  - 所有K线数据');
        console.log('  - 所有持仓记录');
        console.log('  - 所有强平记录');
        console.log('  - 所有交易限制记录');
        console.log('\n🎯 你现在可以：');
        console.log('  1. 重新初始化数据: bun run scripts/init-crypto-data.ts');
        console.log('  2. 或直接开始新的测试\n');

    } catch (error) {
        console.error('❌ 清理失败:', error);
        process.exit(1);
    }
}

// 运行清理
cleanCryptoData();

