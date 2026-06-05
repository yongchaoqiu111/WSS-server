/**
 * 链上监听服务（无密钥）
 * - 拉取 waiting_payment 订单 + pending 购票单
 * - 金额全库唯一 + 一笔 tx 只确认一笔单（不校验付款方，支持另一台手机代付）
 */
const { matchPaymentsToTransactions } = require('@mmm/shared');

const RAFT_LEADER = process.env.RAFT_LEADER_API || 'http://127.0.0.1:3001';
const POLL_MS = Number(process.env.POLL_MS || 15000);
const DEMO_AUTO_CONFIRM = process.env.DEMO_AUTO_CONFIRM === '1';
const TRONGRID = process.env.TRONGRID_API || 'https://api.trongrid.io';

async function fetchPending() {
  const res = await fetch(`${RAFT_LEADER}/api/payments/pending`);
  if (!res.ok) throw new Error(`pending API ${res.status}`);
  return res.json();
}

async function submitConfirm(orderId, userAddress, txHash, payerFrom) {
  const res = await fetch(`${RAFT_LEADER}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'CONFIRM_PAYMENT',
      userAddress,
      orderId,
      txHash,
      payerFrom,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `confirm failed ${res.status}`);
  }
  return res.json();
}

async function submitConfirmTicket(purchase, txHash, payerFrom) {
  const res = await fetch(`${RAFT_LEADER}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'CONFIRM_TICKET_PAYMENT',
      userAddress: purchase.userAddress,
      purchaseId: purchase.purchaseId,
      amount: purchase.amount,
      payAmount: purchase.payAmount,
      txHash,
      payerFrom,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `ticket confirm failed ${res.status}`);
  }
  return res.json();
}

async function pollTronIncoming(treasury, payments) {
  if (!treasury || treasury.includes('PLACEHOLDER')) return [];
  try {
    const res = await fetch(
      `${TRONGRID}/v1/accounts/${treasury}/transactions?only_to=true&limit=50`,
      { headers: process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {} }
    );
    if (!res.ok) return [];
    const body = await res.json();
    return matchPaymentsToTransactions(payments, body.data || []);
  } catch (e) {
    console.warn('[listener] TronGrid:', e.message);
    return [];
  }
}

async function pollPendingPayments() {
  const { treasury, payments } = await fetchPending();
  if (!payments.length) return;

  if (DEMO_AUTO_CONFIRM) {
    for (const p of payments) {
      try {
        const txHash = `listener_auto_${Date.now()}_${p.purchaseId || p.orderId}`;
        if (p.type === 'ticket' || p.purchaseId) {
          await submitConfirmTicket(p, txHash, null);
          console.log(`[listener] 自动确认购票 ${p.purchaseId}`);
        } else {
          await submitConfirm(p.orderId, p.userAddress, txHash, null);
          console.log(`[listener] 自动确认订单 ${p.orderId}`);
        }
      } catch (e) {
        const id = p.purchaseId || p.orderId;
        console.warn(`[listener] 确认失败 ${id}:`, e.message);
      }
    }
    return;
  }

  const matched = await pollTronIncoming(treasury, payments);
  for (const { payment, txId, fromHex } of matched) {
    try {
      if (payment.type === 'ticket' || payment.purchaseId) {
        await submitConfirmTicket(payment, txId, fromHex || null);
        console.log(`[listener] 链上匹配购票 ${payment.purchaseId} tx=${txId}`);
      } else {
        await submitConfirm(payment.orderId, payment.userAddress, txId, fromHex || null);
        console.log(`[listener] 链上匹配订单 ${payment.orderId} tx=${txId}`);
      }
    } catch (e) {
      console.warn('[listener] 链上确认失败:', e.message);
    }
  }
}

console.log('[listener] 已启动', { leader: RAFT_LEADER, demoAuto: DEMO_AUTO_CONFIRM, pollMs: POLL_MS });
setInterval(() => {
  pollPendingPayments().catch((e) => console.error('[listener]', e.message));
}, POLL_MS);
