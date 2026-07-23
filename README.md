# 销售外勤行为分析系统（P1 架构设计版）

基于 RAW / NORMALIZED / DERIVED 三层数据架构的销售外勤行为分析系统，支持轨迹可视化、停留分析、异常检测、里程与 KPI 统计。

## 技术栈

- **前端**：React + Vite + TypeScript + Ant Design + 高德地图 JS API
- **后端**：Node.js + Express + TypeScript
- **数据库**：PostgreSQL

## 项目结构

```
map/
├── backend/                    # Express + TypeScript 后端
│   ├── src/
│   │   ├── index.ts            # 服务入口
│   │   ├── db.ts               # PostgreSQL 连接与建表
│   │   ├── types.ts            # 全类型定义
│   │   ├── routes/             # API 路由
│   │   │   ├── visits.ts
│   │   │   ├── stops.ts
│   │   │   ├── routes.ts
│   │   │   ├── upload.ts
│   │   │   └── analytics.ts
│   │   └── services/           # 业务逻辑
│   │       ├── distance.ts
│   │       ├── stopDetection.ts
│   │       ├── routePlanning.ts
│   │       ├── routeService.ts
│   │       ├── anomalyDetection.ts
│   │       ├── geocoding.ts
│   │       └── excelParser.ts
│   ├── scripts/seed.ts         # Mock 数据导入脚本
│   ├── schema.sql              # 数据库建表 SQL
│   ├── .env.example
│   └── package.json
├── frontend/                   # React + Vite 前端
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api.ts
│   │   ├── types.ts
│   │   ├── pages/              # Dashboard / MapPage / UploadPage
│   │   └── components/         # MapContainer
│   ├── .env.example
│   └── package.json
├── data/
│   ├── mock-visits.xlsx        # 示例拜访数据
│   └── generate_mock.py        # 示例数据生成脚本
├── docker-compose.yml
├── docker-compose.ghcr.yml
├── DEPLOY.md
└── README.md
```

## 核心数据规则

### 业务日期（business_date）

`visits.business_date` 是前端控制台、决策页、排行榜、趋势分析等所有聚合口径的基准日期。

**规则：Excel 按每条签到时间归日；钉钉按审批单级归日——整张审批单统一取「首次签到」的北京时间日期。**

- Excel 数据：把 `visit.time` 解析为北京时间后取日期部分。
- 钉钉数据：同一张审批单的所有签到（包括次日早上的跨天收尾签到）都归到该审批单首次签到的那天，控制台一天只展示一次，与里程口径（按审批单首次签到日期聚合）一致。

为什么不用钉钉审批单创建时间？

- 钉钉审批单创建时间可能早于实际签到（提前提交），也可能晚于实际签到（补卡）。
- 「首次签到时间」是行程真实开始的时刻，比创建时间更可靠。
- 审批单创建时间作为 metadata 保留在 `raw_approvals` 中，用于对账。

因此：
- `business_date` = 审批单首次签到日期（北京时间）；Excel 为每条签到日期
- `approval_id` = 审批单 ID，用于地图轨迹按审批单分组回放
- 审批单创建时间作为 metadata 保留在 `raw_approvals` 中，用于对账

如果历史数据需要按新规则重算，执行：

```bash
cd backend
npm run recompute:business-dates
```

### 同步数据校验机制

系统为钉钉同步建立了完整的数据完整性校验，避免人工反复检查。

**校验指标**：

| 指标 | 含义 | 正常状态 |
|------|------|---------|
| `total_instances` | 钉钉返回的审批单总数 | 与钉钉后台一致 |
| `parsed_visits` | 解析出的 visit 数量 | 通常 >= 写入数量 |
| `normalized_inserted` | 成功写入 `visits` 的数量 | 与 `parsed_visits` 接近 |
| `raw_visit_count` | 成功写入 `raw_visits` 的数量 | 与 `parsed_visits` 一致 |
| `missing_count` | 解析成功但库中缺失的审批单数 | 0 |
| `duplicate_count` | `approval_id + user_id + sequence` 重复数 | 0 |
| `source_approval_ids_hash` / `db_approval_ids_hash` | 源端与库中审批单集合的 hash | 一致 |

**自动告警**：

- 每次定时同步完成后，系统会立即检查上述指标，发现异常时通过 `DINGTALK_EXPORT_ROBOT_WEBHOOK` 发送钉钉机器人告警。
- 每天早上 9:00 发送昨日同步健康摘要（仅在有异常时发送）。
- 前端「同步健康」页面展示最近同步状态、未处理告警和一键补同步入口。

**手动处理**：

- 对异常同步记录可点击「重试」重新执行同步。
- 对指定日期范围可点击「强制同步」，绕过 `already synced` 检查重新拉取。

## 数据架构

```
RAW 层          →  raw_visits（Excel / 钉钉原始数据，完全保留）
NORMALIZED 层   →  visits（时间、经纬度、user_id 标准化后的核心数据）
DERIVED 层      →  stops / routes / anomalies（分析计算结果）
```

详见 `backend/schema.sql`。

## 已实现功能

### P0（基础功能）

- Excel 数据导入（支持简单格式 + 钉钉审批宽表格式）
- 拜访轨迹地图播放（polyline + marker + 时间轴 Slider）
- Segment 路径规划（高德 API，无 Key 时降级为直线）
- 基础里程计算（Haversine）

### P1（新增能力）

- **三层数据架构**：RAW / NORMALIZED / DERIVED 分层存储
- **停留分析**：150m 范围内停留 >10 分钟自动识别为 stop
- **异常检测**：
  - 停留时间过长（>120 分钟）
  - 长时间未移动（>180 分钟无记录）
  - 路径异常绕行（实际距离 > 直线距离 × 2）
- **里程/油费估算**：基于 routes 汇总，自动按需计算
- **Dashboard KPI**：拜访数、停留数、总里程、Segment 数、估算油费、异常事件列表
- **地址地理编码**：支持高德 / Nominatim（OpenStreetMap）回退

## API 列表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/visits?user=&start=&end=` | 查询标准化拜访记录 |
| GET | `/visits/users` | 获取所有员工列表 |
| GET | `/stops?user=&date=` | 计算并持久化停留点 |
| GET | `/routes?user=&date=` | 计算并持久化路径 Segment |
| GET | `/analytics/mileage?user=&date=` | 每日里程与油费估算 |
| GET | `/analytics/anomaly?user=&date=` | 异常行为检测 |
| POST | `/dingtalk/sync` | 手动同步指定日期范围 |
| GET | `/dingtalk/sync-logs` | 查询同步历史记录 |
| GET | `/dingtalk/sync-health?limit=7` | 查询最近同步健康状态 |
| GET | `/dingtalk/sync-alerts` | 查询未处理同步告警 |
| POST | `/dingtalk/sync-alerts/:id/ack` | 确认同步告警已处理 |
| POST | `/dingtalk/sync-force` | 强制重新同步指定日期范围 |
| POST | `/upload-excel` | 上传 Excel，写入 RAW + NORMALIZED |

## 快速开始

### 1. 启动 PostgreSQL

```bash
docker-compose up -d postgres
```

默认映射到本机 `5433` 端口，避免与本地其他 PostgreSQL 冲突。

### 2. 启动后端

```bash
cd backend
cp .env.example .env
# 如需地址转经纬度，AMAP_KEY 需为「Web服务」Key
npm install
npm run seed      # 可选：导入示例数据
npm run dev       # http://localhost:3000
```

### 3. 启动前端

```bash
cd frontend
cp .env.example .env
# 编辑 .env，填入 VITE_AMAP_KEY（高德 JS API Key）
npm install
npm run dev       # 已固定端口 5173（--strictPort，避免自动切换）
```

### 4. 导入真实数据

访问前端「数据上传」页面，或调用：

```bash
curl -X POST http://localhost:3000/upload-excel \
  -F "file=@/path/to/your/file.xlsx"
```

当前已支持：
- 标准格式：`user_name, time, location_name, address, lat, lng, customer_name`
- 钉钉审批导出宽表：自动提取多段拜访记录

## 端口与访问

本地开发时各服务默认端口如下：

| 服务 | 地址 | 说明 |
|---|---|---|
| 前端 | `http://localhost:5173` | Vite 已固定 `--strictPort`，不会自动切换到 5174 等端口 |
| 后端 | `http://localhost:3000` | Express API 入口，健康检查 `/health` |
| PostgreSQL | `localhost:5433` | Docker Compose 映射到本机 5433，避免与本地其他 PostgreSQL 冲突 |

默认管理员账号（本地开发）：

- 用户名：`admin`
- 密码：`admin123`

## 生产部署

生产环境使用 GitHub Actions 构建镜像并推送到 GHCR，服务器直接拉取镜像运行，无需在服务器编译代码。

详细步骤见 [`DEPLOY.md`](./DEPLOY.md)。

## 注意事项

### 高德 Key 平台说明

本项目需要两类高德能力，对应不同 Key：

| 用途 | 能力 | Key 类型 |
|---|---|---|
| 前端地图显示 | 高德 JS API | Web 端（JS API）Key |
| 后端地址转经纬度 | 地理编码 API | Web 服务 Key |

如果你遇到 `USERKEY_PLAT_NOMATCH` 错误，说明当前 Key 没有对应服务权限，需要去高德控制台重新创建或勾选相应服务。

### Nominatim 说明

后端已内置 Nominatim（OpenStreetMap）作为高德失败后的回退方案，但在部分网络环境下可能访问超时，建议优先配置高德 Web 服务 Key。

## 未来扩展

当前架构已预留扩展点：

- 钉钉 API 实时接入 → 直接写入 `raw_visits`
- KPI 分析 → 基于 `stops` / `routes` 聚合
- 行为评分系统 → 扩展 `anomalies` 权重模型
- 部门对比分析 → 基于 `visits.department` 分组统计
- 坐标补全 → 支持批量地址 geocoding 与人工修正
