import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { CONFIG, validateConfig } from './config';
import { initDatabase, db } from './database';
import { cacheManager } from './cache';
import { startRewardProcessor } from './services/reward-processor';
import { startRankAchievementChecker } from './services/rank-achievement-checker';

// 验证配置
validateConfig();

// 初始化数据库
initDatabase();

// 🔥 预热概率缓存（避免重启后缓存丢失）
(async () => {
    try {
        const { warmupAllProbabilityCache } = await import('./services/probability-calculator');
        await warmupAllProbabilityCache();
    } catch (error) {
        console.error('⚠️ 概率缓存预热失败（不影响应用启动）:', error);
    }
})();

// 启动奖金自动发放服务
startRewardProcessor();

// 启动排行榜成就检查服务
startRankAchievementChecker();

// 启动排行榜数据清理服务
(async () => {
    const { cleanOldDailyStats, cleanOldWeeklyStats } = await import('./services/slot');
    
    // 立即执行一次清理
    try {
        cleanOldDailyStats();
        cleanOldWeeklyStats();
    } catch (error) {
        console.error('⚠️ 排行榜数据清理失败:', error);
    }
    
    // 每天凌晨3点执行清理（使用北京时间）
    setInterval(() => {
        const now = new Date();
        const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
        const beijingTime = new Date(utcTime + 8 * 3600000);
        const hour = beijingTime.getHours();
        const minute = beijingTime.getMinutes();
        
        // 在凌晨3点到3点5分之间执行（避免多次执行）
        if (hour === 3 && minute < 5) {
            try {
                cleanOldDailyStats();
                cleanOldWeeklyStats();
                console.log('✅ 排行榜过期数据清理完成');
            } catch (error) {
                console.error('❌ 排行榜数据清理失败:', error);
            }
        }
    }, 5 * 60 * 1000); // 每5分钟检查一次
    
    console.log('✅ 排行榜数据清理服务已启动（每天凌晨3点执行）');
})();

// 启动K线系统
(async () => {
    try {
        const { initKlineSystem } = await import('./services/crypto/kline-generator');
        await initKlineSystem();
        console.log('✅ K线系统已启动');
    } catch (error) {
        console.error('⚠️ K线系统启动失败:', error);
    }
})();

// 创建应用
const app = new Hono();

// 导入路由
import userRoutes from './routes/user';
import adminRoutes from './routes/admin';
import oauthRoutes from './routes/oauth';
import slotRoutes from './routes/slot';
import kunbeiRoutes from './routes/kunbei';
import supremeRoutes from './routes/supreme';
import achievementRoutes from './routes/achievement';
import cryptoRoutes from './routes/crypto';

// 导入WebSocket
import { upgradeWebSocket } from 'hono/bun';
import {
    wsManager,
    handleWebSocketMessage,
    startPeriodicPush,
    generateConnectionId,
} from './services/crypto/websocket-server';

// 中间件
app.use('*', cors());

// 注册路由
app.route('/api', userRoutes);
app.route('/api/admin', adminRoutes);
app.route('/oauth', oauthRoutes);
app.route('/api/slot', slotRoutes);
app.route('/api/kunbei', kunbeiRoutes);
app.route('/api/supreme', supremeRoutes);
app.route('/api/achievement', achievementRoutes);
app.route('/api/crypto', cryptoRoutes);

// WebSocket路由
app.get('/ws/trading',
    upgradeWebSocket((c) => {
        const connectionId = generateConnectionId();
        const session = c.get('session');
        const linuxDoId = session?.linux_do_id;

        return {
            onOpen(_event, ws) {
                wsManager.addConnection(connectionId, ws, linuxDoId);
            },

            onMessage(event, ws) {
                handleWebSocketMessage(ws, connectionId, event.data.toString(), linuxDoId);
            },

            onClose(_event, _ws) {
                wsManager.removeConnection(connectionId);
            },

            onError(event, _ws) {
                console.error(`WebSocket错误 [${connectionId}]:`, event);
                wsManager.removeConnection(connectionId);
            },
        };
    })
);

// 启动WebSocket定时推送
startPeriodicPush();

// 静态文件服务（老虎机符号图片）
app.get('/slot-symbols/:filename', async (c) => {
    const filename = c.req.param('filename');
    const file = Bun.file(`public/slot-symbols/${filename}`);
    if (await file.exists()) {
        return new Response(file);
    }
    return c.notFound();
});

// 静态文件服务（音效文件）
app.get('/sounds/:filename', async (c) => {
    const filename = c.req.param('filename');
    const file = Bun.file(`public/sounds/${filename}`);
    if (await file.exists()) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const contentType = ext === 'mp3' ? 'audio/mpeg' :
            ext === 'wav' ? 'audio/wav' :
                'application/octet-stream';

        return new Response(file, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
    return c.notFound();
});

// 静态文件服务（老虎机背景GIF）
app.get('/ctrl.gif', async (c) => {
    const file = Bun.file('public/ctrl.gif');
    const exists = await file.exists();

    console.log(`[静态文件] ctrl.gif 请求 - 文件存在: ${exists}, 路径: public/ctrl.gif`);

    if (exists) {
        // 读取文件内容并设置正确的 Content-Type
        const buffer = await file.arrayBuffer();
        return new Response(buffer, {
            headers: {
                'Content-Type': 'image/gif',
                'Content-Length': buffer.byteLength.toString(),
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Access-Control-Allow-Origin': '*',
                'Accept-Ranges': 'bytes'
            }
        });
    }

    console.error('[静态文件] ❌ ctrl.gif 文件不存在！');
    return c.notFound();
});

// 首页
app.get('/', async (c) => {
    let html = await Bun.file('src/templates/user.html').text();
    // 注入环境变量
    html = html.replace(
        "LINUX_DO_CLIENT_ID: ''",
        `LINUX_DO_CLIENT_ID: '${CONFIG.LINUX_DO_CLIENT_ID}'`
    );
    return c.html(html);
});

// 管理后台
app.get('/admin', async (c) => {
    const html = await Bun.file('src/templates/admin.html').text();
    return c.html(html);
});

// 交易页面
app.get('/trading', async (c) => {
    const html = await Bun.file('src/templates/trading.html').text();
    return c.html(html);
});

// 虚拟币交易管理页面
app.get('/crypto-admin', async (c) => {
    const html = await Bun.file('src/templates/crypto-admin.html').text();
    return c.html(html);
});

// 404
app.notFound((c) => {
    return c.text('Not Found', 404);
});

// 错误处理
app.onError((err, c) => {
    console.error('Error:', err);
    return c.json(
        {
            success: false,
            message: err.message || 'Internal Server Error',
        },
        500
    );
});

// 优雅关闭
process.on('SIGTERM', async () => {
    console.log('📴 SIGTERM received, shutting down gracefully...');
    cacheManager.shutdown();
    db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('📴 SIGINT received, shutting down gracefully...');
    cacheManager.shutdown();
    db.close();
    process.exit(0);
});

// 启动前检查关键文件
async function checkCriticalFiles() {
    const criticalFiles = [
        { path: 'public/ctrl.gif', desc: 'GIF 背景文件' },
        { path: 'public/slot-symbols/bdk.jpg', desc: '老虎机符号' },
        { path: 'public/sounds/mixkit-slot-machine-win-1928.wav', desc: '转动音效' },
        { path: 'public/sounds/mixkit-coin-win-notification-1992.wav', desc: '中奖音效' },
        { path: 'public/sounds/ngmhhy.mp3', desc: '未中奖音效' },
        { path: 'src/templates/user.html', desc: '用户页面模板' },
        { path: 'src/templates/admin.html', desc: '管理页面模板' }
    ];

    console.log('\n🔍 检查关键文件...');
    let allExists = true;

    for (const { path, desc } of criticalFiles) {
        const file = Bun.file(path);
        const exists = await file.exists();
        const status = exists ? '✅' : '❌';
        console.log(`   ${status} ${desc}: ${path}`);
        if (!exists) allExists = false;
    }

    if (!allExists) {
        console.error('\n⚠️  警告：部分关键文件缺失，可能影响功能！\n');
    } else {
        console.log('   ✅ 所有关键文件检查通过\n');
    }

    return allExists;
}

// 启动服务器
async function startServer() {
    // 检查文件
    await checkCriticalFiles();

    Bun.serve({
        port: CONFIG.PORT,
        hostname: CONFIG.HOST,
        fetch: app.fetch,
    });

    console.log(`
🚀 KYX API Refueling Station is running!

   URL: http://${CONFIG.HOST}:${CONFIG.PORT}
   Admin: http://${CONFIG.HOST}:${CONFIG.PORT}/admin
   
   Database: ${CONFIG.DATABASE_PATH}
   Environment: ${process.env.NODE_ENV || 'development'}
`);
}

startServer();



