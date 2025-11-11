import { db, batchTransaction } from '../database';
import { usdToKYX, kyxToUSD, quotaToKYX, kyxToQuota, CURRENCY, formatKYX, formatUSD } from '../utils/currency';

// ========== 类型定义 ==========

export interface UserWallet {
    id: number;
    linux_do_id: string;
    kyx_balance: number;
    kyx_frozen: number;
    total_earned: number;
    total_spent: number;
    total_transfer_in: number;
    total_transfer_out: number;
    created_at: number;
    updated_at: number;
}

export interface KYXTransaction {
    id: number;
    linux_do_id: string;
    transaction_type: string;
    amount: number;
    balance_before: number;
    balance_after: number;
    related_id?: number;
    description?: string;
    timestamp: number;
}

export interface TransferRecord {
    id: number;
    linux_do_id: string;
    username: string;
    transfer_type: string;
    amount_kyx: number;
    amount_usd: number;
    amount_quota: number;
    exchange_rate: number;
    status: string;
    api_response?: string;
    error_message?: string;
    fee_kyx: number;
    timestamp: number;
    completed_at?: number;
}

// ========== 数据库查询（懒加载模式） ==========

// 使用懒加载避免在模块加载时执行 prepare（此时表可能还未创建）
let _getWalletStmt: any;
let _createWalletStmt: any;
let _updateBalanceStmt: any;
let _updateFrozenStmt: any;
let _updateStatsStmt: any;
let _recordTransactionStmt: any;
let _getTransactionsStmt: any;
let _recordTransferStmt: any;
let _updateTransferStatusStmt: any;

function initStatements() {
    if (!_getWalletStmt) {
        _getWalletStmt = db.prepare<UserWallet, [string]>(`
            SELECT * FROM user_wallets WHERE linux_do_id = ?
        `);
        _createWalletStmt = db.prepare(`
            INSERT INTO user_wallets (linux_do_id, created_at, updated_at)
            VALUES (?, ?, ?)
        `);
        _updateBalanceStmt = db.prepare(`
            UPDATE user_wallets
            SET kyx_balance = ?,
                updated_at = ?
            WHERE linux_do_id = ?
        `);
        _updateFrozenStmt = db.prepare(`
            UPDATE user_wallets
            SET kyx_frozen = ?,
                updated_at = ?
            WHERE linux_do_id = ?
        `);
        _updateStatsStmt = db.prepare(`
            UPDATE user_wallets
            SET total_earned = total_earned + ?,
                total_spent = total_spent + ?,
                updated_at = ?
            WHERE linux_do_id = ?
        `);
        _recordTransactionStmt = db.prepare(`
            INSERT INTO kyx_transactions (
                linux_do_id,
                transaction_type,
                amount,
                balance_before,
                balance_after,
                related_id,
                description,
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        _getTransactionsStmt = db.prepare<KYXTransaction, [string, number, number]>(`
            SELECT * FROM kyx_transactions
            WHERE linux_do_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `);
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
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        _updateTransferStatusStmt = db.prepare(`
            UPDATE transfer_records
            SET status = ?,
                api_response = ?,
                error_message = ?,
                completed_at = ?
            WHERE id = ?
        `);
    }
}

// Getter 函数
const getWalletStmt = () => { initStatements(); return _getWalletStmt; };
const createWalletStmt = () => { initStatements(); return _createWalletStmt; };
const updateBalanceStmt = () => { initStatements(); return _updateBalanceStmt; };
const updateFrozenStmt = () => { initStatements(); return _updateFrozenStmt; };
const updateStatsStmt = () => { initStatements(); return _updateStatsStmt; };
const recordTransactionStmt = () => { initStatements(); return _recordTransactionStmt; };
const getTransactionsStmt = () => { initStatements(); return _getTransactionsStmt; };
const recordTransferStmt = () => { initStatements(); return _recordTransferStmt; };
const updateTransferStatusStmt = () => { initStatements(); return _updateTransferStatusStmt; };

// ========== 钱包核心功能 ==========

/**
 * 获取或创建用户钱包
 */
export function getOrCreateWallet(linuxDoId: string): UserWallet {
    let wallet = getWalletStmt().get(linuxDoId);

    if (!wallet) {
        const now = Date.now();
        const initialBalance = 250; // 新用户初始余额：250 KYX

        // 创建钱包
        createWalletStmt().run(linuxDoId, now, now);
        wallet = getWalletStmt().get(linuxDoId);

        if (!wallet) {
            throw new Error('创建钱包失败');
        }

        // 添加初始余额
        updateBalanceStmt().run(initialBalance, now, linuxDoId);

        // 更新统计
        updateStatsStmt().run(initialBalance, 0, now, linuxDoId);

        // 记录初始余额交易
        recordTransactionStmt().run(
            linuxDoId,
            'system_bonus',
            initialBalance,
            0,
            initialBalance,
            null,
            '新用户欢迎奖励',
            now
        );

        // 重新获取钱包数据
        wallet = getWalletStmt().get(linuxDoId);

        console.log(`💰 [钱包] 为用户 ${linuxDoId} 创建新钱包，初始余额: ${initialBalance} KYX`);
    }

    return wallet;
}

/**
 * 获取可用余额
 */
export function getAvailableBalance(linuxDoId: string): number {
    const wallet = getOrCreateWallet(linuxDoId);
    return wallet.kyx_balance - wallet.kyx_frozen;
}

/**
 * 增加 KYX（事务安全）
 */
export const addKYX = batchTransaction((
    linuxDoId: string,
    amount: number,
    transactionType: string,
    description?: string,
    relatedId?: number
) => {
    if (amount <= 0) {
        throw new Error('金额必须大于0');
    }

    const wallet = getOrCreateWallet(linuxDoId);
    const balanceBefore = wallet.kyx_balance;
    const balanceAfter = balanceBefore + amount;

    // 更新余额
    updateBalanceStmt().run(balanceAfter, Date.now(), linuxDoId);

    // 更新统计
    updateStatsStmt().run(amount, 0, Date.now(), linuxDoId);

    // 记录交易
    recordTransactionStmt().run(
        linuxDoId,
        transactionType,
        amount,
        balanceBefore,
        balanceAfter,
        relatedId || null,
        description || null,
        Date.now()
    );

    console.log(`💰 [钱包] ${linuxDoId} +${formatKYX(amount)} (${transactionType}) → ${formatKYX(balanceAfter)}`);

    return balanceAfter;
});

/**
 * 扣除 KYX（事务安全）
 */
export const deductKYX = batchTransaction((
    linuxDoId: string,
    amount: number,
    transactionType: string,
    description?: string,
    relatedId?: number
) => {
    if (amount <= 0) {
        throw new Error('金额必须大于0');
    }

    const wallet = getOrCreateWallet(linuxDoId);
    const available = wallet.kyx_balance - wallet.kyx_frozen;

    if (available < amount) {
        throw new Error(`余额不足: 可用 ${formatKYX(available)}, 需要 ${formatKYX(amount)}`);
    }

    const balanceBefore = wallet.kyx_balance;
    const balanceAfter = balanceBefore - amount;

    // 更新余额
    updateBalanceStmt().run(balanceAfter, Date.now(), linuxDoId);

    // 更新统计
    updateStatsStmt().run(0, amount, Date.now(), linuxDoId);

    // 记录交易
    recordTransactionStmt().run(
        linuxDoId,
        transactionType,
        -amount,
        balanceBefore,
        balanceAfter,
        relatedId || null,
        description || null,
        Date.now()
    );

    console.log(`💰 [钱包] ${linuxDoId} -${formatKYX(amount)} (${transactionType}) → ${formatKYX(balanceAfter)}`);

    return balanceAfter;
});

/**
 * 冻结 KYX
 */
export function freezeKYX(linuxDoId: string, amount: number): void {
    if (amount <= 0) {
        throw new Error('冻结金额必须大于0');
    }

    const wallet = getOrCreateWallet(linuxDoId);
    const available = wallet.kyx_balance - wallet.kyx_frozen;

    if (available < amount) {
        throw new Error(`可用余额不足: ${formatKYX(available)}`);
    }

    const newFrozen = wallet.kyx_frozen + amount;
    updateFrozenStmt().run(newFrozen, Date.now(), linuxDoId);

    console.log(`🔒 [钱包] ${linuxDoId} 冻结 ${formatKYX(amount)} → 总冻结: ${formatKYX(newFrozen)}`);
}

/**
 * 解冻 KYX
 */
export function unfreezeKYX(linuxDoId: string, amount: number): void {
    if (amount <= 0) {
        throw new Error('解冻金额必须大于0');
    }

    const wallet = getOrCreateWallet(linuxDoId);

    if (wallet.kyx_frozen < amount) {
        throw new Error(`冻结余额不足: ${formatKYX(wallet.kyx_frozen)}`);
    }

    const newFrozen = wallet.kyx_frozen - amount;
    updateFrozenStmt().run(newFrozen, Date.now(), linuxDoId);

    console.log(`🔓 [钱包] ${linuxDoId} 解冻 ${formatKYX(amount)} → 剩余冻结: ${formatKYX(newFrozen)}`);
}

/**
 * 获取交易记录
 */
export function getTransactions(linuxDoId: string, page: number = 1, pageSize: number = 20): KYXTransaction[] {
    const offset = (page - 1) * pageSize;
    return getTransactionsStmt().all(linuxDoId, pageSize, offset);
}

/**
 * 初始化用户钱包（首次绑定时调用）
 * 将绑定奖励转为 KYX
 */
export function initializeUserWallet(linuxDoId: string, bindingBonusQuota: number): void {
    const bonusKYX = quotaToKYX(bindingBonusQuota);

    addKYX(
        linuxDoId,
        bonusKYX,
        'binding_bonus',
        `首次绑定奖励: ${formatUSD(bindingBonusQuota / CURRENCY.QUOTA_PER_USD)}`
    );

    console.log(`🎁 [钱包] ${linuxDoId} 初始化钱包，绑定奖励: ${formatKYX(bonusKYX)}`);
}

// ========== 导出 ==========

export const walletService = {
    getOrCreateWallet,
    getAvailableBalance,
    addKYX,
    deductKYX,
    freezeKYX,
    unfreezeKYX,
    getTransactions,
    initializeUserWallet,
};
