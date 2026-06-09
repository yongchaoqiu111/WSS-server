/**
 * 溢出 3 万：7 人满 3900 + 第 8 人收零头 2700（剩 1200 明天继续），不打排单券
 * node shared/test-surplus-ticket.js
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

if (r.ticketSurplusAssignments.length) {
  console.error('FAIL: 2700 should go to 8th receiver not ticket', r.ticketSurplusAssignments);
  process.exit(1);
}
if (r.receiverCount !== 8) {
  console.error('FAIL: expect 8 receivers (7 full + 1 partial)', r.receiverCount);
  process.exit(1);
}
if (r.remainderToReceiverTrx !== 2700) {
  console.error('FAIL: remainder to receiver', r.remainderToReceiverTrx);
  process.exit(1);
}

const user8 = r.assignments.filter((a) => a.beneficiary === 'TUser008');
const sum8 = user8.reduce((s, a) => s + a.amountTrx, 0);
if (Math.abs(sum8 - 2700) > 0.01) {
  console.error('FAIL: TUser008 should receive 2700 today', sum8);
  process.exit(1);
}

const e8 = r.entries.find((e) => e.payer === 'TUser008');
if (!e8 || e8.status !== 'exit_partial' || Math.abs((e8.exitRemainderTrx || 0) - 1200) > 0.01) {
  console.error('FAIL: TUser008 should be exit_partial with 1200 left', e8);
  process.exit(1);
}

console.log('OK remainder to receiver:', {
  receivers: r.receiverCount,
  user8Paid: sum8,
  user8Left: e8.exitRemainderTrx,
});
