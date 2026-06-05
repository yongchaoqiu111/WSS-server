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

app.get('/', async (_req, res) => {
  const upstream = await rotateHealthyNode();
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
<li>WebSocket：<code>ws://127.0.0.1:${GATEWAY_PORT}/ws</code></li>
<li>当前上游节点：<code>${upstream}</code></li>
</ul>
<p>请启动 Flutter 客户端测试：</p>
<pre>cd F:\\3MMM\\MMM\\client\nflutter run -d chrome</pre>
<p>App 内节点地址填 <code>http://127.0.0.1:${GATEWAY_PORT}</code></p>
</body></html>`);
});

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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', async (clientWs) => {
  const upstreamBase = await rotateHealthyNode();
  const upstreamUrl = upstreamBase.replace(/^http/, 'ws');
  const nodeWs = new WebSocket(upstreamUrl);

  nodeWs.on('open', () => {
    clientWs.send(JSON.stringify({ type: 'gateway_connected', upstream: upstreamBase }));
  });

  nodeWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  clientWs.on('message', (data) => {
    if (nodeWs.readyState === WebSocket.OPEN) nodeWs.send(data);
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
