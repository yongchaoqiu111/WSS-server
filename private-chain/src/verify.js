const crypto = require('crypto');

/**
 * 验证客户端对命令的签名（设计文档 §8.3 / 安全分析 §方案A）
 * payload = timestamp + nonce + JSON.stringify(command)
 */
function verifyCommandSignature(signed, userAddress) {
  if (!signed?.command || !signed?.signature || !signed?.timestamp || !signed?.nonce) {
    return { valid: false, error: '缺少签名字段' };
  }

  const maxSkew = 5 * 60 * 1000;
  if (Date.now() - Number(signed.timestamp) > maxSkew) {
    return { valid: false, error: '请求已过期' };
  }

  const payload = `${signed.timestamp}${signed.nonce}${JSON.stringify(signed.command)}`;
  const expected = crypto
    .createHmac('sha256', userAddress)
    .update(payload)
    .digest('hex');

  if (expected !== signed.signature) {
    return { valid: false, error: '签名无效' };
  }

  if (signed.command.userAddress && signed.command.userAddress !== userAddress) {
    return { valid: false, error: '签名地址与命令不一致' };
  }

  return { valid: true };
}

module.exports = { verifyCommandSignature };
