# 部署说明

## 前置

- Ubuntu 22.04+
- 域名已解析到服务器（如 `api.xxx.com`）
- 安全组仅开放 **80 / 443**

## 步骤

```bash
git clone https://github.com/yongchaoqiu111/WSS-server.git
cd WSS-server/deploy
cp .env.example .env
nano .env
sudo bash install.sh
```

## `.env` 必填

```env
MMM_DOMAIN=api.你的域名.com
TREASURY_ADDRESS=T你的收款地址
NODE_ENV=production
DEMO_FAST_EXIT=0
```

## 更新

```bash
cd WSS-server
git pull
cd deploy
docker compose --env-file .env up -d --build
```

## 验证

```bash
curl https://你的域名/health
curl https://你的域名/api/status
```
