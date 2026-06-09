/**
 * 冷启动：第一次匹配只有 pay_in，收款池为空无 recv_out
 */
const { runPoolCycle } = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const day1 = Date.UTC(2026, 0, 15);

function buy(i, payer, ts) {
  return { txHash: `tx_${i}`, fromAddress: payer, amount: 100, blockNumber: i, blockTimestamp: ts };
}

const txs = [];
for (let i = 0; i < 110; i++) {
  txs.push(buy(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day1 - 15 * MS_DAY + i));
}

const r = runPoolCycle({ poolId: '3000', purchaseTxs: txs, exitPoolTxs: [], nowMs: day1 + 3600 * 1000 });

if (!r.payAssignments.length) {
  console.error('FAIL expect pay_in assignments');
  process.exit(1);
}
if (r.recvAssignments.length > 0) {
  console.error('FAIL bootstrap should have no recv_out', r.recvAssignments.length);
  process.exit(1);
}
const pending = r.entries.filter((e) => e.status === 'pay_pending');
if (pending.length < 10) {
  console.error('FAIL expect pay_pending tail', pending.length);
  process.exit(1);
}

console.log('OK bootstrap:', {
  payIn: r.payAssignments.length,
  recvOut: r.recvAssignments.length,
  payPending: pending.length,
  exitPool: r.exitPoolAddress,
});
