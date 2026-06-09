/**
 * 每日只匹配一次：同日多次验算结果一致；checkpoint 前新单不进当日快照
 * node shared/test-daily-match.js
 */
const { runPoolCycle } = require('./pool-rules');
const { checkpointCutoffMs, dailyMatchContext } = require('./pool-config');

const MS_DAY = 24 * 3600 * 1000;
const baseDay = Date.UTC(2026, 0, 15); // 2026-01-15 UTC 0:00

function makeTx(i, payer, ts) {
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
  txs.push(makeTx(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, baseDay - 15 * MS_DAY + i * 1000));
}

const noon = baseDay + 12 * 3600 * 1000;
const evening = baseDay + 20 * 3600 * 1000;

const r1 = runPoolCycle({ poolId: '3000', txs, nowMs: noon });
const r2 = runPoolCycle({ poolId: '3000', txs, nowMs: evening });

if (r1.assignments.length !== r2.assignments.length) {
  console.error('FAIL: assignments changed within same day');
  process.exit(1);
}
for (let i = 0; i < r1.assignments.length; i++) {
  const a = r1.assignments[i];
  const b = r2.assignments[i];
  if (a.assignmentId !== b.assignmentId || a.amountTrx !== b.amountTrx) {
    console.error('FAIL: assignment drift', a, b);
    process.exit(1);
  }
}

const ctx = dailyMatchContext(noon);
if (ctx.matchesPerDay !== 1) {
  console.error('FAIL: matchesPerDay');
  process.exit(1);
}

// 当日 checkpoint 之后的新单不进快照
const txsLate = [
  ...txs,
  makeTx(999, 'TLateUser', baseDay + 3600 * 1000),
];
const rLate = runPoolCycle({ poolId: '3000', txs: txsLate, nowMs: evening });
if (rLate.entries.some((e) => e.payer === 'TLateUser')) {
  console.error('FAIL: post-checkpoint tx included same day');
  process.exit(1);
}

// 次日 checkpoint 后新单进入新快照
const nextDay = baseDay + MS_DAY + 3600 * 1000;
const rNext = runPoolCycle({ poolId: '3000', txs: txsLate, nowMs: nextDay });
if (!rNext.entries.some((e) => e.payer === 'TLateUser')) {
  console.error('FAIL: tx should appear next match day');
  process.exit(1);
}
if (rNext.matchDayId !== '2026-01-16') {
  console.error('FAIL: matchDayId', rNext.matchDayId);
  process.exit(1);
}

console.log('OK daily match:', {
  matchDayId: r1.matchDayId,
  assignments: r1.assignments.length,
  cutoff: checkpointCutoffMs(noon),
  nextMatch: new Date(r1.nextMatchAtMs).toISOString(),
});
