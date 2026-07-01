#!/bin/bash
set -e

# 销售外勤行为分析系统 - 服务器一键部署脚本
# 用法：bash /root/deploy.sh

read -s -p "请输入 GitHub Token（输入时不显示）: " GITHUB_TOKEN
echo ""
if [ -z "$GITHUB_TOKEN" ]; then
  echo "[错误] Token 不能为空"
  exit 1
fi

GHCR_OWNER="chengzoecharming-cyber"
AMAP_KEY="1951ce9d4a18081f865ebc85298a9ddb"
SERVER_IP="8.219.97.3"
PROJECT_DIR="/root/sales-map"

echo "=============================================="
echo " 销售外勤行为分析系统 - 一键部署"
echo "=============================================="

# 安装 Docker（Alibaba Cloud Linux / CentOS）
if ! command -v docker &> /dev/null; then
  echo "[信息] 正在安装 Docker..."
  yum install -y yum-utils
  yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
  sed -i 's+download.docker.com+mirrors.aliyun.com/docker-ce+' /etc/yum.repos.d/docker-ce.repo
  yum makecache fast
  yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
fi

if ! docker compose version &> /dev/null; then
  echo "[错误] docker compose 未安装"
  exit 1
fi

echo "[信息] 登录 GitHub Container Registry..."
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GHCR_OWNER" --password-stdin

DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)

mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

cat > docker-compose.yml << COMPOSEEOF
services:
  postgres:
    image: postgres:16-alpine
    container_name: sales-map-postgres
    environment:
      POSTGRES_USER: sales
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: sales_map
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  backend:
    image: ghcr.io/${GHCR_OWNER}/sales-map-backend:latest
    container_name: sales-map-backend
    environment:
      DATABASE_URL: postgresql://sales:${DB_PASSWORD}@postgres:5432/sales_map
      AMAP_KEY: ${AMAP_KEY}
      DINGTALK_APP_KEY: ${DINGTALK_APP_KEY:-}
      DINGTALK_APP_SECRET: ${DINGTALK_APP_SECRET:-}
      DINGTALK_PROCESS_CODE: ${DINGTALK_PROCESS_CODE:-}
      PORT: 3000
      NODE_ENV: production
    ports:
      - "3000:3000"
    depends_on:
      - postgres
    volumes:
      - backend_uploads:/app/uploads
    restart: unless-stopped

  frontend:
    image: ghcr.io/${GHCR_OWNER}/sales-map-frontend:latest
    container_name: sales-map-frontend
    ports:
      - "5173:80"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  postgres_data:
  backend_uploads:
COMPOSEEOF

echo "[信息] 拉取并启动服务..."
docker compose down || true
docker compose pull
docker compose up -d

echo ""
echo "=============================================="
echo " ✅ 部署完成！"
echo "=============================================="
echo " 🌐 访问地址：http://${SERVER_IP}:5173"
echo " 🔌 后端 API：http://${SERVER_IP}:3000"
echo "=============================================="
