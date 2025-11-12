import { Hono } from 'hono';
import { db, adminQueries } from '../database';
import { getWalletBalance } from '../services/wallet';
import { getCookie, getSession } from '../utils';
import { getKyxUserById, updateKyxUserQuota } from '../services/kyx-api';

const app = new Hono();

async function requireAuth(c: any, next: any) {
  const sessionId = getCookie(c.req.raw.headers, 'session_id');
  if (!sessionId) {
    return c.json({ success: false, message: '未登录' }, 401);
  }
  const session = await getSession(sessionId);
  if (!session || !session.linux_do_id) {
    return c.json({ success: false, message: '会话无效' }, 401);
  }
  c.set('session', session);
  await next();
}

function getTodayDate(): string {
  const beijing = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
  });
  const [datePart] = beijing.split(' ');
  const [y, m, d] = datePart.split('/');
  return `${y}-${m}-${d}`;
}

// 获取钱包余额（本地+上游）
app.get('/balance', requireAuth, async (c) => {
  const session = c.get('session');
  const linuxDoId = session.linux_do_id as string;

  // 管理员配置（汇率与每日限次）
  const admin = adminQueries.get.get();
  const rate = (admin?.wallet_exchange_rate as number) || 500000; // quota per 🥚
  const limitCount = (admin?.wallet_daily_transfer_limit_count as number) || 2;

  // 本地钱包
  const walletQuota = getWalletBalance(linuxDoId);

  // 今日划转次数
  const today = getTodayDate();
  const countRow = db.query('SELECT COUNT(*) as cnt FROM wallet_transfer_records WHERE linux_do_id = ? AND date = ?')
    .get(linuxDoId, today) as any;
  const todayCount = countRow ? (countRow.cnt as number) : 0;

  // 上游余额
  const kyxUser = db.query('SELECT kyx_user_id, username FROM users WHERE linux_do_id = ?').get(linuxDoId) as any;
  let upstreamQuota = 0;
  if (kyxUser) {
    const adminConfig = adminQueries.get.get();
    if (adminConfig) {
      const r = await getKyxUserById(kyxUser.kyx_user_id, adminConfig.session, adminConfig.new_api_user);
      if (r.success && r.user) upstreamQuota = r.user.quota || 0;
    }
  }

  return c.json({
    success: true,
    data: {
      rate, // quota per 🥚
      limit_count: limitCount,
      today_count: todayCount,
      remaining_count: Math.max(0, limitCount - todayCount),
      wallet_quota: walletQuota,
      upstream_quota: upstreamQuota,
    }
  });
});

// 划转：direction: 'in' (上游→本地) | 'out' (本地→上游); amount_egg: number
app.post('/transfer', requireAuth, async (c) => {
  const session = c.get('session');
  const linuxDoId = session.linux_do_id as string;
  const body = await c.req.json();
  const direction = (body?.direction || '').toString();
  const amountEgg = parseFloat(body?.amount_egg);

  if (!['in', 'out'].includes(direction)) {
    return c.json({ success: false, message: '非法的方向参数' }, 400);
  }
  if (!Number.isFinite(amountEgg) || amountEgg <= 0) {
    return c.json({ success: false, message: '金额必须为正数' }, 400);
  }

  const admin = adminQueries.get.get();
  if (!admin) return c.json({ success: false, message: '系统配置未找到' }, 500);
  const rate = (admin.wallet_exchange_rate as number) || 500000;
  const limitCount = (admin.wallet_daily_transfer_limit_count as number) || 2;

  const amountQuota = Math.floor(amountEgg * rate);
  if (amountQuota <= 0) return c.json({ success: false, message: '金额过小' }, 400);

  // 限次校验
  const today = getTodayDate();
  const cntRow = db.query('SELECT COUNT(*) as cnt FROM wallet_transfer_records WHERE linux_do_id = ? AND date = ?')
    .get(linuxDoId, today) as any;
  const todayCount = cntRow ? (cntRow.cnt as number) : 0;
  if (todayCount >= limitCount) {
    return c.json({ success: false, message: '今日划转次数已达上限' }, 400);
  }

  // 钱包余额
  const walletRow = db.query('SELECT balance_quota FROM user_wallets WHERE linux_do_id = ?').get(linuxDoId) as any;
  const walletQuota = walletRow ? walletRow.balance_quota as number : 0;

  // 上游用户
  const userRow = db.query('SELECT kyx_user_id, username FROM users WHERE linux_do_id = ?').get(linuxDoId) as any;
  if (!userRow) return c.json({ success: false, message: '用户未绑定' }, 400);

  const kyxUserId = userRow.kyx_user_id as number;
  const adminSession = admin.session as string;
  const newApiUser = admin.new_api_user as string;

  // 拉取上游当前余额
  let upstreamQuota = 0;
  const r = await getKyxUserById(kyxUserId, adminSession, newApiUser);
  if (!r.success || !r.user) return c.json({ success: false, message: '获取上游余额失败' }, 500);
  upstreamQuota = r.user.quota || 0;

  if (direction === 'in') {
    if (upstreamQuota < amountQuota) {
      return c.json({ success: false, message: '上游余额不足' }, 400);
    }
    // 更新上游余额：扣减
    const newUp = upstreamQuota - amountQuota;
    const upRes = await updateKyxUserQuota(kyxUserId, newUp, adminSession, newApiUser, r.user.username, r.user.group || 'default');
    if (!upRes || !upRes.success) return c.json({ success: false, message: '上游扣款失败' }, 500);
    // 本地钱包增加
    const now = Date.now();
    db.query('INSERT INTO user_wallets (linux_do_id, balance_quota, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(linux_do_id) DO UPDATE SET balance_quota = balance_quota + ?, updated_at = ?')
      .run(linuxDoId, amountQuota, now, now, amountQuota, now);
    // 记录
    db.query('INSERT INTO wallet_transfer_records (linux_do_id, direction, amount_quota, timestamp, date) VALUES (?, ?, ?, ?, ?)')
      .run(linuxDoId, 'in', amountQuota, now, today);

    const newWallet = (walletQuota + amountQuota);
    return c.json({ success: true, message: '划转成功', data: { upstream_quota: newUp, wallet_quota: newWallet } });
  } else {
    // out: 本地->上游
    if (walletQuota < amountQuota) {
      return c.json({ success: false, message: '本地钱包余额不足' }, 400);
    }
    const newUp = upstreamQuota + amountQuota;
    const upRes = await updateKyxUserQuota(kyxUserId, newUp, adminSession, newApiUser, r.user.username, r.user.group || 'default');
    if (!upRes || !upRes.success) return c.json({ success: false, message: '上游加款失败' }, 500);

    const now = Date.now();
    db.query('UPDATE user_wallets SET balance_quota = balance_quota - ?, updated_at = ? WHERE linux_do_id = ?')
      .run(amountQuota, now, linuxDoId);
    db.query('INSERT INTO wallet_transfer_records (linux_do_id, direction, amount_quota, timestamp, date) VALUES (?, ?, ?, ?, ?)')
      .run(linuxDoId, 'out', amountQuota, now, today);

    const newWallet = (walletQuota - amountQuota);
    return c.json({ success: true, message: '提现成功', data: { upstream_quota: newUp, wallet_quota: newWallet } });
  }
});

export default app;
