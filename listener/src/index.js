/**
 * 链上监听服务（无密钥）
 * - 拉取 waiting_payment 订单
 * - DEMO_AUTO_CONFIRM=1 时自动向 Leader 提交 CONFIRM_PAYMENT（开发联调）
 * - 生产：接 TronGrid 入账比对 treasury + payAmount（需 TRONGRID_API_KEY）
 */
const RAFT_LEADER = process.env.RAFT_LEADER_API || 'http://127.0.0.1:3001';
const POLL_MS = Number(process.env.POLL_MS || 15000);
const DEMO_AUTO_CONFIRM = process.env.DEMO_AUTO_CONFIRM === '1';
const TRONGRID = process.env.TRONGRID_API || 'https://api.trongrid.io';

async function fetchPending() {
  const res = await fetch(`${RAFT_LEADER}/api/payments/pending`);
  if (!res.ok) throw new Error(`pending API ${res.status}`);
  return res.json();
}

async function submitConfirm(orderId, userAddress) {
  const res = await fetch(`${RAFT_LEADER}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'CONFIRM_PAYMENT',
      userAddress,
      orderId,
      txHash: `listener_auto_${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `confirm failed ${res.status}`);
  }
  return res.json();
}

async function pollTronIncoming(treasury, payments) {
  if (!treasury || treasury.includes('PLACEHOLDER')) return [];
  const matched = [];
  try {
    const res = await fetch(
      `${TRONGRID}/v1/accounts/${treasury}/transactions?only_to=true&limit=20`,
      { headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {} }
    );
    if (!res.ok) return matched;
    const body = await res.json();
    const txs = body.data || [];
    for (const p of payments) {
      const wantSun = Math.round(Number(p.payAmount) * 1e6);
      const hit = txs.find((tx) => {
        const amount = tx.raw_data?.contract?.[0]?.parameter?.value?.amount;
        return amount === wantSun;
      });
      if (hit) matched.push({ payment: p, txId: hit.txID });
    }
  } catch (e) {
    console.warn('[listener] TronGrid:', e.message);
  }
  return matched;
}

async function pollPendingPayments() {
  const { treasury, payments } = await fetchPending();
  if (!payments.length) return;

  if (DEMO_AUTO_CONFIRM) {
    for (const p of payments) {
      try {
        await submitConfirm(p.orderId, p.userAddress);
        console.log(`[listener] 自动确认订单 ${p.orderId}`);
      } catch (e) {
        console.warn(`[listener] 确认失败 ${p.orderId}:`, e.message);
      }
    }
    return;
  }

  const matched = await pollTronIncoming(treasury, payments);
  for (const { payment, txId } of matched) {
    try {
      await fetch(`${RAFT_LEADER}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CONFIRM_PAYMENT',
          userAddress: payment.userAddress,
          orderId: payment.orderId,
          txHash: txId,
        }),
      });
      console.log(`[listener] 链上匹配确认 ${payment.orderId} tx=${txId}`);
    } catch (e) {
      console.warn('[listener] 链上确认失败:', e.message);
    }
  }
}

console.log('[listener] 已启动', { leader: RAFT_LEADER, demoAuto: DEMO_AUTO_CONFIRM });
setInterval(() => {
  pollPendingPayments().catch((e) => console.error('[listener]', e.message));
}, POLL_MS);
