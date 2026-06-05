const crypto = require('crypto');

function leafHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function buildMerkleRoot(records) {
  if (!records.length) return null;
  let layer = records.map(leafHash);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] || left;
      next.push(
        crypto
          .createHash('sha256')
          .update(left + right)
          .digest('hex')
      );
    }
    layer = next;
  }
  return `0x${layer[0]}`;
}

module.exports = { leafHash, buildMerkleRoot };
