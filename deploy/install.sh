#!/usr/bin/env bash
# MMM 单机一键部署（Ubuntu 22.04+ / Debian）
# 用法: sudo bash install.sh
set -euo pipefail

# 仓库根 = WSS-server/
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
cd "$DEPLOY"
echo "仓库目录: $ROOT"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "请使用 root 或 sudo 运行: sudo bash install.sh"
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已生成 deploy/.env，请先编辑 MMM_DOMAIN 和 TREASURY_ADDRESS"
  exit 1
fi

# shellcheck disable=SC1091
source .env

if [[ -z "${MMM_DOMAIN:-}" || "$MMM_DOMAIN" == "api.example.com" ]]; then
  echo "请在 deploy/.env 中设置 MMM_DOMAIN=你的域名"
  exit 1
fi

echo ">>> 安装 Docker..."
if ! command -v docker &>/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

echo ">>> 启动 MMM 服务栈..."
docker compose --env-file .env up -d --build node1 node2 node3 gateway

if [[ "${ENABLE_LISTENER:-0}" == "1" ]]; then
  docker compose --env-file .env --profile listener up -d listener
fi

echo ">>> 安装 Nginx..."
apt-get install -y nginx certbot python3-certbot-nginx

sed "s/__DOMAIN__/$MMM_DOMAIN/g" nginx/mmm.conf.template > "/etc/nginx/sites-available/mmm"
ln -sf /etc/nginx/sites-available/mmm /etc/nginx/sites-enabled/mmm
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo ">>> 申请 SSL 证书（需域名已解析到本机）..."
certbot --nginx -d "$MMM_DOMAIN" --non-interactive --agree-tos -m "${CERTBOT_EMAIL:-admin@$MMM_DOMAIN}" || {
  echo "Certbot 失败：请确认 DNS 已指向本机，然后手动执行:"
  echo "  certbot --nginx -d $MMM_DOMAIN"
}

systemctl reload nginx

echo ""
echo "=========================================="
echo "部署完成"
echo "  HTTPS API:  https://$MMM_DOMAIN/api/status"
echo "  WSS:        wss://$MMM_DOMAIN/ws"
echo "  健康检查:   https://$MMM_DOMAIN/health"
echo ""
echo "Flutter App 节点配置:"
echo "  API:  https://$MMM_DOMAIN"
echo "  WSS:  wss://$MMM_DOMAIN/ws"
echo "=========================================="
