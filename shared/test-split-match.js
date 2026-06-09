/**
 * 拆分机器人用例：3900 = 3000 + 900；3000 拆成 2100 + 900
 * node shared/test-split-match.js
 */
const {
  buildEntries,
  applyLifecycle,
  poolFillState,
  buildSplitMatches,
} = require('./pool-rules');

const MS_DAY = 24 * 3600 * 1000;
const nowMs = Date.now();

function makeTx(i, payer) {
  return {
    txHash: `tx_${i}`,
    fromAddress: payer,
    amount: 100,
    blockNumber: i,
    blockTimestamp: nowMs - 20 * MS_DAY,
  };
}

// 102 笔：前 76 收款，后 26 付款方（足够演示拆分）
const txs = [];
for (let i = 0; i < 102; i++) {
  txs.push(makeTx(i + 1, `TUser${String(i + 1).padStart(3, '0')}`));
}

const entries = applyLifecycle(buildEntries('3000', txs));
const fill = poolFillState('3000', entries, nowMs);
console.log('fill:', {
  totalPoolCreditTrx: fill.totalPoolCreditTrx,
  isFull: fill.isFull,
  canMatch: fill.canMatch,
});

const split = buildSplitMatches('3000', entries, [], { nowMs });
console.log('assignments:', split.assignments.length);
console.log('collectorMode:', split.collectorMode);

// 找第一个收款方 TUser001 的入账
const recv1 = split.assignments.filter((a) => a.beneficiary === 'TUser001');
const recv1Sum = recv1.reduce((s, a) => s + a.amountTrx, 0);
console.log('TUser001 receives:', recv1.map((a) => ({ payer: a.payer, amount: a.amountTrx })));
console.log('TUser001 total:', recv1Sum, '(expect 3900)');

// 找某付款方是否出现 3000+900 拆分
const payer77 = split.assignments.filter((a) => a.payer === 'TUser077');
console.log('TUser077 splits:', payer77.map((a) => ({ to: a.beneficiary, amount: a.amountTrx })));

const over3 = split.payers.filter((p) => p.splitCount > 3);
if (over3.length) {
  console.error('FAIL: split count > 3', over3);
  process.exit(1);
}
if (Math.abs(recv1Sum - 3900) > 0.01) {
  console.error('FAIL: first receiver not fully funded', recv1Sum);
  process.exit(1);
}
console.log('OK');
