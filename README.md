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
└── README.md
```

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
npm run dev       # http://localhost:5173
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

## 当前运行状态

- 前端服务：`http://localhost:5173`
- 后端服务：`http://localhost:3000`
- 已导入 Mock 数据 27 条 + 真实钉钉数据 89 条

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
