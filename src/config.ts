export const CONFIG = {
    // 服务器配置
    PORT: parseInt(process.env.PORT || '3000'),
    HOST: process.env.HOST || '0.0.0.0',

    // Linux Do OAuth2
    LINUX_DO_CLIENT_ID: process.env.LINUX_DO_CLIENT_ID || '',
    LINUX_DO_CLIENT_SECRET: process.env.LINUX_DO_CLIENT_SECRET || '',
    LINUX_DO_REDIRECT_URI: process.env.LINUX_DO_REDIRECT_URI || '',

    // 管理员密码
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',

    // API 端点
    LINUX_DO_AUTH_URL: 'https://connect.linux.do/oauth2/authorize',
    LINUX_DO_TOKEN_URL: 'https://connect.linux.do/oauth2/token',
    LINUX_DO_USER_INFO_URL: 'https://connect.linux.do/api/user',
    KYX_API_BASE: 'https://api.kkyyxx.xyz',
    MODELSCOPE_API_BASE: 'https://api-inference.modelscope.cn/v1',

    // 默认配置
    DEFAULT_CLAIM_QUOTA: 20000000,
    DONATE_QUOTA_PER_KEY: 25000000,
    MIN_QUOTA_THRESHOLD: 10000000,
    MAX_DAILY_DONATE: 1,  // 每天最多投喂 1 个 Key

    // 数据库路径
    DATABASE_PATH: process.env.DATABASE_PATH || './data/kyxquota.db',
};

// 验证必要的环境变量
export function validateConfig() {
    const required = [
        'LINUX_DO_CLIENT_ID',
        'LINUX_DO_CLIENT_SECRET',
        'LINUX_DO_REDIRECT_URI',
    ];

    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        console.error('❌ 缺少必要的环境变量:');
        missing.forEach((key) => console.error(`   - ${key}`));
        console.error('\n请在 .env 文件中配置这些变量');
        console.error('示例: cp env.example .env');
        process.exit(1);
    }

    console.log('✅ 环境配置验证通过');
}

