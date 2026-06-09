/**
 * 超时未付 → pay_expired
 */
const { runPoolCycle } = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const day1 = Date.UTC(2026, 0, 15);
const afterDeadline = day1 + MS_DAY + 3600 * 1000;

function buy(i, payer, ts) {
  return { txHash: `tx_${i}`, fromAddress: payer, amount: 100, blockNumber: i, blockTimestamp: ts };
}

const purchaseTxs = [];
for (let i = 0; i < 110; i++) {
  purchaseTxs.push(buy(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day1 - 15 * MS_DAY + i));
}

const r = runPoolCycle({ poolId: '3000', purchaseTxs, exitPoolTxs: [], nowMs: afterDeadline });
const expired = r.entries.filter((e) => e.status === 'pay_expired');
if (expired.length < 1) {
  console.error('FAIL expect pay_expired entries', expired.length);
  process.exit(1);
}

console.log('OK pay expired:', { count: expired.length, sample: expired[0]?.payer });
