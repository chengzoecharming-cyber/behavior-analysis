# 服务器部署指南（GHCR 镜像版）

> 目标：把 GitHub Actions 自动构建好的 Docker 镜像部署到 Linux 服务器，让同事可以通过浏览器访问。

## 整体流程

```text
代码 push 到 main → GitHub Actions 构建镜像 → 推送到 GHCR
                                ↓
服务器登录 GHCR → 拉取镜像 → docker compose 启动
```

你不需要在服务器上编译代码，只需要复制粘贴命令。

---

## 第一步：把代码推送到 GitHub

1. 去 [GitHub](https://github.com) 注册/登录账号。
2. 新建一个仓库，例如 `behavior-analysis`。
3. 把本地代码推上去：

```bash
cd /Users/chenglimin/workspace/danfo/boss/map
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/你的用户名/behavior-analysis.git
git push -u origin main
```

---

## 第二步：在 GitHub 添加密钥

打开仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| 名称 | 值 | 说明 |
|------|-----|------|
| `VITE_AMAP_KEY` | 你的高德 JS API Key | 前端地图需要，构建时固化到镜像里 |

后端需要的 `AMAP_KEY` 是运行时通过服务器 `.env` 注入的，不需要放在 GitHub Secrets 里。

---

## 第三步：准备服务器

你需要一台 Linux 服务器（阿里云 ECS / 腾讯云 CVM / 华为云 ECS 等）。

**最低配置**：1 核 2G，建议 2 核 4G。

需要放行以下端口：

- `5173`：前端页面
- `3000`：后端 API
- `5433`：PostgreSQL（可选，仅外部管理时需要）

---

## 第四步：生成 GitHub Token（用于拉取镜像）

1. 打开 [https://github.com/settings/tokens](https://github.com/settings/tokens)
2. 点击 **Generate new token (classic)**
3. 勾选 `read:packages`
4. 点击 **Generate**，复制并保存好 token

> 如果 GHCR 包是私有的，确保你的账号对该包有读取权限（仓库 owner 默认有）。

---

## 第五步：登录服务器并部署

### 5.1 SSH 登录服务器

```bash
ssh root@你的服务器IP
```

### 5.2 创建项目目录和 `.env`

```bash
mkdir -p /root/sales-map
cd /root/sales-map

cat > .env << 'EOF'
GHCR_OWNER=你的GitHub用户名
AMAP_KEY=你的高德Web服务Key

# 钉钉同步相关（不需要钉钉同步可留空）
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=
DINGTALK_PROCESS_CODE=

# 钉钉导出机器人相关（不需要可留空）
DINGTALK_EXPORT_CHAT_ID=
DINGTALK_EXPORT_ROBOT_WEBHOOK=
DINGTALK_EXPORT_ROBOT_SECRET=
EOF
```

> `GHCR_OWNER` 是你的 GitHub 用户名或组织名，镜像路径是 `ghcr.io/${GHCR_OWNER}/sales-map-backend`。
> `AMAP_KEY` 必须是**高德 Web 服务 Key**（不是 JS API Key）。

### 5.3 创建 `docker-compose.ghcr.yml`

服务器上不需要安装 git，直接创建文件：

```bash
cat > /root/sales-map/docker-compose.ghcr.yml << 'EOF'
# 使用 GitHub Container Registry 上预构建的镜像
services:
  postgres:
    image: postgres:16-alpine
    container_name: sales-map-postgres
    environment:
      POSTGRES_USER: sales
      POSTGRES_PASSWORD: sales123
      POSTGRES_DB: sales_map
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sales -d sales_map"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/${GHCR_OWNER}/sales-map-backend:latest
    container_name: sales-map-backend
    environment:
      DATABASE_URL: postgresql://sales:sales123@postgres:5432/sales_map
      AMAP_KEY: ${AMAP_KEY}
      AMAP_ROUTE_TIMEOUT_MS: ${AMAP_ROUTE_TIMEOUT_MS:-15000}
      AMAP_ROUTE_RETRY_COUNT: ${AMAP_ROUTE_RETRY_COUNT:-5}
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-postgres,localhost,127.0.0.1}
      DINGTALK_APP_KEY: ${DINGTALK_APP_KEY:-}
      DINGTALK_APP_SECRET: ${DINGTALK_APP_SECRET:-}
      DINGTALK_PROCESS_CODE: ${DINGTALK_PROCESS_CODE:-}
      DINGTALK_EXPORT_CHAT_ID: ${DINGTALK_EXPORT_CHAT_ID:-}
      DINGTALK_EXPORT_ROBOT_WEBHOOK: ${DINGTALK_EXPORT_ROBOT_WEBHOOK:-}
      DINGTALK_EXPORT_ROBOT_SECRET: ${DINGTALK_EXPORT_ROBOT_SECRET:-}
      PORT: 3000
      NODE_ENV: production
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
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
EOF
```

### 5.4 登录 GitHub Container Registry

```bash
docker login ghcr.io -u 你的GitHub用户名
```

提示 `Password:` 时粘贴你的 GitHub Token（输入不显示）。

看到 `Login Succeeded` 即可。

### 5.5 拉取并启动服务

```bash
cd /root/sales-map

# 清理可能存在的失败容器
docker rm -f sales-map-backend sales-map-frontend 2>/dev/null || true

# 拉取镜像
docker compose -f docker-compose.ghcr.yml pull backend frontend

# 启动所有服务
docker compose -f docker-compose.ghcr.yml up -d
```

### 5.6 验证

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
curl -s http://localhost:3000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173
```

正常应该看到：

- `sales-map-postgres`：healthy
- `sales-map-backend`：Up，`/health` 返回 `{"status":"ok"}`
- `sales-map-frontend`：Up，`5173` 返回 `200`

然后浏览器访问：

```text
http://你的服务器IP:5173
```

### 5.7 验证同步校验机制（如已配置钉钉）

如果配置了钉钉同步，部署后应检查新对账字段是否生效：

```bash
# 检查 dingtalk_sync_logs 新增字段
docker exec -i sales-map-postgres psql -U sales -d sales_map -c "
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'dingtalk_sync_logs'
  AND column_name IN ('source_approval_ids_hash', 'db_approval_ids_hash', 'missing_count', 'duplicate_count', 'raw_visit_count', 'alert_sent')
ORDER BY column_name;
"

# 手动触发一次同步，检查新字段是否有值
docker compose -f docker-compose.ghcr.yml exec backend \
  curl -X POST http://localhost:3000/dingtalk/sync \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2026-07-20","endDate":"2026-07-21"}'

# 查看最新同步日志的对账字段
docker exec -i sales-map-postgres psql -U sales -d sales_map -c "
SELECT id, status, start_date, end_date, total_instances, parsed_visits,
       source_approval_ids_hash, db_approval_ids_hash, missing_count, duplicate_count
FROM dingtalk_sync_logs
ORDER BY id DESC
LIMIT 5;
"
```

浏览器访问 `http://你的服务器IP:5173/sync-health`，应能看到「同步健康」页面。

---

## 第六步：更新代码后重新部署

推送新代码到 `main` 分支，等待 GitHub Actions 构建完成后，在服务器执行：

```bash
cd /root/sales-map
docker compose -f docker-compose.ghcr.yml pull backend frontend
docker compose -f docker-compose.ghcr.yml up -d
```

数据库数据会保留，不需要重新导入。

### 本次更新（同步校验机制）需额外执行

本次改动涉及 `dingtalk_sync_logs` 表新增字段和 `business_date` 计算口径调整。部署后执行：

```bash
cd /root/sales-map

# 1. 重新计算历史 visits 的 business_date（按实际签到时间）
docker exec -it sales-map-backend npm run recompute:business-dates

# 2. 重新计算异常与风险缓存（基于新的 business_date）
docker exec -it sales-map-backend npm run recompute:anomalies
```

如果希望同时重新计算所有 routes（会调用高德 API，耗时较长）：

```bash
docker exec -it sales-map-backend npm run recompute:routes
# 然后再重新跑异常
docker exec -it sales-map-backend npm run recompute:anomalies
```

---

## F9.5 部门归属与角色治理（生产环境执行一次）

本次治理涉及 `visits.user_id`、`visits.department`、`users` 表及派生数据。部署新版本后，需要在生产环境按以下顺序执行一次：

```bash
cd /root/sales-map

# 1. 先同步最新钉钉通讯录
docker exec -it sales-map-backend npm run sync:contacts

# 2. user_id 归一化
docker exec -it sales-map-backend npm run f9:normalize-user-ids

# 3. 初始化 leader / super_admin
docker exec -it sales-map-backend npm run f9:init-leader-roles

# 4. 销售渠道数据并入销售部
docker exec -it sales-map-backend npm run f9:merge-sales-channel

# 5. 重算异常与风险缓存
docker exec -it sales-map-backend npm run recompute:anomalies
```

**注意**：
- 执行前建议备份数据库；
- 如果生产环境已有历史数据且 `visits.user_id` 已经对齐钉钉 userid，第 2 步会跳过大部分记录；
- 第 4 步会把「销售渠道」中同时也是销售部员工的数据，按人合并到对应的销售部子部门；
- 第 5 步会基于新的 `user_id` / `department` 重新计算异常事件和风险摘要，不会重新调用高德 API。

---

## 常见问题

### 1. 端口访问不了

检查服务器安全组/防火墙是否放行了 `5173`、`3000`、`5433`。

### 2. `invalid reference format`

`.env` 里没有 `GHCR_OWNER`。检查：

```bash
grep GHCR_OWNER /root/sales-map/.env
```

没有的话加上：

```bash
echo "GHCR_OWNER=你的GitHub用户名" >> /root/sales-map/.env
```

### 3. `password authentication failed for user "sales"`

说明 postgres 里 `sales` 用户的密码不是 `sales123`（例如之前用 `scripts/deploy.sh` 部署过，它使用了随机密码）。

修复方法：把密码改成 `sales123`：

```bash
docker exec -i sales-map-postgres psql -U sales -d sales_map -c "ALTER USER sales WITH PASSWORD 'sales123';"
docker compose -f docker-compose.ghcr.yml up -d --force-recreate backend
```

### 4. 忘记数据库密码

密码就是 `sales123`（本指南固定值）。如果你之前改过，可以进容器查看：

```bash
docker inspect sales-map-postgres -f '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}'
```

### 5. 怎么看日志

```bash
cd /root/sales-map
docker compose -f docker-compose.ghcr.yml logs -f backend
docker compose -f docker-compose.ghcr.yml logs -f frontend
docker compose -f docker-compose.ghcr.yml logs -f postgres
```

### 6. `scripts/deploy.sh` 还能用吗？

`scripts/deploy.sh` 仅适合**首次全新部署**。它会：

- 每次生成随机数据库密码
- 覆盖 `docker-compose.yml`

如果服务器上已经有 postgres 数据，直接运行会导致后端连不上数据库。**有数据后请使用本指南的手动步骤。**
