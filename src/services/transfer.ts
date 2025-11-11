import { db } from '../database';
import { walletService } from './wallet';
import { addQuota, deductQuota } from './kyx-api';
import { kyxToUSD, kyxToQuota, quotaToKYX, CURRENCY, formatKYX, formatUSD, formatQuota } from '../utils/currency';
import { logger } from '../utils/logger';
import type { TransferRecord } from './wallet';

// ========== 数据库查询（懒加载模式） ==========

let _recordTransferStmt: any;
let _updateTransferStatusStmt: any;
let _updateTransferStatsStmt: any;
let _getTransferRecordsStmt: any;
let _getTodayTransferCountStmt: any;

function initStatements() {
    if (!_recordTransferStmt) {
        _recordTransferStmt = db.prepare(`
            INSERT INTO transfer_records (
                linux_do_id,
                username,
                transfer_type,
                amount_kyx,
                amount_usd,
                amount_quota,
                exchange_rate,
                status,
                fee_kyx,
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        _updateTransferStatusStmt = db.prepare(`
            UPDATE transfer_records
            SET status = ?,
                api_response = ?,
                error_message = ?,
                completed_at = ?
            WHERE id = ?
        `);
        _updateTransferStatsStmt = db.prepare(`
            UPDATE user_wallets
            SET total_transfer_in = total_transfer_in + ?,
                total_transfer_out = total_transfer_out + ?,
                updated_at = ?
            WHERE linux_do_id = ?
        `);
        _getTransferRecordsStmt = db.prepare<TransferRecord, [string, number, number]>(`
            SELECT * FROM transfer_records
            WHERE linux_do_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `);
        _getTodayTransferCountStmt = db.prepare<{ count: number }, [string, number, number]>(`
            SELECT COUNT(*) as count
            FROM transfer_records
            WHERE linux_do_id = ?
                AND timestamp >= ?
                AND timestamp < ?
                AND status = 'completed'
        `);
    }
}

const recordTransferStmt = () => { initStatements(); return _recordTransferStmt; };
const updateTransferStatusStmt = () => { initStatements(); return _updateTransferStatusStmt; };
const updateTransferStatsStmt = () => { initStatements(); return _updateTransferStatsStmt; };
const getTransferRecordsStmt = () => { initStatements(); return _getTransferRecordsStmt; };
const getTodayTransferCountStmt = () => { initStatements(); return _getTodayTransferCountStmt; };

// ========== 划转配置 ==========

export const TRANSFER_CONFIG = {
    MIN_TRANSFER_KYX: 25,        // 最小划转: 25 KYX ($10)
    MAX_TRANSFER_KYX: 2500,      // 最大划转: 2500 KYX ($1000)
    MAX_DAILY_TRANSFERS: 10,     // 每日最大划转次数
    FEE_RATE: 0,                 // 手续费率 (0 = 免费)
};

// ========== 划转核心功能 ==========

/**
 * 划转 KYX 到公益站
 * @param linuxDoId 用户ID
 * @param username 用户名
 * @param kyxUserId KYX API 用户ID
 * @param amountKYX 划转金额(KYX)
 * @param session API Session
 * @param newApiUser API User
 * @returns 划转结果
 */
export async function transferToAPI(
    linuxDoId: string,
    username: string,
    kyxUserId: number,
    amountKYX: number,
    session: string,
    newApiUser: string = '1'
): Promise<{ success: boolean; message: string; transferId?: number }> {
    logger.info('划转', `💸 ${username} 请求划转 ${formatKYX(amountKYX)} 到公益站`);

    // 1. 验证金额范围
    if (amountKYX < TRANSFER_CONFIG.MIN_TRANSFER_KYX) {
        return {
            success: false,
            message: `划转金额不能少于 ${formatKYX(TRANSFER_CONFIG.MIN_TRANSFER_KYX)}`
        };
    }

    if (amountKYX > TRANSFER_CONFIG.MAX_TRANSFER_KYX) {
        return {
            success: false,
            message: `单次划转不能超过 ${formatKYX(TRANSFER_CONFIG.MAX_TRANSFER_KYX)}`
        };
    }

    // 2. 检查每日划转次数
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today).getTime();
    const todayTransfers = db.prepare(`
        SELECT COUNT(*) as count FROM transfer_records
        WHERE linux_do_id = ? AND timestamp >= ? AND status = 'success'
    `).get(linuxDoId, todayStart) as { count: number };

    if (todayTransfers.count >= TRANSFER_CONFIG.MAX_DAILY_TRANSFERS) {
        return {
            success: false,
            message: `今日划转次数已达上限 (${TRANSFER_CONFIG.MAX_DAILY_TRANSFERS}次)`
        };
    }

    // 3. 换算金额
    const amountQuota = kyxToQuota(amountKYX);
    const amountUSD = amountQuota;  // amount_usd 字段存储的是 quota（聪单位），与 amount_quota 相同
    const fee = Math.floor(amountKYX * TRANSFER_CONFIG.FEE_RATE);
    const actualAmount = amountKYX + fee;

    logger.info('划转', `💸 金额换算: ${formatKYX(amountKYX)} = ${formatQuota(amountQuota)} = ${amountQuota} quota`);
    if (fee > 0) {
        logger.info('划转', `💸 手续费: ${formatKYX(fee)}`);
    }

    // 4. 检查余额
    try {
        const available = walletService.getAvailableBalance(linuxDoId);
        if (available < actualAmount) {
            return {
                success: false,
                message: `余额不足: 可用 ${formatKYX(available)}, 需要 ${formatKYX(actualAmount)}${fee > 0 ? ' (含手续费)' : ''}`
            };
        }
    } catch (error: any) {
        return {
            success: false,
            message: `获取余额失败: ${error.message}`
        };
    }

    // 5. 冻结金额
    try {
        walletService.freezeKYX(linuxDoId, actualAmount);
    } catch (error: any) {
        return {
            success: false,
            message: `冻结金额失败: ${error.message}`
        };
    }

    // 6. 创建划转记录
    let transferResult;
    try {
        transferResult = recordTransferStmt().run(
            linuxDoId,
            username,
            'kyx_to_api',
            amountKYX,
            amountUSD,
            amountQuota,
            CURRENCY.EXCHANGE_RATE,
            'pending',
            fee,
            Date.now()
        );
    } catch (error: any) {
        // 解冻金额
        walletService.unfreezeKYX(linuxDoId, actualAmount);
        logger.error('划转', `❌ 创建划转记录异常:`, error);
        return {
            success: false,
            message: `创建划转记录失败: ${error.message || '数据库错误'}`
        };
    }

    if (!transferResult || !transferResult.lastInsertRowid) {
        // 解冻金额
        walletService.unfreezeKYX(linuxDoId, actualAmount);
        logger.error('划转', `❌ 创建划转记录失败: transferResult =`, transferResult);
        return {
            success: false,
            message: '创建划转记录失败，请稍后重试'
        };
    }

    const transferId = Number(transferResult.lastInsertRowid);

    // 7. 请求 KYX API
    try {
        logger.info('划转', `💸 请求 KYX API 增加 ${formatQuota(amountQuota)} (${amountQuota} quota)`);

        const apiResult = await addQuota(
            kyxUserId,
            amountQuota,
            session,
            newApiUser,
            `[划转] ${username}`,
            5  // 最大重试5次
        );

        if (apiResult.success) {
            // 成功：扣除冻结的 KYX
            walletService.deductKYX(linuxDoId, actualAmount, 'transfer_out', `划转到公益站: ${formatQuota(amountQuota)}`, transferId);
            walletService.unfreezeKYX(linuxDoId, actualAmount);

            // 更新划转统计
            updateTransferStatsStmt().run(0, amountKYX, Date.now(), linuxDoId);

            // 更新划转记录
            updateTransferStatusStmt().run(
                'success',
                JSON.stringify(apiResult),
                null,
                Date.now(),
                transferId
            );

            logger.info('划转', `✅ ${username} 划转成功: ${formatKYX(amountKYX)} → ${formatQuota(amountQuota)}`);

            return {
                success: true,
                message: `划转成功！已增加 ${formatQuota(amountQuota)} 到公益站账户`,
                transferId
            };
        } else {
            // 失败：解冻 KYX
            walletService.unfreezeKYX(linuxDoId, actualAmount);

            // 更新划转记录
            updateTransferStatusStmt().run(
                'failed',
                JSON.stringify(apiResult),
                apiResult.message || '未知错误',
                Date.now(),
                transferId
            );

            logger.error('划转', `❌ ${username} 划转失败: ${apiResult.message}`);

            return {
                success: false,
                message: `划转失败: ${apiResult.message || '未知错误'}`,
                transferId
            };
        }
    } catch (error: any) {
        // 异常：解冻 KYX
        walletService.unfreezeKYX(linuxDoId, actualAmount);

        // 更新划转记录
        updateTransferStatusStmt().run(
            'failed',
            null,
            error.message || '网络错误',
            Date.now(),
            transferId
        );

        logger.error('划转', `❌ ${username} 划转异常:`, error);

        return {
            success: false,
            message: `划转失败: ${error.message || '网络错误'}`,
            transferId
        };
    }
}

/**
 * 获取划转记录
 */
export function getTransferRecords(linuxDoId: string, page: number = 1, pageSize: number = 20): TransferRecord[] {
    const offset = (page - 1) * pageSize;
    return getTransferRecordsStmt().all(linuxDoId, pageSize, offset);
}

/**
 * 获取今日划转统计
 */
export function getTodayTransferStats(linuxDoId: string): { count: number; totalKYX: number; totalUSD: number } {
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today).getTime();

    const result = db.prepare(`
        SELECT
            COUNT(*) as count,
            COALESCE(SUM(amount_kyx), 0) as total_kyx,
            COALESCE(SUM(amount_usd), 0) as total_usd
        FROM transfer_records
        WHERE linux_do_id = ? AND timestamp >= ? AND status = 'success'
    `).get(linuxDoId, todayStart) as { count: number; total_kyx: number; total_usd: number };

    return result;
}

/**
 * 反向划转：从公益站划转到 KYX 钱包
 * @param linuxDoId 用户ID
 * @param username 用户名
 * @param kyxUserId KYX API 用户ID
 * @param amountQuota 划转金额(Quota)
 * @param session API Session
 * @param newApiUser API User
 * @returns 划转结果
 */
export async function transferFromAPI(
    linuxDoId: string,
    username: string,
    kyxUserId: number,
    amountQuota: number,
    session: string,
    newApiUser: string = '1'
): Promise<{ success: boolean; message: string; transferId?: number }> {
    logger.info('反向划转', `💸 ${username} 请求从公益站划转 ${amountQuota} quota 到 KYX 钱包`);

    // 1. 换算金额
    const amountKYX = quotaToKYX(amountQuota);
    const amountUSD = amountQuota;  // 修复：amount_usd 字段存储的是 quota（聪单位），与 amount_quota 相同

    // 2. 验证金额范围（使用相同的限制）
    if (amountKYX < TRANSFER_CONFIG.MIN_TRANSFER_KYX) {
        return {
            success: false,
            message: `划转金额不能少于 ${formatKYX(TRANSFER_CONFIG.MIN_TRANSFER_KYX)}`
        };
    }

    if (amountKYX > TRANSFER_CONFIG.MAX_TRANSFER_KYX) {
        return {
            success: false,
            message: `单次划转不能超过 ${formatKYX(TRANSFER_CONFIG.MAX_TRANSFER_KYX)}`
        };
    }

    // 3. 检查每日划转次数
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today).getTime();
    const todayTransfers = db.prepare(`
        SELECT COUNT(*) as count FROM transfer_records
        WHERE linux_do_id = ? AND timestamp >= ? AND status = 'success'
    `).get(linuxDoId, todayStart) as { count: number };

    if (todayTransfers.count >= TRANSFER_CONFIG.MAX_DAILY_TRANSFERS) {
        return {
            success: false,
            message: `今日划转次数已达上限 (${TRANSFER_CONFIG.MAX_DAILY_TRANSFERS}次)`
        };
    }

    logger.info('反向划转', `💸 金额换算: ${amountQuota} quota = ${formatKYX(amountKYX)} = ${formatQuota(amountQuota)}`);

    // 4. 创建划转记录
    let transferResult;
    try {
        transferResult = recordTransferStmt().run(
            linuxDoId,
            username,
            'api_to_kyx',
            amountKYX,
            amountUSD,
            amountQuota,
            CURRENCY.EXCHANGE_RATE,
            'pending',
            0,  // 反向划转无手续费
            Date.now()
        );
    } catch (error: any) {
        logger.error('反向划转', `❌ 创建划转记录异常:`, error);
        return {
            success: false,
            message: `创建划转记录失败: ${error.message || '数据库错误'}`
        };
    }

    if (!transferResult || !transferResult.lastInsertRowid) {
        logger.error('反向划转', `❌ 创建划转记录失败: transferResult =`, transferResult);
        return {
            success: false,
            message: '创建划转记录失败，请稍后重试'
        };
    }

    const transferId = Number(transferResult.lastInsertRowid);

    // 5. 请求 KYX API 扣除额度
    try {
        logger.info('反向划转', `💸 请求 KYX API 扣除 ${formatQuota(amountQuota)} (${amountQuota} quota)`);

        const apiResult = await deductQuota(
            kyxUserId,
            amountQuota,
            session,
            newApiUser,
            `[反向划转] ${username}`,
            5  // 最大重试5次
        );

        if (apiResult.success) {
            // 成功：增加 KYX 到钱包
            walletService.addKYX(linuxDoId, amountKYX, 'transfer_in', `从公益站划转: ${formatQuota(amountQuota)}`, transferId);

            // 更新划转统计
            updateTransferStatsStmt().run(amountKYX, 0, Date.now(), linuxDoId);

            // 更新划转记录
            updateTransferStatusStmt().run(
                'success',
                JSON.stringify(apiResult),
                null,
                Date.now(),
                transferId
            );

            logger.info('反向划转', `✅ ${username} 划转成功: ${formatQuota(amountQuota)} → ${formatKYX(amountKYX)}`);

            return {
                success: true,
                message: `划转成功！已增加 ${formatKYX(amountKYX)} 到 KYX 钱包`,
                transferId
            };
        } else {
            // 失败：更新记录
            updateTransferStatusStmt().run(
                'failed',
                JSON.stringify(apiResult),
                apiResult.message || '未知错误',
                Date.now(),
                transferId
            );

            logger.error('反向划转', `❌ ${username} 划转失败: ${apiResult.message}`);

            return {
                success: false,
                message: `划转失败: ${apiResult.message || '未知错误'}`,
                transferId
            };
        }
    } catch (error: any) {
        // 异常：更新记录
        updateTransferStatusStmt().run(
            'failed',
            null,
            error.message || '网络错误',
            Date.now(),
            transferId
        );

        logger.error('反向划转', `❌ ${username} 划转异常:`, error);

        return {
            success: false,
            message: `划转失败: ${error.message || '网络错误'}`,
            transferId
        };
    }
}

// ========== 导出 ==========

export const transferService = {
    transferToAPI,
    transferFromAPI,
    getTransferRecords,
    getTodayTransferStats,
    config: TRANSFER_CONFIG,
};
