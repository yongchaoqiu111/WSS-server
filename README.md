# WSS-server

MMM 项目 **服务端专用仓库**：Raft 共识节点 + HTTP/WSS 网关 + 链监听 + 一键部署。

Flutter 客户端、设计文档在**其他仓库**，不在此库。

## 目录

| 目录 | 说明 |
|------|------|
| `gateway/` | 无状态 WSS/HTTP 网关 |
| `private-chain/` | Raft 节点 + 状态机 |
| `shared/` | 排单/蓄水池规则 |
| `listener/` | TRX 链监听（无私钥） |
| `anchor/` | Merkle 存证载荷（无私钥） |
| `deploy/` | Docker + Nginx + `install.sh` |

## 服务器一键部署

```bash
git clone https://github.com/yongchaoqiu111/WSS-server.git
cd WSS-server/deploy
cp .env.example .env
nano .env    # MMM_DOMAIN、TREASURY_ADDRESS
sudo bash install.sh
```

部署后：

- API：`https://你的域名`
- WSS：`wss://你的域名/ws`

详细说明见 [deploy/README.md](deploy/README.md)

## 本地开发

```bash
npm install
npm run node1
npm run node2
npm run node3
npm run gateway
```

## 客户端配置

在 Flutter App **我的 → 服务器配置** 填写上述 HTTPS / WSS 地址（客户端仓库另行发布）。
