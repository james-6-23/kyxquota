import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { CONFIG, validateConfig } from './config';
import { initDatabase, db } from './database';
import { cacheManager } from './cache';

// 验证配置
validateConfig();

// 初始化数据库
initDatabase();

// 创建应用
const app = new Hono();

// 导入路由
import userRoutes from './routes/user';
import adminRoutes from './routes/admin';
import oauthRoutes from './routes/oauth';

// 中间件
app.use('*', cors());

// 注册路由
app.route('/api', userRoutes);
app.route('/api/admin', adminRoutes);
app.route('/oauth', oauthRoutes);

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

// 启动服务器
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

