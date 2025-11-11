import { Hono } from 'hono';
import { walletService } from '../services/wallet';
import { transferService } from '../services/transfer';
import { getKyxUserById } from '../services/kyx-api';
import { adminQueries, userQueries } from '../database';
import { formatKYX, formatUSD, kyxToUSD, quotaToUSD, quotaToKYX, CURRENCY } from '../utils/currency';

const app = new Hono();

// ========== 钱包查询 API ==========

/**
 * 获取钱包信息
 * GET /api/wallet/info
 */
app.get('/info', async (c) => {
    const session = c.req.query('session');
    if (!session) {
        return c.json({ success: false, message: '未登录' }, 401);
    }

    try {
        // 从 sessions 表获取用户信息
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '会话无效' }, 401);
        }

        const linuxDoId = sessionData.linux_do_id;
        const user = userQueries.get.get(linuxDoId);

        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取钱包信息
        const wallet = walletService.getOrCreateWallet(linuxDoId);
        const available = walletService.getAvailableBalance(linuxDoId);

        // 获取今日划转统计
        const todayStats = transferService.getTodayTransferStats(linuxDoId);

        return c.json({
            success: true,
            wallet: {
                kyx_balance: wallet.kyx_balance,
                kyx_frozen: wallet.kyx_frozen,
                kyx_available: available,
                kyx_balance_formatted: formatKYX(wallet.kyx_balance),
                kyx_available_formatted: formatKYX(available),
                usd_equivalent: kyxToUSD(wallet.kyx_balance),
                usd_equivalent_formatted: formatUSD(kyxToUSD(wallet.kyx_balance)),
                total_earned: wallet.total_earned,
                total_spent: wallet.total_spent,
                total_transfer_in: wallet.total_transfer_in,
                total_transfer_out: wallet.total_transfer_out,
            },
            today_transfer: {
                count: todayStats.count,
                remaining: transferService.config.MAX_DAILY_TRANSFERS - todayStats.count,
                total_kyx: todayStats.totalKYX,
                total_usd: todayStats.totalUSD,
            },
            config: {
                min_transfer_kyx: transferService.config.MIN_TRANSFER_KYX,
                max_transfer_kyx: transferService.config.MAX_TRANSFER_KYX,
                max_daily_transfers: transferService.config.MAX_DAILY_TRANSFERS,
                exchange_rate: CURRENCY.EXCHANGE_RATE,
            }
        });
    } catch (error: any) {
        console.error('[钱包API] 获取钱包信息失败:', error);
        return c.json({
            success: false,
            message: error.message || '获取钱包信息失败'
        }, 500);
    }
});

/**
 * 获取交易记录
 * GET /api/wallet/transactions?page=1&pageSize=20
 */
app.get('/transactions', async (c) => {
    const session = c.req.query('session');
    if (!session) {
        return c.json({ success: false, message: '未登录' }, 401);
    }

    try {
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '会话无效' }, 401);
        }

        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '20');

        const transactions = walletService.getTransactions(sessionData.linux_do_id, page, pageSize);

        return c.json({
            success: true,
            transactions: transactions.map(tx => ({
                ...tx,
                amount_formatted: formatKYX(Math.abs(tx.amount)),
                balance_after_formatted: formatKYX(tx.balance_after),
                is_income: tx.amount > 0,
                timestamp_formatted: new Date(tx.timestamp).toLocaleString('zh-CN')
            })),
            page,
            pageSize
        });
    } catch (error: any) {
        console.error('[钱包API] 获取交易记录失败:', error);
        return c.json({
            success: false,
            message: error.message || '获取交易记录失败'
        }, 500);
    }
});

/**
 * 获取划转记录
 * GET /api/wallet/transfers?page=1&pageSize=20
 */
app.get('/transfers', async (c) => {
    const session = c.req.query('session');
    if (!session) {
        return c.json({ success: false, message: '未登录' }, 401);
    }

    try {
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '会话无效' }, 401);
        }

        const page = parseInt(c.req.query('page') || '1');
        const pageSize = parseInt(c.req.query('pageSize') || '20');

        const transfers = transferService.getTransferRecords(sessionData.linux_do_id, page, pageSize);

        return c.json({
            success: true,
            transfers: transfers.map(tr => ({
                ...tr,
                amount_kyx_formatted: formatKYX(tr.amount_kyx),
                amount_usd_formatted: formatUSD(tr.amount_usd),
                timestamp_formatted: new Date(tr.timestamp).toLocaleString('zh-CN'),
                completed_at_formatted: tr.completed_at ? new Date(tr.completed_at).toLocaleString('zh-CN') : null
            })),
            page,
            pageSize
        });
    } catch (error: any) {
        console.error('[钱包API] 获取划转记录失败:', error);
        return c.json({
            success: false,
            message: error.message || '获取划转记录失败'
        }, 500);
    }
});

// ========== 划转 API ==========

/**
 * 划转到公益站
 * POST /api/wallet/transfer
 * Body: { amount_kyx: number }
 */
app.post('/transfer', async (c) => {
    try {
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const { amount_kyx } = await c.req.json();

        if (!amount_kyx || amount_kyx <= 0) {
            return c.json({
                success: false,
                message: '请输入有效的划转金额'
            }, 400);
        }

        // 获取用户信息
        const user = userQueries.get.get(sessionData.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig || !adminConfig.session) {
            return c.json({
                success: false,
                message: '系统配置错误，请联系管理员'
            }, 500);
        }

        // 执行划转
        const result = await transferService.transferToAPI(
            user.linux_do_id,
            user.username,
            user.kyx_user_id,
            amount_kyx,
            adminConfig.session,
            adminConfig.new_api_user
        );

        return c.json(result);
    } catch (error: any) {
        console.error('[钱包API] 划转失败:', error);
        return c.json({
            success: false,
            message: error.message || '划转失败'
        }, 500);
    }
});

/**
 * 反向划转：从公益站划转到 KYX 钱包
 * POST /api/wallet/transfer-from-api
 * Body: { amount_quota: number }
 */
app.post('/transfer-from-api', async (c) => {
    try {
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        const { amount_quota } = await c.req.json();

        if (!amount_quota || amount_quota <= 0) {
            return c.json({
                success: false,
                message: '请输入有效的划转金额'
            }, 400);
        }

        // 获取用户信息
        const user = userQueries.get.get(sessionData.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig || !adminConfig.session) {
            return c.json({
                success: false,
                message: '系统配置错误，请联系管理员'
            }, 500);
        }

        // 检查是否启用反向划转
        if (!adminConfig.transfer_reverse_enabled) {
            return c.json({
                success: false,
                message: '反向划转功能未启用'
            }, 403);
        }

        // 执行反向划转
        const result = await transferService.transferFromAPI(
            user.linux_do_id,
            user.username,
            user.kyx_user_id,
            amount_quota,
            adminConfig.session,
            adminConfig.new_api_user
        );

        return c.json(result);
    } catch (error: any) {
        console.error('[钱包API] 反向划转失败:', error);
        return c.json({
            success: false,
            message: error.message || '反向划转失败'
        }, 500);
    }
});

/**
 * 获取公益站账户余额
 * GET /api/wallet/api-balance
 */
app.get('/api-balance', async (c) => {
    try {
        const sessionData = c.get('session');
        if (!sessionData) {
            return c.json({ success: false, message: '未登录' }, 401);
        }

        // 获取用户信息
        const user = userQueries.get.get(sessionData.linux_do_id);
        if (!user) {
            return c.json({ success: false, message: '用户不存在' }, 404);
        }

        // 获取管理员配置
        const adminConfig = adminQueries.get.get();
        if (!adminConfig || !adminConfig.session) {
            return c.json({
                success: false,
                message: '系统配置错误'
            }, 500);
        }

        // 从 KYX API 获取最新余额
        const apiResult = await getKyxUserById(
            user.kyx_user_id,
            adminConfig.session,
            adminConfig.new_api_user
        );

        if (apiResult.success && apiResult.user) {
            const quota = apiResult.user.quota;
            const usd = quotaToUSD(quota);
            const kyx = quotaToKYX(quota);

            return c.json({
                success: true,
                balance: {
                    quota,
                    usd,
                    kyx,
                    quota_formatted: quota.toLocaleString(),
                    usd_formatted: formatUSD(usd),
                    kyx_formatted: formatKYX(kyx),
                }
            });
        } else {
            return c.json({
                success: false,
                message: apiResult.message || '获取余额失败'
            }, 500);
        }
    } catch (error: any) {
        console.error('[钱包API] 获取公益站余额失败:', error);
        return c.json({
            success: false,
            message: error.message || '获取余额失败'
        }, 500);
    }
});

export default app;
