#!/usr/bin/env bash
# 检查线上/本地 API 是否读到 TREASURY_ADDRESS
# 用法: bash verify-treasury.sh https://book26.top
set -euo pipefail
BASE="${1:-https://book26.top}"

echo "=== $BASE/api/ticket/quote ==="
curl -fsS -m 20 "$BASE/api/ticket/quote" | python3 -m json.tool 2>/dev/null || curl -fsS -m 20 "$BASE/api/ticket/quote"
echo ""

echo "=== $BASE/api/system/payment-config ==="
if curl -fsS -m 20 "$BASE/api/system/payment-config" 2>/dev/null; then
  echo ""
else
  echo "(404/失败 → 服务器仍是旧版，需重新 deploy WSS-server)"
fi

echo ""
echo "期望: treasury 以 T 开头且非 PLACEHOLDER；payment-config 含 serverBuild=ticket-pending-v2"
