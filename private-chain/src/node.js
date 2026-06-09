const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const {
  QUEUE_TIERS,
  getAllTiers,
  DEFAULT_ANNOUNCEMENTS,
  PAYMENT_CONFIG,
  TIMEOUT_CONFIG,
  COMMAND_TYPES,
  POOL_PURCHASE_CONFIG,
  POOL_RULES_VERSION,
  CHECKPOINT_INTERVAL_MS,
  checkpointDayId,
  checkpointCutoffMs,
  fetchLatestTronBlock,
} = require('@mmm/shared');
const { checkSend } = require('../../shared/chat-moderation');
const { RaftNode, State } = require('./raft');
const { ReservoirStateMachine } = require('./stateMachine');
const { verifyCommandSignature } = require('./verify');

const argv = yargs(hideBin(process.argv))
  .option('port', { type: 'number', default: 3001 })
  .option('id', { type: 'string', default: 'node1' })
  .parse();

const PORT = argv.port;
const NODE_ID = argv.id;

if (NODE_ID === 'node1' && !process.env.DEMO_FAST_EXIT && process.env.NODE_ENV !== 'production') {
  process.env.DEMO_FAST_EXIT = '1';
}

const DEFAULT_PEERS = [
  { id: 'node1', host: '127.0.0.1', port: 3001 },
  { id: 'node2', host: '127.0.0.1', port: 3002 },
  { id: 'node3', host: '127.0.0.1', port: 3003 },
];
const PEERS = process.env.RAFT_PEERS
  ? JSON.parse(process.env.RAFT_PEERS)
  : DEFAULT_PEERS;

const raft = new RaftNode(NODE_ID);
const stateMachine = new ReservoirStateMachine(NODE_ID);
raft.setStateMachine(stateMachine);
raft.setPeers(PEERS.filter((p) => p.id !== NODE_ID));

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();
const CHAT_HISTORY_MAX = 100;
const chatHistoryByRoom = new Map();

app.get('/health', (_req, res) => res.json({ ok: true, nodeId: NODE_ID }));

app.get('/api/status', (_req, res) => {
  res.json({
    ...raft.getStatus(),
    isLeader: raft.state === State.LEADER,
  });
});

app.get('/api/tiers', (_req, res) => res.json({ tiers: getAllTiers() }));

app.get('/api/reservoir', async (_req, res) => {
  const reservoir = await stateMachine.getReservoir();
  res.json(reservoir);
});

app.get('/api/user/:address', async (req, res) => {
  const user = await stateMachine.getUser(req.params.address);
  res.json(user || { error: 'User not found' });
});

app.get('/api/order/:id', async (req, res) => {
  const order = await stateMachine.getOrder(req.params.id);
  res.json(order || { error: 'Order not found' });
});

app.get('/api/user/:address/orders', async (req, res) => {
  const orders = await stateMachine.getOrdersByUser(req.params.address);
  res.json({ orders });
});

app.get('/api/user/:address/dashboard', async (req, res) => {
  const dashboard = await stateMachine.getDashboard(req.params.address);
  res.json(dashboard);
});

app.get('/api/announcements', (_req, res) => {
  res.json({ announcements: DEFAULT_ANNOUNCEMENTS });
});

app.get('/api/ticket/quote', (_req, res) => {
  res.json(stateMachine.ticketQuote());
});

/** 统一计算截取高度（所有 WSS 网关应固定转发到 node1 读本接口） */
app.get('/api/pool/checkpoint', async (_req, res) => {
  const checkpoint = await stateMachine.getPoolCheckpoint();
  if (!checkpoint) {
    return res.status(503).json({
      error: 'checkpoint 尚未发布',
      hint: '仅 node1 leader 每小时发布；请确认 CHECKPOINT_PUBLISHER=1',
      nodeId: NODE_ID,
      isLeader: raft.state === State.LEADER,
    });
  }
  res.json({ ok: true, nodeId: NODE_ID, checkpoint });
});

/** 三档公开购券地址（与客户端硬编码一致，可 HTTP 拉取） */
app.get('/api/pool/config', (_req, res) => {
  const {
    ENTRY_PERIOD_DAYS,
    EXIT_PERIOD_DAYS,
    MATCH_PAYMENT_TIMEOUT_HOURS,
    MAX_OPEN_ENTRIES_PER_PAYER,
    MAX_SPLITS_PER_PAYER,
    DAILY_MATCH_UTC_HOUR,
    MATCHES_PER_DAY,
    checkpointCutoffMs,
    checkpointDayId,
    dailyMatchContext,
  } = require('@mmm/shared');
  const matchCtx = dailyMatchContext();
  res.json({
    rulesVersion: POOL_RULES_VERSION,
    scheme: 'A',
    checkpointIntervalMs: CHECKPOINT_INTERVAL_MS,
    checkpointDayId: checkpointDayId(),
    checkpointCutoffMs: checkpointCutoffMs(),
    dailyMatch: matchCtx,
    matchesPerDay: MATCHES_PER_DAY,
    matchUtcHour: DAILY_MATCH_UTC_HOUR,
    beijingMatchHour: DAILY_MATCH_UTC_HOUR + 8,
    entryPeriodDays: ENTRY_PERIOD_DAYS,
    exitPeriodDays: EXIT_PERIOD_DAYS,
    matchPaymentTimeoutHours: MATCH_PAYMENT_TIMEOUT_HOURS,
    maxOpenEntriesPerPayer: MAX_OPEN_ENTRIES_PER_PAYER,
    maxSplitsPerPayer: MAX_SPLITS_PER_PAYER,
    pools: POOL_PURCHASE_CONFIG,
  });
});

/** 诊断：收款地址是否从环境变量生效（部署后可用 curl 自测） */
app.get('/api/system/payment-config', (_req, res) => {
  const treasury = PAYMENT_CONFIG.TREASURY_ADDRESS || '';
  const configured = treasury.startsWith('T') && !treasury.includes('PLACEHOLDER');
  res.json({
    serverBuild: 'ticket-pending-v2',
    treasuryConfigured: configured,
    treasury: configured ? treasury : null,
    treasuryEnvSet: Boolean(process.env.TREASURY_ADDRESS),
    pollIntervalMs: TIMEOUT_CONFIG.POLL_INTERVAL_MS,
    paymentTimeoutHours: TIMEOUT_CONFIG.PAYMENT_TIMEOUT_HOURS,
    nodeId: NODE_ID,
  });
});

app.get('/api/ticket/purchase/:id', async (req, res) => {
  const purchase = await stateMachine.getTicketPurchase(req.params.id);
  res.json(purchase || { error: 'Purchase not found' });
});

app.get('/api/user/:address/ticket-purchase/pending', async (req, res) => {
  const purchase = await stateMachine.getLatestPendingTicketPurchase(req.params.address);
  res.json(purchase || { error: 'none' });
});

app.post('/api/ticket/purchase/:id/report-tx', async (req, res) => {
  if (raft.state !== State.LEADER) {
    return res.status(503).json({ success: false, error: 'Not leader' });
  }
  const { txHash, userAddress } = req.body || {};
  if (!txHash || !userAddress) {
    return res.status(400).json({ success: false, error: '缺少 txHash 或 userAddress' });
  }
  try {
    const result = await stateMachine.reportTicketSelfTx(req.params.id, userAddress, txHash);
    res.json({ success: true, purchase: result.purchase, user: result.user });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/assessment/:address', async (req, res) => {
  const user = await stateMachine.getUser(req.params.address);
  res.json(stateMachine.calcAssessment(user));
});

app.get('/api/user/:address/network', async (req, res) => {
  const network = await stateMachine.getNetworkStats(req.params.address);
  res.json(network);
});

app.get('/api/user/:address/performance', async (req, res) => {
  const performance = await stateMachine.getPerformance(req.params.address);
  res.json(performance);
});

app.get('/api/user/:address/burn-rewards', async (req, res) => {
  const rewards = await stateMachine.getBurnRewards(req.params.address);
  res.json(rewards);
});

app.get('/api/payments/pending', async (_req, res) => {
  const pending = await stateMachine.getPendingPayments();
  res.json(pending);
});

app.get('/api/anchor/status', async (_req, res) => {
  const status = await stateMachine.getAnchorStatus();
  res.json(status);
});

app.post('/api/system/process-exits', async (_req, res) => {
  if (raft.state !== State.LEADER) {
    return res.status(503).json({ success: false, error: 'Not leader' });
  }
  const result = await stateMachine.processExitQueue();
  res.json({ success: true, ...result });
});

app.post('/api/command', async (req, res) => {
  if (raft.state !== State.LEADER) {
    return res.status(503).json({ success: false, error: 'Not leader', leader: raft.getStatus().leader });
  }

  const body = req.body || {};
  const command = body.command || body;
  const userAddress = body.userAddress || command.userAddress;

  if (body.signature) {
    const check = verifyCommandSignature(body, userAddress);
    if (!check.valid) {
      return res.status(401).json({ success: false, error: check.error });
    }
  } else if (process.env.REQUIRE_SIGNATURE === '1') {
    return res.status(401).json({ success: false, error: '必须提供客户端签名' });
  }

  const result = raft.submitCommand(command);
  if (!result.success) return res.status(400).json(result);

  raft.commitIndex = raft.log.length - 1;
  try {
    await raft.applyLogs();
  } catch (err) {
    console.error('[api/command] apply failed:', err.message);
    return res.status(400).json({ success: false, error: err.message || '命令执行失败' });
  }

  const payload = { success: true, index: result.index };
  if (command.type === 'BUY_TICKET' && userAddress) {
    const purchase = await stateMachine.getLatestPendingTicketPurchase(userAddress);
    if (purchase) payload.purchase = purchase;
  }
  res.json(payload);
});

app.get('/api/debug', async (_req, res) => {
  res.json({
    raft: raft.getStatus(),
    tiers: QUEUE_TIERS,
    data: await stateMachine.getAllData(),
  });
});

wss.on('connection', (ws, req) => {
  const clientId = req.headers['x-client-id'] || `client-${Date.now()}`;
  clients.set(clientId, ws);

  ws.send(
    JSON.stringify({
      type: 'welcome',
      nodeId: NODE_ID,
      status: raft.getStatus(),
    })
  );

  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === 'submit_command') {
        if (raft.state !== State.LEADER) {
          ws.send(JSON.stringify({ type: 'error', error: 'Not leader' }));
          return;
        }
        if (message.signature) {
          const check = verifyCommandSignature(message, message.userAddress || message.command?.userAddress);
          if (!check.valid) {
            ws.send(JSON.stringify({ type: 'error', error: check.error }));
            return;
          }
        }
        const result = raft.submitCommand(message.command);
        if (result.success) {
          raft.commitIndex = raft.log.length - 1;
          await raft.applyLogs();
          const payload = { type: 'command_result', success: true, index: result.index, command: message.command };
          ws.send(JSON.stringify(payload));
          broadcast(payload);
        } else {
          ws.send(JSON.stringify({ type: 'error', error: result.error }));
        }
      }

      if (message.type === 'subscribe' && message.topic === 'reservoir_updates') {
        const reservoir = await stateMachine.getReservoir();
        ws.send(JSON.stringify({ type: 'notification', topic: 'reservoir_updates', data: reservoir }));
      }

      if (message.type === 'subscribe' && message.topic === 'pool_checkpoint') {
        ws.poolCheckpoint = true;
        const checkpoint = await stateMachine.getPoolCheckpoint();
        if (checkpoint) {
          ws.send(JSON.stringify({ type: 'notification', topic: 'pool_checkpoint', data: checkpoint }));
        }
      }

      if (message.type === 'subscribe' && String(message.topic || '').startsWith('chat_')) {
        ws.chatRooms = ws.chatRooms || new Set();
        const room = String(message.topic).replace(/^chat_/, '') || 'hall';
        ws.chatRooms.add(room);
        const history = chatHistoryByRoom.get(room) || [];
        if (history.length) {
          ws.send(JSON.stringify({ type: 'notification', topic: `chat_${room}`, data: history }));
        }
      }

      if (message.type === 'chat_send') {
        const room = message.room || 'hall';
        const sender = message.sender || message.userAddress || '匿名';
        const content = String(message.content || '').trim();
        const check = checkSend({ sender, content });
        if (!check.ok) {
          ws.send(JSON.stringify({ type: 'chat_rejected', room, reason: check.reason }));
          return;
        }
        const msg = {
          id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          room,
          sender,
          content,
          at: Date.now(),
        };
        const history = chatHistoryByRoom.get(room) || [];
        history.push(msg);
        if (history.length > CHAT_HISTORY_MAX) history.splice(0, history.length - CHAT_HISTORY_MAX);
        chatHistoryByRoom.set(room, history);
        const payload = { type: 'notification', topic: `chat_${room}`, data: msg };
        broadcastChat(room, payload);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => clients.delete(clientId));
});

function broadcast(message) {
  const text = JSON.stringify(message);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  });
}

function broadcastChat(room, payload) {
  const text = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.chatRooms && ws.chatRooms.has(room)) {
      ws.send(text);
    }
  });
}

function broadcastPoolCheckpoint(checkpoint) {
  const payload = { type: 'notification', topic: 'pool_checkpoint', data: checkpoint };
  const text = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.poolCheckpoint) {
      ws.send(text);
    }
  });
}

async function publishPoolCheckpoint() {
  if (NODE_ID !== 'node1' || raft.state !== State.LEADER) return null;
  if (process.env.CHECKPOINT_PUBLISHER === '0') return null;

  const block = await fetchLatestTronBlock();
  const command = {
    type: COMMAND_TYPES.SET_POOL_CHECKPOINT,
    checkpointId: checkpointDayId(),
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    blockTimestamp: block.blockTimestamp,
    rulesVersion: POOL_RULES_VERSION,
    publishedAt: Date.now(),
    publisherNode: NODE_ID,
  };

  const result = raft.submitCommand(command);
  if (!result.success) {
    console.warn('[checkpoint] submit failed:', result.error);
    return null;
  }
  raft.commitIndex = raft.log.length - 1;
  await raft.applyLogs();
  const saved = await stateMachine.getPoolCheckpoint();
  if (saved) {
    console.log(
      `[checkpoint] 已发布 hour=${saved.checkpointId} block=${saved.blockNumber} ts=${saved.blockTimestamp}`,
    );
    broadcastPoolCheckpoint(saved);
  }
  return saved;
}

function startCheckpointPublisher() {
  if (NODE_ID !== 'node1' || process.env.CHECKPOINT_PUBLISHER === '0') return;

  const tick = () => {
    publishPoolCheckpoint().catch((e) => console.warn('[checkpoint]', e.message));
  };

  tick();
  setInterval(tick, CHECKPOINT_INTERVAL_MS);
  console.log(`[checkpoint] node1 发布器已启动，间隔 ${CHECKPOINT_INTERVAL_MS / 1000}s`);
}

function startConsensusDemo() {
  if (NODE_ID === 'node1') {
    raft.state = State.LEADER;
    raft.currentTerm = 1;
    setInterval(async () => {
      raft.commitIndex = Math.max(raft.commitIndex, raft.log.length - 1);
      await raft.applyLogs();
    }, 200);
    setInterval(() => {
      stateMachine.processExitQueue().catch((e) => console.warn('[exit-queue]', e.message));
    }, process.env.DEMO_FAST_EXIT === '1' ? 15000 : 3600000);
    startCheckpointPublisher();
  }
}

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on http://127.0.0.1:${PORT}`);
  startConsensusDemo();
});

process.on('SIGINT', async () => {
  await stateMachine.close();
  process.exit(0);
});
