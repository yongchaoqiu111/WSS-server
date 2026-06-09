/**
 * 第 8 人零头 2700 剩 1200；次日有溢出时优先凑满
 * node shared/test-partial-carryover.js
 */
const { runPoolCycle } = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const day1 = Date.UTC(2026, 0, 15);
const day2 = day1 + MS_DAY;

function tx(i, payer, ts) {
  return {
    txHash: `tx_${i}`,
    fromAddress: payer,
    amount: 100,
    blockNumber: i,
    blockTimestamp: ts,
  };
}

const txs = [];
for (let i = 0; i < 110; i++) {
  txs.push(tx(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day1 - 15 * MS_DAY + i));
}

const r1 = runPoolCycle({ poolId: '3000', txs, nowMs: day1 + 3600 * 1000 });
const e8d1 = r1.entries.find((e) => e.payer === 'TUser008');
if (!e8d1 || e8d1.status !== 'exit_partial' || Math.abs(e8d1.exitRemainderTrx - 1200) > 0.01) {
  console.error('FAIL day1 partial', e8d1);
  process.exit(1);
}

// 次日再加 1 笔买券 → 33.3 万，溢出 3.3 万
txs.push(tx(111, 'TUser111', day2 - 3600 * 1000));
const r2 = runPoolCycle({ poolId: '3000', txs, nowMs: day2 + 3600 * 1000 });
const e8d2 = r2.entries.find((e) => e.payer === 'TUser008');
const paidTo8 = r2.assignments
  .filter((a) => a.beneficiary === 'TUser008')
  .reduce((s, a) => s + a.amountTrx, 0);

if (paidTo8 < 1199) {
  console.error('FAIL day2 should pay toward TUser008', paidTo8);
  process.exit(1);
}

console.log('OK carryover:', { day1Left: e8d1.exitRemainderTrx, day2Paid: paidTo8, day2Status: e8d2?.status });
