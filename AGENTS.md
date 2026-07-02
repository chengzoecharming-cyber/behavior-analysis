# AGENTS.md

> 本文件面向 AI 编程助手。如果你刚拿到这个项目，请先阅读本文，再修改代码。
> 项目人文档见 `README.md`，部署细节见 `DEPLOY.md`，开发计划见 `PLAN.md`。

## 项目概述

这是一个**销售外勤行为分析系统**，用于分析销售人员的外勤轨迹、停留行为、里程偏差与异常事件，并提供管理驾驶舱（决策系统）和单人轨迹控制台。

系统核心能力：

- 从 Excel 或钉钉审批流程导入拜访数据。
- 在地图上回放拜访轨迹、停留点、异常标记。
- 自动识别停留点（150 米半径内停留超过 10 分钟）。
- 基于高德路径规划计算实际行驶距离，并与员工填报里程对比。
- 检测 8 类异常行为（拜访量不足、重复签到、停留过长、长时间未移动、路径绕行、里程偏差、异常出行方式、特殊签到缺原因等）。
- 按员工/部门/日期范围聚合风险评分与区域热力图。
- 支持申诉审批与异常豁免。

当前项目采用前后端分离架构，部署在 Docker 容器中，GitHub Actions 自动构建镜像。

## 技术栈

- **前端**：React 18 + TypeScript + Vite 5 + React Router 6
  - UI 库：Ant Design 5 + Semi Design（字节跳动）混合使用
  - 样式：Tailwind CSS（已关闭 `preflight`，避免覆盖 Ant Design / Semi Design 的样式重置）
  - 地图：高德 JS API 2.0（`@amap/amap-jsapi-loader`）
  - 图标：`lucide-react` + `@douyinfe/semi-icons` + `@ant-design/icons`
  - HTTP：`axios`
  - 日期：`dayjs`

- **后端**：Node.js 20 + Express 4 + TypeScript
  - 数据库：PostgreSQL 16（`pg` 驱动）
  - Excel 解析：`xlsx`
  - 文件上传：`multer`
  - 地理编码：高德 Web 服务 API，失败时回退到 Nominatim（OpenStreetMap）
  - 路径规划：高德驾车路径规划 API

- **基础设施**：Docker + Docker Compose + GitHub Actions + GitHub Container Registry（GHCR）

## 项目结构

```
map/
├── backend/                    # Express + TypeScript 后端
│   ├── src/
│   │   ├── index.ts            # 服务入口、路由挂载、定时任务启动
│   │   ├── db.ts               # PostgreSQL 连接与建表（真实 schema 来源）
│   │   ├── types.ts            # 全类型定义
│   │   ├── routes/             # API 路由
│   │   │   ├── visits.ts
│   │   │   ├── stops.ts
│   │   │   ├── routes.ts
│   │   │   ├── upload.ts
│   │   │   ├── analytics.ts
│   │   │   ├── regionalOverview.ts
│   │   │   ├── riskSummary.ts
│   │   │   ├── dingtalk.ts
│   │   │   ├── users.ts
│   │   │   └── feedback.ts
│   │   └── services/           # 业务逻辑
│   │       ├── auth.ts
│   │       ├── dingtalk.ts
│   │       ├── excelParser.ts
│   │       ├── normalization.ts
│   │       ├── geocoding.ts
│   │       ├── distance.ts
│   │       ├── routePlanning.ts
│   │       ├── routeService.ts
│   │       ├── stopDetection.ts
│   │       ├── anomalyDetection.ts
│   │       ├── anomalyWeights.ts
│   │       ├── mileageAnalysis.ts
│   │       ├── riskScoring.ts
│   │       ├── riskSummaryService.ts
│   │       ├── departmentAliasService.ts
│   │       └── scheduler.ts
│   ├── scripts/
│   │   ├── seed.ts                       # 从 data/mock-visits.xlsx 导入模拟数据
│   │   ├── refreshRiskCache.ts           # 手动刷新风险摘要缓存
│   │   └── recomputeMileageAndRoutes.ts  # 清空并重新计算 routes、风险摘要与异常（修正里程口径后使用）
│   ├── schema.sql              # P1 早期架构文档（仅供参考，实际以 db.ts 为准）
│   ├── uploads/                # Excel 上传临时文件
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── frontend/                   # React + Vite 前端
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx             # 路由与导航
│   │   ├── api.ts              # axios 封装与 API 调用
│   │   ├── types.ts
│   │   ├── pages/              # 页面组件
│   │   │   ├── DecisionPage.tsx
│   │   │   ├── ConsolePage.tsx
│   │   │   ├── UploadPage.tsx
│   │   │   ├── DataSyncPage.tsx
│   │   │   ├── RulesConfigPage.tsx
│   │   │   ├── FeedbackPage.tsx
│   │   │   └── MapPage.tsx
│   │   └── components/         # 可复用组件
│   │       ├── ErrorBoundary.tsx
│   │       ├── MapContainer.tsx
│   │       └── HeatMapContainer.tsx
│   ├── index.html
│   ├── nginx.conf
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── .env.example
├── data/
│   ├── mock-visits.xlsx        # 示例拜访数据
│   └── generate_mock.py        # 示例数据生成脚本（openpyxl）
├── scripts/
│   ├── build-and-push.sh       # 本地构建并推送 Docker 镜像
│   └── deploy.sh               # 服务器一键部署脚本（含硬编码配置，需检查）
├── .github/workflows/
│   └── docker-build.yml        # GitHub Actions 构建并推送镜像到 GHCR
├── docker-compose.yml          # 本地源码构建启动
├── docker-compose.ghcr.yml     # 使用 GHCR 预构建镜像启动
├── .env.example                # 根目录环境变量模板
├── README.md
├── DEPLOY.md
└── PLAN.md
```

## 架构说明

### 数据分层

数据库按 RAW / NORMALIZED / DERIVED 三层设计：

| 层级 | 表 | 说明 |
|---|---|---|
| RAW | `raw_visits`、`raw_approvals` | 完全保留 Excel 或钉钉审批原始数据 |
| NORMALIZED | `visits` | 标准化后的拜访记录（用户、时间、经纬度、客户等） |
| DERIVED | `stops`、`routes`、`anomalies` | 分析计算结果：停留点、路径段、异常事件 |
| 缓存/配置 | `risk_summary_cache`、`anomaly_weights`、`department_aliases` | 预计算缓存、异常规则、部门别名映射 |
| 用户/权限 | `users`、`feedback`、`anomaly_exceptions` | 用户、角色、申诉、异常豁免 |
| 钉钉同步 | `dingtalk_departments`、`dingtalk_users` | 钉钉通讯录同步缓存 |

**注意**：`backend/schema.sql` 是早期 P1 文档，只包含基础表。真实建表逻辑在 `backend/src/db.ts` 中，通过 `CREATE TABLE IF NOT EXISTS` 和 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 做幂等初始化。项目中没有独立的迁移框架。

### 认证方式

当前不是基于 Cookie/JWT 的登录系统，而是简化方案：

- 前端在 `localStorage` 保存 `user_id`。
- `frontend/src/api.ts` 的请求拦截器把 `user_id` 写入请求头 `X-User-Id`。
- 后端 `backend/src/services/auth.ts` 通过该 header 识别当前用户。
- 本地开发默认自动以 `admin` 身份登录。

角色设计：`admin`（查看全部）、`manager`（查看本部门）、`staff`（仅查看自己）。目前 `/users`、`/feedback` 已接入权限过滤，但大量核心业务接口（`/analytics/*`、`/visits/*` 等）尚未收口。

### 时区约定

业务日期**统一按北京时间（Asia/Shanghai，UTC+8）**处理：

- 数据库存储为 `TIMESTAMPTZ`（UTC）。
- 钉钉解析时把北京时间字符串正确转 UTC 存储。
- 查询接口把前端传入的日期按 `+08:00` 解释。
- 转换逻辑集中在 `backend/src/services/utils/timezone.ts`。

### 定时任务

后端启动时注册两个定时任务（`backend/src/services/scheduler.ts`），均按北京时间每天执行：

1. **风险摘要缓存刷新**：每天凌晨 2:00 刷新「昨天」的 `risk_summary_cache`。
2. **钉钉审批同步**：每天凌晨 2:30 同步昨天的钉钉审批实例到 `visits`（未配置钉钉则跳过）。

### 地理编码策略

- 优先调用高德地理编码 API（需要 `AMAP_KEY`，且必须是「Web 服务」Key）。
- 无 Key 或失败时，使用内置城市/区县/省份近似坐标表并加随机抖动作为兜底。
- 后端也支持 Nominatim（OpenStreetMap）回退，但可能因网络超时失败。

## 环境变量

### 根目录 `.env.example`

```env
# 后端高德 Web 服务 Key（地理编码 + 路径规划）
AMAP_KEY=your_amap_web_service_key

# 前端高德 JS API Key（地图加载）
VITE_AMAP_KEY=your_amap_js_api_key
```

### 后端 `backend/.env.example`

```env
PORT=3000
DATABASE_URL=postgresql://sales:sales123@localhost:5433/sales_map
AMAP_KEY=YOUR_AMAP_KEY

# 钉钉开放平台（企业内部应用）
DINGTALK_APP_KEY=YOUR_DINGTALK_APP_KEY
DINGTALK_APP_SECRET=YOUR_DINGTALK_APP_SECRET
DINGTALK_PROCESS_CODE=YOUR_DINGTALK_PROCESS_CODE
```

### 前端 `frontend/.env.example`

```env
VITE_AMAP_KEY=YOUR_AMAP_KEY
```

**高德 Key 类型说明**：

| 用途 | 能力 | Key 类型 |
|---|---|---|
| 前端地图显示 | 高德 JS API | Web 端（JS API）Key |
| 后端地址转经纬度 | 地理编码 API | Web 服务 Key |

如果看到 `USERKEY_PLAT_NOMATCH` 错误，说明 Key 没有对应服务权限，需要去高德控制台重新创建或勾选相应服务。

## 构建与开发命令

### 后端

```bash
cd backend
cp .env.example .env
# 编辑 .env，填入 DATABASE_URL 和 AMAP_KEY
npm install
npm run dev        # http://localhost:3000，使用 nodemon + ts-node
npm run build      # tsc，输出到 dist/
npm run start      # node dist/index.js（生产启动）
npm run seed       # 导入 data/mock-visits.xlsx 模拟数据
```

### 前端

```bash
cd frontend
cp .env.example .env
# 编辑 .env，填入 VITE_AMAP_KEY
npm install
npm run dev        # http://localhost:5173（--strictPort，不会自动切换端口）
npm run build      # tsc && vite build，输出到 dist/
npm run preview    # vite preview
```

### 全栈 Docker 启动

```bash
# 本地源码构建启动
docker-compose up -d

# 或使用 GHCR 预构建镜像
export GHCR_OWNER=<你的GitHub用户名>
AMAP_KEY=xxx docker-compose -f docker-compose.ghcr.yml up -d
```

端口映射：

- 前端：`5173`
- 后端：`3000`
- PostgreSQL：`5433`（容器内 `5432`）

## 主要 API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/visits?user=&start=&end=` | 查询标准化拜访记录 |
| GET | `/visits/users` | 获取所有员工列表 |
| GET | `/visits/available-dates?user=` | 某员工有数据的日期列表 |
| POST | `/visits/:id/coordinates` | 手动修正拜访点坐标 |
| GET | `/stops?user=&start=&end=` | 查询停留点（范围模式） |
| GET | `/stops?user=&date=` | 计算并持久化停留点（单日模式） |
| GET | `/routes?user=&start=&end=` | 计算并持久化路径 Segment |
| POST | `/upload-excel?preview=true` | Excel 上传预览 |
| POST | `/upload-excel` | Excel 上传并导入 |
| GET | `/analytics/mileage?user=&start=&end=` | 里程与油费估算 |
| GET | `/analytics/anomaly?user=&start=&end=` | 异常检测 |
| GET | `/analytics/anomaly-weights` | 异常规则权重列表 |
| PUT | `/analytics/anomaly-weights/:key` | 更新异常规则 |
| GET | `/analytics/risk-score?user_id=&date=` | 单日风险评分 |
| GET | `/analytics/risk-summary?date=` | 单日风险摘要 |
| GET | `/analytics/risk-summary/range?start=&end=` | 日期范围风险摘要 |
| POST | `/analytics/risk-summary/refresh?date=` | 手动刷新某天缓存 |
| GET | `/analytics/regional-overview` | 区域拜访热力图与部门分布 |
| GET | `/analytics/departments` | 规范部门列表 |
| POST | `/analytics/init-department-aliases` | 初始化部门别名映射 |
| GET/PUT | `/analytics/department-aliases` | 部门别名 CRUD |
| GET/POST | `/dingtalk/*` | 钉钉同步相关接口 |
| GET/POST/PUT/DELETE | `/users/*` | 用户管理 |
| GET/POST/PUT | `/feedback/*` | 反馈申诉 |

前后端代理路径：

- 开发环境：Vite 把 `/api/*` 代理到 `http://localhost:3000/`，并去掉 `/api` 前缀。
- 生产环境：Nginx 把 `/api/*` 代理到 `http://backend:3000/`，并去掉 `/api` 前缀。
- 后端 Express 路由直接挂在根路径，例如 `/visits`。

## 代码组织与约定

### 后端

- `src/routes/`：只负责接收请求、解析参数、调用 service、返回响应。不应包含复杂业务逻辑。
- `src/services/`：包含所有业务逻辑、外部 API 调用、数据计算。
- `src/types.ts`：集中定义所有 TypeScript 类型。
- `src/db.ts`：集中管理数据库连接与 schema 初始化。
- 时间处理统一使用 `src/services/utils/timezone.ts`，按北京时间解释业务日期。
- 地理编码统一使用 `src/services/geocoding.ts`。
- 异常检测统一读取 `anomaly_weights` 表配置，不要硬编码权重。

### 前端

- `src/pages/`：页面级组件，对应路由。
- `src/components/`：可复用组件（地图、热力图、错误边界）。
- `src/api.ts`：所有后端接口调用集中在这里。
- `src/types.ts`：前端类型定义。
- UI 组件库混合使用 Ant Design 和 Semi Design：
  - 控制台、上传、同步页面使用 Ant Design。
  - 决策系统、规则配置、反馈页面使用 Semi Design。
- Tailwind CSS 用于原子化布局，但已关闭 `preflight`。

### 通用约定

- 项目主要使用中文注释和文档，新增代码建议保持中文注释。
- 数据库表名和字段使用小写 + 下划线。
- 后端 TypeScript 配置 `strict: true`，新增代码需通过类型检查。
- 前端 `tsconfig.json` 开启 `noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`。

## 测试策略

**当前项目中没有自动化测试**（没有测试框架、没有测试目录、没有测试脚本）。

本地验证依赖：

- `npm run build` 通过 TypeScript 类型检查。
- `npm run dev` 手动在浏览器验证功能。
- `npm run seed` 导入模拟数据后验证 API。

如果新增核心算法或异常规则，建议先在 `backend/scripts/` 下添加临时脚本验证，再集成到路由/service 中。

## 部署流程

### GitHub Actions 自动构建

`.github/workflows/docker-build.yml`：

- 触发条件：`push` 到 `main` 分支，或手动 `workflow_dispatch`。
- 构建两个镜像并推送到 GHCR：
  - `ghcr.io/<owner>/sales-map-backend:latest`
  - `ghcr.io/<owner>/sales-map-frontend:latest`
- 多平台构建：`linux/amd64`、`linux/arm64`。
- 前端镜像构建时注入 `secrets.VITE_AMAP_KEY`。

### 服务器部署

参考 `DEPLOY.md` 和 `scripts/deploy.sh`。

**注意**：`scripts/deploy.sh` 当前硬编码了 `GHCR_OWNER`、`AMAP_KEY`、`SERVER_IP`，生产部署前务必修改为外部注入或私有配置。

更新代码后重新部署：

```bash
cd /root/sales-map
docker compose pull
docker compose up -d
```

查看日志：

```bash
cd /root/sales-map
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

## 安全注意事项

1. **不要把真实 Key 提交到仓库**：`AMAP_KEY`、`VITE_AMAP_KEY`、钉钉 `APP_SECRET`、`GITHUB_TOKEN` 等敏感信息只应出现在 `.env`、GitHub Secrets 或服务器环境变量中。`.gitignore` 已排除 `.env`、`.env.local`。

2. **部署脚本硬编码问题**：`scripts/deploy.sh` 中当前写死了 `AMAP_KEY` 和服务器 IP，生产环境应改为外部传入或从安全存储读取。

3. **认证机制较弱**：当前通过 `X-User-Id` header 识别用户，没有 JWT/Cookie/Session。任何人只要知道用户 ID 就能模拟该用户。如果对外开放，必须替换为正式认证方案。

4. **上传目录安全**：`backend/uploads/` 存放上传的 Excel 临时文件，文件名由 multer 随机生成。生产环境建议定期清理，并限制上传文件大小与类型。

5. **SQL 注入防护**：后端使用参数化查询（`pg` 的 `$1, $2` 占位符），不要拼接 SQL 字符串。

6. **CORS**：后端当前使用 `app.use(cors())` 允许所有来源。生产部署时应限制为前端域名。

7. **地理编码兜底精度低**：未配置 `AMAP_KEY` 时使用内置城市坐标表加随机抖动，不适合高精度场景。

## 已知问题与注意事项

- `backend/schema.sql` 与 `backend/src/db.ts` 不同步，实际 schema 以 `db.ts` 为准。
- 权限系统框架已完成，但大量核心业务接口尚未按角色过滤数据。
- 部门名称通过 `department_aliases` 表规范化，当前有 10 个规范部门/分组。
- 风险摘要缓存策略：历史日期优先读 `risk_summary_cache`，今天及以后实时计算。
- 钉钉表单中的 `累计里程N` 是截至本次签到的累计值，系统统计时应按 `approval_id` 取 `MAX(reported_distance_km)`，不能直接 `SUM`。
- 路线计算已按 `approval_id` 分组，控制台地图支持按审批单切换视图。
- 里程读数异常上限通过环境变量 `MILEAGE_VALIDATION_MAX_KM`（后端）和 `VITE_MILEAGE_MAX_KM`（前端）配置，默认 5000 km。
- 钉钉通讯录同步因应用可见范围不足已暂时放弃，改为依赖 `department_aliases` 映射。
- 车辆/油卡/油耗模型（Step 4）已暂缓，相关表结构在 `PLAN.md` 中有设计但未实现。
- 月维度数据导出（Step 5）尚未实现。

## 快速开始（最小路径）

```bash
# 1. 启动数据库
docker-compose up -d postgres

# 2. 启动后端
cd backend
cp .env.example .env
npm install
npm run seed
npm run dev

# 3. 启动前端
cd ../frontend
cp .env.example .env
npm install
npm run dev

# 4. 浏览器访问 http://localhost:5173
```
