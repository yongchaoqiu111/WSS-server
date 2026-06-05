/**
 * 存证服务：仅生成 Merkle 根与待多签上链载荷，不持有私钥（设计文档 13.2.2）
 */
const cron = require('node-cron');
const { buildMerkleRoot } = require('./merkle');

const RAFT_API = process.env.RAFT_LEADER_API || 'http://127.0.0.1:3001';
const ANCHOR_OUT = process.env.ANCHOR_OUT || './pending-anchors';

async function fetchUnanchoredEvents() {
  const res = await fetch(`${RAFT_API}/api/debug`);
  if (!res.ok) throw new Error('无法连接 Raft Leader');
  const body = await res.json();
  const events = Object.entries(body.data || {})
    .filter(([k]) => k.startsWith('event:'))
    .map(([, v]) => v);
  return events;
}

async function buildAnchorPayload() {
  const records = await fetchUnanchoredEvents();
  if (!records.length) {
    console.log('[anchor] 无新事件，跳过');
    return null;
  }

  const merkleRoot = buildMerkleRoot(records);
  const payload = {
    chain: 'polygon',
    method: 'anchorData(bytes32)',
    merkleRoot,
    recordCount: records.length,
    createdAt: new Date().toISOString(),
    note: '请使用 Gnosis Safe 多签钱包签名并广播，服务器不保存私钥',
  };

  console.log('[anchor] 待多签存证载荷:');
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (process.env.ANCHOR_CRON !== '0') {
  cron.schedule('0 * * * *', () => {
    buildAnchorPayload().catch((err) => console.error('[anchor]', err.message));
  });
  console.log('[anchor] 每小时存证任务已启动（仅生成载荷）');
}

buildAnchorPayload().catch(() => {
  console.log('[anchor] 首次拉取失败，请确认 node1 已启动');
});
