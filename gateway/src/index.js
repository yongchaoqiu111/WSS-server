/**
 * WSS/HTTP 网关：客户端只连网关，网关转发到 Raft 节点（设计文档 2.2）
 * 生产环境 Raft 应仅内网可达；本地开发直连 node1。
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8443);
const GATEWAY_DOMAINS = (process.env.GATEWAY_DOMAINS || 'book26.top,news16.top')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const UPSTREAM_NODES = (process.env.UPSTREAM_NODES || 'http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let activeIndex = 0;

function pickUpstream() {
  return UPSTREAM_NODES[activeIndex % UPSTREAM_NODES.length];
}

async function healthCheck(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function rotateHealthyNode() {
  for (let i = 0; i < UPSTREAM_NODES.length; i += 1) {
    const idx = (activeIndex + i) % UPSTREAM_NODES.length;
    if (await healthCheck(UPSTREAM_NODES[idx])) {
      activeIndex = idx;
      return UPSTREAM_NODES[idx];
    }
  }
  return UPSTREAM_NODES[0];
}

const app = express();
app.use(cors());

app.get('/health', async (_req, res) => {
  const upstream = await rotateHealthyNode();
  res.json({ ok: true, upstream, nodes: UPSTREAM_NODES });
});

app.get('/api/domains', (_req, res) => {
  const domains = GATEWAY_DOMAINS.map((host, i) => ({
    id: host.replace(/\./g, '_'),
    name: `网关 ${String.fromCharCode(65 + i)} · ${host}`,
    apiUrl: `https://${host}`,
    wsUrl: `wss://${host}/ws`,
    status: 'online',
  }));
  res.json({ domains });
});

app.get('/', async (req, res) => {
  const upstream = await rotateHealthyNode();
  const host = req.get('host') || GATEWAY_DOMAINS[0] || 'localhost';
  const publicApi = host.includes('localhost') || host.includes('127.0.0.1')
    ? `http://127.0.0.1:${GATEWAY_PORT}`
    : `https://${host}`;
  const publicWs = publicApi.startsWith('https')
    ? `wss://${host.split(':')[0]}/ws`
    : `ws://127.0.0.1:${GATEWAY_PORT}/ws`;
  const domainList = GATEWAY_DOMAINS.map((d) => `<li><code>https://${d}</code> / <code>wss://${d}/ws</code></li>`).join('');
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>MMM Gateway</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>MMM 网关已运行</h1>
<p>这是 <strong>API / WebSocket 转发网关</strong>，不是 Flutter 前端页面。</p>
<ul>
<li>健康检查：<code><a href="/health">/health</a></code></li>
<li>共识 API：<code>/api/*</code>（例：<a href="/api/status">/api/status</a>）</li>
<li>域名列表：<code><a href="/api/domains">/api/domains</a></code></li>
<li>WebSocket：<code>${publicWs}</code></li>
<li>当前上游节点：<code>${upstream}</code></li>
</ul>
<p>默认双域名：</p><ul>${domainList}</ul>
<p>Flutter App 节点地址填 <code>${publicApi}</code>，WSS 填 <code>${publicWs}</code></p>
</body></html>`);
});

/** 池子 checkpoint / 配置：固定走 node1，避免多节点轮询导致高度不一致 */
const POOL_UPSTREAM =
  process.env.WS_UPSTREAM_NODE ||
  UPSTREAM_NODES[0] ||
  'http://127.0.0.1:3001';

app.use(
  '/api/pool',
  createProxyMiddleware({
    target: POOL_UPSTREAM,
    changeOrigin: true,
    ws: false,
    pathRewrite: (path) => `/api/pool${path}`,
  }),
);

app.use(
  '/api',
  createProxyMiddleware({
    target: UPSTREAM_NODES[0],
    router: async () => rotateHealthyNode(),
    changeOrigin: true,
    ws: false,
    pathRewrite: (path) => `/api${path}`,
  })
);

function isAllowedWsHost(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).split(':')[0].toLowerCase();
  if (GATEWAY_DOMAINS.includes(h)) return true;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  return false;
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const WS_UPSTREAM =
  process.env.WS_UPSTREAM_NODE ||
  UPSTREAM_NODES[0] ||
  'http://127.0.0.1:3001';

wss.on('connection', async (clientWs, req) => {
  const host = req.headers.host || '';
  if (!isAllowedWsHost(host)) {
    console.warn('[gateway] ws rejected, invalid Host:', host);
    clientWs.close(1008, 'invalid host');
    return;
  }

  const upstreamBase = WS_UPSTREAM;
  const upstreamUrl = upstreamBase.replace(/^http/, 'ws');
  const nodeWs = new WebSocket(upstreamUrl);
  const pending = [];

  const flushPending = () => {
    while (pending.length && nodeWs.readyState === WebSocket.OPEN) {
      nodeWs.send(pending.shift());
    }
  };

  nodeWs.on('open', () => {
    flushPending();
    clientWs.send(JSON.stringify({ type: 'gateway_connected', upstream: upstreamBase }));
  });

  nodeWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  clientWs.on('message', (data) => {
    if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(data);
    else pending.push(data);
  });

  const closeBoth = () => {
    try {
      clientWs.close();
    } catch {}
    try {
      nodeWs.close();
    } catch {}
  };

  clientWs.on('close', closeBoth);
  nodeWs.on('close', closeBoth);
  clientWs.on('error', closeBoth);
  nodeWs.on('error', closeBoth);
});

server.listen(GATEWAY_PORT, () => {
  console.log(`[gateway] http://127.0.0.1:${GATEWAY_PORT}  ws://127.0.0.1:${GATEWAY_PORT}/ws`);
  console.log(`[gateway] upstreams: ${UPSTREAM_NODES.join(', ')}`);
});
