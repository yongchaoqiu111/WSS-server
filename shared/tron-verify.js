const { parseTronTransfer } = require('./payment-match');
const { tronAddressesEqual } = require('./tron-address');

async function fetchTronTransferById(txId, options = {}) {
  const trongrid = options.trongrid || process.env.TRONGRID_API || 'https://api.trongrid.io';
  const headers = options.apiKey || process.env.TRONGRID_API_KEY
    ? { 'TRON-PRO-API-KEY': options.apiKey || process.env.TRONGRID_API_KEY }
    : {};

  const res = await fetch(`${trongrid}/v1/transactions/${txId}`, { headers });
  if (!res.ok) return null;
  const body = await res.json();
  const raw = Array.isArray(body.data) ? body.data[0] : body;
  if (!raw) return null;
  return parseTronTransfer(raw);
}

function verifySelfTicketTransfer(purchase, tx) {
  if (!tx) return { ok: false, error: '链上交易未找到' };
  if (!tronAddressesEqual(tx.fromHex, purchase.expectedPayer)) {
    return { ok: false, error: '付款地址与当前钱包不一致' };
  }
  if (!tronAddressesEqual(tx.toHex, purchase.treasury)) {
    return { ok: false, error: '收款地址不匹配' };
  }
  const wantSun = purchase.payAmountSun != null
    ? Number(purchase.payAmountSun)
    : Math.round(Number(purchase.payAmount) * 1e6);
  if (tx.amountSun !== wantSun) {
    return { ok: false, error: '到账金额与订单不一致' };
  }
  const notBefore = (purchase.createdAt || 0) - 60_000;
  if (tx.timestampMs < notBefore) {
    return { ok: false, error: '交易时间早于建单时间' };
  }
  return { ok: true, tx };
}

module.exports = {
  fetchTronTransferById,
  verifySelfTicketTransfer,
};
