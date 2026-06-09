/**
 * 33 万池：预留 30 万核心，溢出 3 万 → 7 人收 3900，零头打排单券
 * node shared/test-overflow-match.js
 */
const { runPoolCycle } = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const day = Date.UTC(2026, 0, 15);

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
  txs.push(tx(i + 1, `TUser${String(i + 1).padStart(3, '0')}`, day - 15 * MS_DAY + i));
}

const r = runPoolCycle({ poolId: '3000', txs, nowMs: day + 3600 * 1000 });

if (r.overflowPoolCreditTrx !== 30000) {
  console.error('FAIL: overflow', r.overflowPoolCreditTrx);
  process.exit(1);
}
if (r.receiverCount !== 8) {
  console.error('FAIL: receiverCount 7 full + 1 partial', r.receiverCount);
  process.exit(1);
}
if (r.remainderToReceiverTrx !== 2700) {
  console.error('FAIL: remainder should go to 8th receiver', r.remainderToReceiverTrx);
  process.exit(1);
}
if (r.ticketRemainderTrx > 0.01) {
  console.error('FAIL: ticket remainder should be 0', r.ticketRemainderTrx);
  process.exit(1);
}
if (r.matchedCreditTrx !== 30000) {
  console.error('FAIL: matched should consume full overflow', r.matchedCreditTrx);
  process.exit(1);
}
if (r.fill.totalPoolCreditTrx !== 300000) {
  console.error('FAIL: pool after match should be 300k core', r.fill.totalPoolCreditTrx);
  process.exit(1);
}
const recv1 = r.assignments.filter((a) => a.beneficiary === 'TUser001');
const sum1 = recv1.reduce((s, a) => s + a.amountTrx, 0);
if (Math.abs(sum1 - 3900) > 0.01) {
  console.error('FAIL: TUser001 should receive 3900', sum1);
  process.exit(1);
}

console.log('OK overflow match:', {
  overflow: r.overflowPoolCreditTrx,
  receivers: r.receiverCount,
  poolAssignments: r.assignments.length,
  ticketRemainder: r.ticketRemainderTrx,
  ticketAssignments: r.ticketSurplusAssignments.length,
  poolAfter: r.fill.totalPoolCreditTrx,
});
