import { db, adminQueries } from '../database';

export function getWalletBalance(linuxDoId: string): number {
  const row = db.query('SELECT balance_quota FROM user_wallets WHERE linux_do_id = ?').get(linuxDoId) as any;
  if (row) return row.balance_quota as number;
  // 初始化为 🥚250
  const cfg = adminQueries.get.get();
  const rate = (cfg?.wallet_exchange_rate as number) || 500000;
  const initialEggs = (cfg?.wallet_initial_egg as number) || 250;
  const initialQuota = initialEggs * rate;
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO user_wallets (linux_do_id, balance_quota, updated_at) VALUES (?, ?, ?)')
    .run(linuxDoId, initialQuota, now);
  return initialQuota;
}

function ensureWallet(linuxDoId: string) {
  const now = Date.now();
  const cfg = adminQueries.get.get();
  const rate = (cfg?.wallet_exchange_rate as number) || 500000;
  const initialEggs = (cfg?.wallet_initial_egg as number) || 250;
  const initialQuota = initialEggs * rate;
  db.query('INSERT OR IGNORE INTO user_wallets (linux_do_id, balance_quota, updated_at) VALUES (?, ?, ?)')
    .run(linuxDoId, initialQuota, now);
}

export function tryDeductWallet(linuxDoId: string, amountQuota: number): { success: boolean; newBalance: number } {
  if (amountQuota <= 0) return { success: true, newBalance: getWalletBalance(linuxDoId) };
  try {
    db.exec('BEGIN IMMEDIATE');
    ensureWallet(linuxDoId);
    const now = Date.now();
    const stmt = db.query('UPDATE user_wallets SET balance_quota = balance_quota - ?, updated_at = ? WHERE linux_do_id = ? AND balance_quota >= ?');
    const res = stmt.run(amountQuota, now, linuxDoId, amountQuota) as any;
    if ((res?.changes || 0) === 0) {
      db.exec('ROLLBACK');
      const bal = getWalletBalance(linuxDoId);
      return { success: false, newBalance: bal };
    }
    db.exec('COMMIT');
    const bal = getWalletBalance(linuxDoId);
    return { success: true, newBalance: bal };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    const bal = getWalletBalance(linuxDoId);
    return { success: false, newBalance: bal };
  }
}

export function addWallet(linuxDoId: string, amountQuota: number): { success: boolean; newBalance: number } {
  if (amountQuota <= 0) return { success: true, newBalance: getWalletBalance(linuxDoId) };
  try {
    db.exec('BEGIN IMMEDIATE');
    ensureWallet(linuxDoId);
    const now = Date.now();
    db.query('UPDATE user_wallets SET balance_quota = balance_quota + ?, updated_at = ? WHERE linux_do_id = ?')
      .run(amountQuota, now, linuxDoId);
    db.exec('COMMIT');
    const bal = getWalletBalance(linuxDoId);
    return { success: true, newBalance: bal };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    const bal = getWalletBalance(linuxDoId);
    return { success: false, newBalance: bal };
  }
}

export function deductUpTo(linuxDoId: string, amountQuota: number): { success: boolean; actualDeducted: number; newBalance: number } {
  try {
    db.exec('BEGIN IMMEDIATE');
    ensureWallet(linuxDoId);
    const current = getWalletBalance(linuxDoId);
    const actual = Math.max(0, Math.min(current, Math.max(0, amountQuota)));
    const now = Date.now();
    db.query('UPDATE user_wallets SET balance_quota = balance_quota - ?, updated_at = ? WHERE linux_do_id = ?')
      .run(actual, now, linuxDoId);
    db.exec('COMMIT');
    const bal = getWalletBalance(linuxDoId);
    return { success: true, actualDeducted: actual, newBalance: bal };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    const bal = getWalletBalance(linuxDoId);
    return { success: false, actualDeducted: 0, newBalance: bal };
  }
}
