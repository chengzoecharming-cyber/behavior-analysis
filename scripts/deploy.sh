#!/bin/bash
set -e

# ============================================================
# 销售外勤行为分析系统 - 服务器一键部署脚本
# 用法：在服务器上执行下面这条命令即可
#   bash /root/sales-map/deploy.sh
#
# 部署前，只需要在本脚本开头填写 4 个必填项：
#   GHCR_OWNER    = 你的 GitHub 用户名
#   GITHUB_TOKEN  = 你的 GitHub Token（用于拉取镜像）
#   AMAP_KEY      = 你的高德地图 Key
#   SERVER_IP     = 你的服务器公网 IP
# ============================================================

# ==================== 必填配置 ====================
GHCR_OWNER="你的GitHub用户名"           # 例如：zhangsan
GITHUB_TOKEN="你的GitHub Token"         # 从 https://github.com/settings/tokens 生成
AMAP_KEY="你的高德地图Key"              # 前端地图需要
SERVER_IP="你的服务器公网IP"            # 例如：123.45.67.89
# ==================================================

# 选填配置（一般保持默认即可）
PROJECT_DIR="${PROJECT_DIR:-/root/sales-map}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 16)}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
DB_PORT="${DB_PORT:-5433}"

# 镜像地址（不用改）
BACKEND_IMAGE="ghcr.io/${GHCR_OWNER}/sales-map-backend:latest"
FRONTEND_IMAGE="ghcr.io/${GHCR_OWNER}/sales-map-frontend:latest"

# 检查必填项
if [ "$GHCR_OWNER" = "你的GitHub用户名" ] || [ -z "$GHCR_OWNER" ]; then
  echo "[错误] 请先编辑本脚本，填写 GHCR_OWNER（你的 GitHub 用户名）"
  exit 1
fi

if [ "$GITHUB_TOKEN" = "你的GitHub Token" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "[错误] 请先编辑本脚本，填写 GITHUB_TOKEN"
  echo "获取方式：https://github.com/settings/tokens -> Generate new token (classic)"
  echo "勾选权限：read:packages, write:packages（只拉取只需要 read:packages 即可）"
  exit 1
fi

if [ "$AMAP_KEY" = "你的高德地图Key" ] || [ -z "$AMAP_KEY" ]; then
  echo "[错误] 请先编辑本脚本，填写 AMAP_KEY"
  exit 1
fi

if [ "$SERVER_IP" = "你的服务器公网IP" ] || [ -z "$SERVER_IP" ]; then
  echo "[错误] 请先编辑本脚本，填写 SERVER_IP（服务器公网 IP）"
  exit 1
fi

echo "=============================================="
echo " 销售外勤行为分析系统 - 一键部署"
echo " GitHub 用户：${GHCR_OWNER}"
echo " 项目目录：${PROJECT_DIR}"
echo "=============================================="

# 安装 Docker（Alibaba Linux / CentOS）
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

# 安装 docker-compose（如果没有）
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

# 保存配置到 .env
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
echo "   ${COMPOSE_CMD} logs -f backend    # 看后端的日志"
echo "   ${COMPOSE_CMD} logs -f frontend   # 看前端的日志"
echo "   ${COMPOSE_CMD} logs -f postgres   # 看数据库日志"
echo "   ${COMPOSE_CMD} down               # 停止服务"
echo "   ${COMPOSE_CMD} up -d              # 启动服务"
echo ""
echo " 数据库密码已保存在：${PROJECT_DIR}/.env"
echo " 建议备份数据库：${COMPOSE_CMD} exec postgres pg_dump -U sales sales_map > backup_\$(date +%Y%m%d).sql"
echo "=============================================="
