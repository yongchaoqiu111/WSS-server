const { tronAddressesEqual } = require('./tron-address');

function parseTronTransfer(tx) {
  const contract = tx.raw_data?.contract?.[0];
  if (!contract || contract.type !== 'TransferContract') return null;
  const value = contract.parameter?.value;
  if (!value || value.amount == null) return null;
  return {
    txId: tx.txID,
    amountSun: Number(value.amount),
    timestampMs: Number(tx.raw_data?.timestamp || tx.block_timestamp || 0),
    fromHex: value.owner_address,
    toHex: value.to_address,
  };
}

function paymentWantSun(payment) {
  if (payment.payAmountSun != null) return Number(payment.payAmountSun);
  return Math.round(Number(payment.payAmount) * 1e6);
}

function paymentTreasury(payment) {
  return payment.treasury || payment.payeeAddress;
}

function txMatchesPayment(payment, tx, wantSun, notBefore) {
  if (tx.timestampMs < notBefore) return false;
  if (tx.amountSun !== wantSun) return false;

  const treasury = paymentTreasury(payment);
  if (treasury && !tronAddressesEqual(tx.toHex, treasury)) return false;

  // 本机购：付款方 + 收款方 + 到账金额（整数 TRX，不靠随机尾数）
  if (payment.payMode === 'self' || payment.matchMode === 'payer_and_amount') {
    const payer = payment.expectedPayer;
    if (!payer) return false;
    return tronAddressesEqual(tx.fromHex, payer);
  }

  // 朋友代付：唯一金额 + 收款地址（付款方可任意）
  return true;
}

/**
 * @returns {Array<{ payment, txId, fromHex }>}
 */
function matchPaymentsToTransactions(payments, txs) {
  const parsed = (txs || []).map(parseTronTransfer).filter(Boolean);
  const usedTxIds = new Set();
  const sorted = [...payments].sort(
    (a, b) => (a.createdAt || a.matchedAt || 0) - (b.createdAt || b.matchedAt || 0)
  );
  const matched = [];

  for (const payment of sorted) {
    const wantSun = paymentWantSun(payment);
    const notBefore = (payment.matchedAt || payment.createdAt || 0) - 60_000;

    const hit = parsed.find(
      (t) => !usedTxIds.has(t.txId) && txMatchesPayment(payment, t, wantSun, notBefore)
    );

    if (hit) {
      usedTxIds.add(hit.txId);
      matched.push({ payment, txId: hit.txId, fromHex: hit.fromHex });
    }
  }

  return matched;
}

module.exports = {
  parseTronTransfer,
  paymentWantSun,
  paymentTreasury,
  txMatchesPayment,
  matchPaymentsToTransactions,
};
