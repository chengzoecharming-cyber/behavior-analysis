#!/usr/bin/env bash
# 把线上 PostgreSQL 数据同步到本地开发环境
# 用法：
#   export SERVER_DB_URL="postgres://user:pass@server_ip:5432/sales_map"
#   ./scripts/sync-db-from-server.sh

set -euo pipefail

SERVER_DB_URL="${SERVER_DB_URL:-}"
LOCAL_DB_URL="${LOCAL_DB_URL:-postgresql://sales:sales123@localhost:5433/sales_map}"
DUMP_FILE="/tmp/sales_map_dump_$(date +%Y%m%d_%H%M%S).sql"

if [ -z "$SERVER_DB_URL" ]; then
  echo "❌ 请设置 SERVER_DB_URL 环境变量，例如："
  echo "   export SERVER_DB_URL=\"postgres://user:pass@server_ip:5432/sales_map\""
  exit 1
fi

# 解析本地数据库名
LOCAL_DB_NAME=$(echo "$LOCAL_DB_URL" | sed -n 's/.*\/\([^/]*\)$/\1/p')
if [ -z "$LOCAL_DB_NAME" ]; then
  echo "❌ 无法从 LOCAL_DB_URL 解析数据库名"
  exit 1
fi

echo "🔄 开始同步线上数据库到本地..."
echo "   线上: $SERVER_DB_URL"
echo "   本地: $LOCAL_DB_URL"

# 1. 从线上 dump
echo "📦 正在导出线上数据..."
pg_dump "$SERVER_DB_URL" -Fc -f "$DUMP_FILE"
echo "✅ 导出完成: $DUMP_FILE"

# 2. 重建本地数据库
echo "🗑️  正在重建本地数据库..."
# 连接到 postgres 数据库执行 DROP/CREATE
ADMIN_URL=$(echo "$LOCAL_DB_URL" | sed "s|/${LOCAL_DB_NAME}$|/postgres|")
psql "$ADMIN_URL" -c "DROP DATABASE IF EXISTS ${LOCAL_DB_NAME};" >/dev/null 2>&1 || true
psql "$ADMIN_URL" -c "CREATE DATABASE ${LOCAL_DB_NAME};" >/dev/null 2>&1 || true

# 3. 恢复到本地
echo "📥 正在恢复到本地..."
pg_restore -d "$LOCAL_DB_URL" --no-owner --no-privileges "$DUMP_FILE" || true

echo "✅ 同步完成！"
