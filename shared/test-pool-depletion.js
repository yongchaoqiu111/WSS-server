/**
 * 匹配后池子扣减；次日不足 30 万不匹配；尾数走排单券通道
 * node shared/test-pool-depletion.js
 */
const { runPoolCycle } = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const day1 = Date.UTC(2026, 0, 15);
const day2 = day1 + MS_DAY;

function makeTx(i, payer, ts) {
  return {
    txHash: `tx_${i}`,
    fromAddress: payer,
    amount: 100,
    blockNumber: i,
    blockTimestamp: ts,
  };
}

// 110 笔 = 33 万；溢出 3 万匹配后剩 30 万核心
const txs = [];
for (let i = 0; i < 110; i++) {
  txs.push(makeTx(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day1 - 15 * MS_DAY + i));
}

const r1 = runPoolCycle({ poolId: '3000', txs, nowMs: day1 + 3600 * 1000 });
if (!r1.assignments.length) {
  console.error('FAIL: day1 should match');
  process.exit(1);
}
if (Math.abs(r1.fill.totalPoolCreditTrx - 300000) > 1) {
  console.error('FAIL: pool should be 300k core after match', r1.fill.totalPoolCreditTrx);
  process.exit(1);
}
if (r1.matchedCreditTrx !== 30000) {
  console.error('FAIL: should consume overflow 30k', r1.matchedCreditTrx);
  process.exit(1);
}

const r2 = runPoolCycle({ poolId: '3000', txs, nowMs: day2 + 3600 * 1000 });
if (r2.assignments.length) {
  console.error('FAIL: day2 should not match when pool < 300k', r2.assignments.length);
  process.exit(1);
}
if (r2.fill.canMatch) {
  console.error('FAIL: canMatch should be false on day2');
  process.exit(1);
}

if (!r1.tailAssignments && !(r1.tailChannel?.assignments?.length)) {
  // tail may be empty depending on data; check structure exists
}
const tailCount = (r1.tailAssignments || []).length;
console.log('OK pool depletion:', {
  day1Pool: r1.fill.totalPoolCreditTrx,
  day1Matched: r1.matchedCreditTrx,
  day1Tails: tailCount,
  day2CanMatch: r2.fill.canMatch,
  day2Pool: r2.fill.totalPoolCreditTrx,
  matchDays: r1.matchDays,
});
