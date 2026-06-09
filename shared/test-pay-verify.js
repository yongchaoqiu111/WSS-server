/**
 * 主网打到出场池 → 验款进收款池
 */
const { runPoolCycle } = require('./pool-rules');
const { exitPoolAddressFor, POOL_PURCHASE_CONFIG } = require('./pool-config');

const MS_DAY = 24 * 3600 * 1000;
const day1 = Date.UTC(2026, 0, 15);
const cfg = POOL_PURCHASE_CONFIG.find((p) => p.id === '3000');
const exitAddr = exitPoolAddressFor(cfg);

function buy(i, payer, ts) {
  return { txHash: `tx_${i}`, fromAddress: payer, amount: 100, blockNumber: i, blockTimestamp: ts };
}

const purchaseTxs = [];
for (let i = 0; i < 110; i++) {
  purchaseTxs.push(buy(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day1 - 15 * MS_DAY + i));
}

// 队尾 TUser101～110 各应付 3000；模拟 TUser110 付清
const exitPoolTxs = [
  {
    txHash: 'exit_110',
    fromAddress: 'TUser110',
    toAddress: exitAddr, // TRjvctzrc5WcEeu2UrT8mV5H6zW8dCgimR
    amount: 3000,
    blockTimestamp: day1 + 2 * 3600 * 1000,
  },
];

const r = runPoolCycle({
  poolId: '3000',
  purchaseTxs,
  exitPoolTxs,
  nowMs: day1 + 12 * 3600 * 1000,
});

const e110 = r.entries.find((e) => e.payer === 'TUser110');
if (!e110 || e110.status !== 'recv_queued') {
  console.error('FAIL TUser110 should be recv_queued', e110?.status);
  process.exit(1);
}
if (!e110.recvQueueJoinedAt) {
  console.error('FAIL missing recvQueueJoinedAt');
  process.exit(1);
}

console.log('OK pay verify:', {
  user: e110.payer,
  status: e110.status,
  joinedAt: e110.recvQueueJoinedAt,
  tx: e110.verifiedMainnetTxId,
});
