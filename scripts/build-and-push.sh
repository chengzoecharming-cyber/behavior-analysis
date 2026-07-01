#!/bin/bash
set -e

# ============================================================
# 本地构建并推送镜像到容器仓库
# 用法（GitHub Container Registry）：
#   export GHCR_OWNER=你的GitHub用户名
#   export GITHUB_TOKEN=你的GitHub Personal Access Token
#   export VITE_AMAP_KEY=你的高德地图Key
#   bash scripts/build-and-push.sh
#
# 用法（Docker Hub）：
#   export IMAGE_REGISTRY=docker.io
#   export GHCR_OWNER=你的DockerHub用户名
#   export DOCKER_USERNAME=你的DockerHub用户名
#   export DOCKER_PASSWORD=你的DockerHub密码
#   bash scripts/build-and-push.sh
# ============================================================

IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
GHCR_OWNER="${GHCR_OWNER:-你的GitHub用户名}"
BACKEND_IMAGE="${IMAGE_REGISTRY}/${GHCR_OWNER}/sales-map-backend"
FRONTEND_IMAGE="${IMAGE_REGISTRY}/${GHCR_OWNER}/sales-map-frontend"
VITE_AMAP_KEY="${VITE_AMAP_KEY:-你的高德地图Key}"

echo "=============================================="
echo " 构建并推送 Docker 镜像"
echo " 后端：${BACKEND_IMAGE}:latest"
echo " 前端：${FRONTEND_IMAGE}:latest"
echo "=============================================="

# 登录仓库
if [[ "${IMAGE_REGISTRY}" == "ghcr.io" ]]; then
  if [ -z "${GITHUB_TOKEN}" ]; then
    echo "[错误] 使用 GHCR 时需要设置 GITHUB_TOKEN"
    exit 1
  fi
  echo "${GITHUB_TOKEN}" | docker login ghcr.io -u "${GHCR_OWNER}" --password-stdin
elif [[ "${IMAGE_REGISTRY}" == "docker.io" ]]; then
  if [ -z "${DOCKER_PASSWORD}" ]; then
    echo "[错误] 使用 Docker Hub 时需要设置 DOCKER_PASSWORD"
    exit 1
  fi
  echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USERNAME}" --password-stdin
fi

# 构建后端
echo "[信息] 构建后端镜像..."
docker build -t "${BACKEND_IMAGE}:latest" ./backend
docker push "${BACKEND_IMAGE}:latest"

# 构建前端
echo "[信息] 构建前端镜像..."
docker build \
  --build-arg "VITE_AMAP_KEY=${VITE_AMAP_KEY}" \
  -t "${FRONTEND_IMAGE}:latest" \
  ./frontend
docker push "${FRONTEND_IMAGE}:latest"

echo ""
echo "=============================================="
echo " 镜像推送完成"
echo "=============================================="
echo " 后端：${BACKEND_IMAGE}:latest"
echo " 前端：${FRONTEND_IMAGE}:latest"
echo ""
echo " 接下来在服务器上执行："
echo "   export GHCR_OWNER=${GHCR_OWNER}"
echo "   export AMAP_KEY=${VITE_AMAP_KEY}"
echo "   bash /root/sales-map/deploy.sh"
echo "=============================================="
