#!/bin/bash
set -e

# ============================================================
# 销售外勤行为分析系统 - 服务器一键部署脚本
# 用法：bash /root/deploy.sh
#
# 只需要修改下面 4 行里的 token 即可，其他都已填好
# ============================================================

GHCR_OWNER="chengzoecharming-cyber"
GITHUB_TOKEN="在这里填写你的 GitHub Token"
AMAP_KEY="1951ce9d4a18081f865ebc85298a9ddb"
SERVER_IP="8.219.97.3"

# ============================================================
# 以下一般不用改
# ============================================================
PROJECT_DIR="/root/sales-map"
DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)"
FRONTEND_PORT="5173"
BACKEND_PORT="3000"
DB_PORT="5433"

BACKEND_IMAGE="ghcr.io/${GHCR_OWNER}/sales-map-backend:latest"
FRONTEND_IMAGE="ghcr.io/${GHCR_OWNER}/sales-map-frontend:latest"

# 检查必填项
if [ "$GITHUB_TOKEN" = "在这里填写你的 GitHub Token" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "[错误] 请先编辑本脚本，把 GITHUB_TOKEN 换成你的 GitHub Token"
  exit 1
fi

echo "=============================================="
echo " 销售外勤行为分析系统 - 一键部署"
echo " GitHub 用户：${GHCR_OWNER}"
echo " 服务器 IP：${SERVER_IP}"
echo " 项目目录：${PROJECT_DIR}"
echo "=============================================="

# 安装 Docker
install_docker() {
  echo "[信息] 正在安装 Docker..."
  if command -v yum &> /dev/null; then
    yum install -y docker
    systemctl enable docker
    systemctl start docker
  elif command -v apt-get &> /dev/null; then
    apt-get update
    apt-get install -y docker.io docker-compose
    systemctl enable docker
    systemctl start docker
  else
    echo "[错误] 无法自动安装 Docker，请手动安装"
    exit 1
  fi
}

if ! command -v docker &> /dev/null; then
  install_docker
fi

# 安装 docker-compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo "[信息] 正在安装 docker-compose..."
  curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  chmod +x /usr/local/bin/docker-compose
fi

if docker compose version &> /dev/null; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

# 创建项目目录
mkdir -p "${PROJECT_DIR}"
cd "${PROJECT_DIR}"

# 写入 docker-compose.yml
cat > docker-compose.yml <<EOF
services:
  postgres:
    image: postgres:16-alpine
    container_name: sales-map-postgres
    environment:
      POSTGRES_USER: sales
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: sales_map
    ports:
      - "${DB_PORT}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sales -d sales_map"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    image: ${BACKEND_IMAGE}
    container_name: sales-map-backend
    environment:
      DATABASE_URL: postgresql://sales:${DB_PASSWORD}@postgres:5432/sales_map
      AMAP_KEY: ${AMAP_KEY}
      PORT: 3000
      NODE_ENV: production
    ports:
      - "${BACKEND_PORT}:3000"
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - backend_uploads:/app/uploads
    restart: unless-stopped

  frontend:
    image: ${FRONTEND_IMAGE}
    container_name: sales-map-frontend
    environment:
      - BACKEND_API_URL=http://${SERVER_IP}:${BACKEND_PORT}
    ports:
      - "${FRONTEND_PORT}:80"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  postgres_data:
  backend_uploads:
EOF

# 保存配置
cat > .env <<EOF
GHCR_OWNER=${GHCR_OWNER}
AMAP_KEY=${AMAP_KEY}
SERVER_IP=${SERVER_IP}
DB_PASSWORD=${DB_PASSWORD}
FRONTEND_PORT=${FRONTEND_PORT}
BACKEND_PORT=${BACKEND_PORT}
DB_PORT=${DB_PORT}
EOF

# 登录 GitHub 镜像仓库
echo "[信息] 登录 GitHub Container Registry..."
echo "${GITHUB_TOKEN}" | docker login ghcr.io -u "${GHCR_OWNER}" --password-stdin

# 拉取并启动
echo "[信息] 拉取最新镜像..."
docker pull "${BACKEND_IMAGE}"
docker pull "${FRONTEND_IMAGE}"

echo "[信息] 启动服务..."
${COMPOSE_CMD} down || true
${COMPOSE_CMD} up -d

# 等待数据库就绪
echo "[信息] 等待数据库启动..."
for i in {1..30}; do
  if ${COMPOSE_CMD} ps postgres | grep -q "healthy"; then
    echo "[信息] 数据库已就绪"
    break
  fi
  echo "[信息] 等待中... (${i}/30)"
  sleep 2
done

echo ""
echo "=============================================="
echo " ✅ 部署完成！"
echo "=============================================="
echo ""
echo " 🌐 前端页面：http://${SERVER_IP}:${FRONTEND_PORT}"
echo " 🔌 后端 API：http://${SERVER_IP}:${BACKEND_PORT}"
echo ""
echo " 常用命令："
echo "   cd ${PROJECT_DIR}"
echo "   ${COMPOSE_CMD} logs -f backend"
echo "   ${COMPOSE_CMD} logs -f frontend"
echo "   ${COMPOSE_CMD} logs -f postgres"
echo ""
echo " 数据库密码已保存在：${PROJECT_DIR}/.env"
echo "=============================================="
