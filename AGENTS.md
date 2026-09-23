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
- 检测多类异常行为（拜访量不足、重复签到、里程偏差、里程读数异常、累计里程不一致、特殊签到缺原因等；长时间未移动、路径绕行、异常出行方式规则保留但默认禁用；「停留过长」规则已废弃删除）。
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
│   │   │   ├── feedback.ts
│   │   │   └── crmAnalytics.ts      # 客户分析（探迹 CRM 数据）：/crm-analytics 总览/交叉/词云/机会地图/躺尸卡死
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
│   │   ├── backfillVisitExclusion.ts     # 回填 visits.exclude_from_visit_count（拜访次数排除住址/公司地址，--dry 预览）
│   │   ├── recomputeMileageAndRoutes.ts  # 清空并重新计算 routes、风险摘要与异常（修正里程口径后使用）
│   │   ├── reparseApproval.ts        # 销售修改钉钉表单后重录指定审批单（重拉实例→重解析替换 visits→重算派生数据，--dry 预览）
│   │   ├── importCrmExcel.ts         # 探迹 CRM Excel 导入（客户/联系人/跟进记录 → crm_* 表）
│   │   └── addSalesChannelAliases.ts # 销售渠道-X区域 → 销售部主部门 别名归一化配置（幂等，npm run alias:sales-channels）
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
│   │   │   ├── DataSyncCenterPage.tsx  # 数据同步中心：同步概览（记录+健康+告警）+ 数据血缘 两 Tab
│   │   │   ├── DataLineagePage.tsx     # 数据血缘面板（DataLineagePanel 被同步中心复用）
│   │   │   ├── RulesConfigPage.tsx
│   │   │   ├── FeedbackPage.tsx
│   │   │   ├── CustomerAnalysisPage.tsx  # 客户分析（WIP）：总览/客户×拜访交叉/词云/躺尸卡死/机会地图
│   │   │   └── MapPage.tsx
│   │   └── components/         # 可复用组件
│   │       ├── ErrorBoundary.tsx
│   │       ├── MapContainer.tsx
│   │       ├── HeatMapContainer.tsx
│   │       └── crm/                # 客户分析组件
│   │           ├── FollowWordCloud.tsx   # 跟进纪要词云（纯 SVG 螺旋布局，props: data:{word,count}[]，可复用）
│   │           └── CustomerMap.tsx       # 客户机会地图（高德打点，私海蓝/公海橙，拜访次数决定气泡大小）
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
| 缓存/配置 | `risk_summary_cache`、`anomaly_weights`、`department_aliases`、`company_addresses` | 预计算缓存、异常规则、部门别名映射、公司地址白名单 |
| 用户/权限 | `users`（含 `is_resigned` 离职标记）、`feedback`、`anomaly_exceptions` | 用户、角色、申诉、异常豁免 |
| 钉钉同步 | `dingtalk_departments`、`dingtalk_users` | 钉钉通讯录同步缓存 |
| 报告生成 | `report_generation_logs` | 自动报告生成日志（同一次 run 共享 `run_id`，含状态/耗时/文档链接） |
| 探迹 CRM | `raw_crm_rows`、`crm_import_batches`、`crm_customers`、`crm_contacts`、`crm_follow_records`、`crm_customer_geocode` | CRM Excel 导入批次与原始行、客户主表、联系人、跟进记录、客户地址地理编码缓存 |

**注意**：`backend/schema.sql` 是早期 P1 文档，只包含基础表。真实建表逻辑在 `backend/src/db.ts` 中，通过 `CREATE TABLE IF NOT EXISTS` 和 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 做幂等初始化。项目中没有独立的迁移框架。

### 派生数据重算原则（规则变更的必备配套）

`anomalies`、`risk_summary_cache`、`routes`、`stops`、`visits.exclude_from_visit_count`、`visits.customer_count` 等都是**落库的派生数据**：改检测/统计口径的代码后，**线上已有记录不会自动更新**——只部署新代码会看到旧结果（2026-08-07 案例：v2 里程读数异常逻辑修复后，12 条旧误报残留在 anomalies 表，需手动 DELETE 清除）。

因此任何口径/规则变更必须配套：

1. **评估影响面**：新口径对哪些历史 user+date 的结果不同；
2. **清理或重算存量**，可用入口：
   - 单 user+date 的异常+风险摘要：`computeRiskSummary`（先删后插），经 `POST /analytics/risk-summary/refresh?date=`（admin）或下一次同步自动触发；
   - 全量异常重算：`npm run recompute:anomalies`（重，全表删除重建，慎用）；
   - 拜访排除标记：`npm run backfill:visit-exclusion`（幂等）；多客户计数：`npm run backfill:customer-count`；
   - routes/里程：`npm run recompute:routes`；
   - 单张审批单重录（销售改完钉钉表单后）：`npm run reparse:approval -- <approval_id> [--dry]`（删旧 visits 重解析 + 全量重算该单影响的派生数据）；
3. **把重算/清理命令写进部署步骤**（PLAN.md 对应条目），部署代码和重算数据是同一次变更的两半。

反过来说：只改代码里的口径常量/权重（`anomaly_weights` 表配置类）且确认无存量误报时，可只清理受影响日期的 anomalies 让读路径自然重建，不必全量重算。

### 认证方式

以**钉钉扫码登录 + session token** 为主：

- 登录流程：`GET /auth/dingtalk/authorize-url`（校验 origin 白名单、签发一次性 state）→ 跳转钉钉扫码页 → 回调 `/login/callback` → `POST /auth/dingtalk/callback`（authCode → 用户 token → unionId → 企业 userid → 校验 users 表：不存在/is_resigned/is_invalid 均 403）→ 签发随机 token 写入 `auth_sessions` 表（7 天有效）。
- 前端在 `localStorage` 保存 `auth_token`，请求拦截器发 `Authorization: Bearer <token>`；收到 401 清登录态跳登录页。
- 后端 `backend/src/services/auth.ts` 的 `authMiddleware`/`getCurrentUser` 优先解析 Bearer token（`resolveToken`，惰性清理过期 session）。
- **应急密码登录**：`POST /auth/login` 仅当 `AUTH_PASSWORD_LOGIN_ENABLED=true` 可用，成功后同样签发 session token。
- **旧的 X-User-Id 信任头**：仅在 `AUTH_HEADER_FALLBACK=true` 时作为回退（本地开发过渡用，生产必须关闭）。
- 退出登录：`POST /auth/logout` 删除服务端 session。

角色设计：`admin`（查看全部）、`manager`（查看本部门）、`staff`（仅查看自己）。权限口径分两类页面：

- **总览页（DecisionPage）数据源**（`/analytics/company-dashboard`、`/analytics/org-tree`、`/analytics/org-overview`、`/analytics/risk-summary*`、`/analytics/regional-overview`、`/analytics/mileage-distribution`）：**所有角色登录即可见全公司数据**（便于横向对比），不做权限收敛；前端仅 admin 可点击页面内容跳转（员工卡片 → 控制台），manager/staff 为纯浏览视图。
- **「数据&分析」（ConsolePage）数据源**（`/visits/*`、`/stops`、`/routes`、`/analytics/mileage`、`/analytics/anomaly`、`/analytics/user-overview`、`/analytics/risk-score`、`/dingtalk/org-tree`、`/dingtalk/users`、`/dingtalk/console-members`）：按角色过滤——manager 可见范围由 `users.department` 自动决定（'销售部' → 全部门含子部门；'销售部-华东昆山' → 仅该子部门，复用 `orgService.getUserIdsUnderNode`），始终 ∪ 自己 ∪ 全部可见 admin；staff = 自己 ∪ 全部可见 admin ∪ 本区 leader（`department` 第一段以「销售部-」开头才生效；**`REPORT_DEPT_LEADERS` 配了该子部门就以配置为准**——如 `华南一部:李朝晖`，他是 admin 也按 leader 处理；未配置回退「该部门下 `role='manager'` 恰好 1 人」规则，0 个或多个都退回仅自己；manager 回退不按 `is_resigned` 过滤，离职区总/离职 admin 的历史数据仍可看）。**可见 admin = 全部 admin − 嵌入式 leader admin**：被 `REPORT_DEPT_LEADERS` 配置为 leader 且 role='admin' 的人（如李朝晖）从「admin 全员可见」中剔除，仅本区下属与 admin 可见。普通成员之间互不可见，区总（manager）之间互不可见。越权返回 403「无权查看该成员数据」。**运维约定**：未配置的子部门换区总时需把旧区总的 role 改回 staff，否则该区出现 2 个 manager 会导致全组退回「只看自己」；**已在 `REPORT_DEPT_LEADERS` 配置的子部门（当前：华南一部/华东昆山/华东宁波/华北一部/新品业务部）换区总时还需同步更新该环境变量**，否则旧区总会继续收到日报汇总推送、且仍作为该区 leader 对下属可见。前端选择器：staff 用精简 Select（数据源 `/dingtalk/console-members`，返回自己 + 本区 leader），manager/admin 用完整级联选择器。
- 管理功能：`/dingtalk` 同步运维类、`/upload-excel`、`/export/generate-reports`、`/export/generation-logs`、`/analytics/risk-summary/refresh`、`PUT /analytics/anomaly-weights`、`PUT /analytics/department-aliases`、`/analytics/init-department-aliases` 仅 admin；`/export/scope-report-to-doc` 限 admin/manager（可导任意范围）。`/export/console-report` 对所有角色开放，但数据范围按 ConsolePage 口径收敛，且只发送到当前登录用户的钉钉工作通知。

统一逻辑在 `backend/src/services/permission.ts`（`getVisibleUserIds`/`canViewUser`/`clampNodeForUser`/`isNodeInRange`）。`/users/*`、`/feedback` 维持原有权限逻辑。

### 时区约定

业务日期**统一按北京时间（Asia/Shanghai，UTC+8）**处理：

- 数据库存储为 `TIMESTAMPTZ`（UTC）。
- 钉钉解析时把北京时间字符串正确转 UTC 存储。
- 查询接口把前端传入的日期按 `+08:00` 解释。
- 转换逻辑集中在 `backend/src/services/utils/timezone.ts`。

### 业务日期（business_date）规则

`visits.business_date` 用于控制台、决策页、排行榜、趋势分析等所有聚合口径：

- Excel 数据：取每条 `visit.time` 的北京时间日期。
- 钉钉数据：**审批单级归日**——整张审批单的所有签到统一取该审批单**首次签到时间**的北京时间日期。即使审批单跨天（例如次日早上补一个收尾签到），所有签到也归到行程开始的那天，控制台一天只展示一次。

为什么不用审批单创建时间？钉钉审批单可能提前提交或事后补卡，创建时间与真实行程开始时间可能不一致；而「首次签到时间」就是行程真实开始的时刻。审批单创建时间仅作为 metadata 保留在 `raw_approvals` 中，用于和钉钉后台对账。

该口径与里程口径一致（按审批单首次签到日期聚合，见 `mileageAnalysis.ts`）。注意：早期曾按「每条签到实际时间」逐条归日（d402944），后在跨天审批单上与控制台展示、里程口径冲突，已统一为审批单级归日。

历史数据需要按此规则重算时，执行 `cd backend && npm run recompute:business-dates`（脚本只修正不一致的行，并对受影响的 user+date 自动重算 routes 与风险摘要缓存，支持 `dry` 预览）。

### 业务周口径（businessPeriod）

**业务周起点固定为 2026-06-01（周一）**，此后每 7 天一个业务周连续排下去，**不逐年重置**。因为 2026-06-01 是周一，业务周恒为「周一 ~ 周日」，2026 年内与周报所用的自然周完全重合。

锚点是两个同名常量，分别位于 `backend/src/utils/businessPeriod.ts`（`BUSINESS_WEEK_ANCHOR`，导出）和 `frontend/src/utils/businessPeriod.ts`（`BUSINESS_WEEK_ANCHOR`）。**改一处必须同步改另一处**，否则前端「本周/近两周/近三周」筛选与后端按周统计的区间会错开。

**不要把锚点改成「取日期所在年份的 6 月 1 日」**。那样每年 6/1 重新起算，而 6/1 的星期逐年漂移（2027-06-01 是周二），会导致：周边界漂成周二~周一；跨年处出现重叠周（2026-12-28 起的一周与 2026-12-29 起的一周重叠 5 天）；周序号每年重置且跨年变负数（2027-01-01 算成第 -21 周）。这是 2026-09-20 修掉的旧实现，不要改回去。

2026-06-01 之前无业务数据，负周序号不处理。

#### 两套时间口径刻意并存，禁止合并

系统里**同时存在两套周口径**，分界是「报告 vs 分析」，**不是**「前端 vs 后端」：

- **口径 A · 自然周（周一 ~ 周日）**——只服务报告与调度：周报触发（`scheduler.ts` 的 `getMillisecondsUntilWeekday(18,0,0)`，targetWeekday=0 即周日）、`reportGenerationService.generateWeeklyReports()` 默认的「本周一~今天」、catchup 补跑窗口、月报的自然月。**自然周的计算内联在 `scheduler.ts` 与 `reportGenerationService.ts`，不在 `businessPeriod.ts`。**
- **口径 B · 业务周（2026-06-01 锚点）**——只服务分析：异常检测「拜访量不足」按周判定（`anomalyDetection.ts`）、风险摘要周维度（`riskSummaryService.ts`）、驾驶舱业务周序号（`companyDashboard.ts`）、前端 `DecisionPage`/`ConsolePage` 的「本周/近两周/近三周」筛选。

易踩的坑：后端 `getLastWeekRange`、`getLastTwoWeeksRange`、`getLastThreeWeeksRange` 名字像自然周，**其实只是业务周的别名**（内部 `return getPastNBusinessWeeksRange(...)`）。

改动锚点或周边界属于口径变更，按上文「派生数据重算原则」处理：受影响的 `anomalies` 与 `risk_summary_cache` 需重算。

### 同客户高频拜访关注口径

统计「同一员工 × 同一客户」在时间段内的拜访次数，**仅展示，不落 anomalies 表、不计风险分**。阈值常量在 `backend/src/services/customerVisitFrequency.ts`（`FREQ_WEEK_THRESHOLD=2` 单业务周、`FREQ_MONTH_THRESHOLD=3` 单自然月，任一超出即 flagged；周 key 用业务周锚点，月 key 用北京时间 YYYY-MM）。只统计 `NOT exclude_from_visit_count` 且非 `exclude_from_stats` 用户的行；非 v2 行再叠加跨员工住址 + 公司地址过滤（`batchFilterHomeVisits`/`batchFilterCompanyVisits`）。客户名用 `splitRealCustomerNames`（拆分 + 过滤占位名），分组 key 为 `user_id + normalizeCustomerName(name)`。两个出口：`GET /analytics/customer-visit-frequency`（决策页「同客户高频拜访」榜单，总览口径不做角色收敛）与周报/月报的「高频拜访关注」章节（`wikiReportMarkdown.ts` 的 `renderFreqSection`，日报不渲染）。纯查询时计算，无派生数据落库，**改阈值只需改代码重启，不需要重算派生数据**。

### 定时任务

后端启动时注册以下定时任务（`backend/src/services/scheduler.ts`），均按北京时间每天执行：

1. **风险摘要缓存刷新**：每天凌晨 2:00 刷新「昨天」的 `risk_summary_cache`（写入已事务化）。历史日期读缓存时做新鲜度校验：缓存 `updated_at` 早于该日期最新 `visits.created_at`（补卡/迟到签到入库）即失效重算，避免不完整数据永久固化。
2. **钉钉审批同步**：每 3 小时同步最近 3 天（不含今天）的钉钉审批实例到 `visits`（未配置钉钉则跳过）。`syncApprovals` 进程内串行执行（互斥队列），防止并发同步绕过「先查再插」防重产生重复签到；写入侧另有 `visits` 部分唯一索引 `(approval_id, user_id, sequence)` + `ON CONFLICT` + 批内去重兜底，raw_visits 与 visits 同事务写入。同步成功后后台异步重算衍生数据：routes（事务内先算后换，规划失败的段保留旧数据）、stops（`computeAndPersistStops`）、风险摘要缓存。**锁定审批单**：`locked_approvals` 表中的 approval_id 在 `syncApprovals` 与 `syncRunningApprovals` 中整体跳过（不更新 raw_approvals、不解析、不触碰 visits），用于销售修改表单/等待重录期间保护数据；解锁 `DELETE FROM locked_approvals WHERE approval_id=...`，重录走 `scripts/reparseApproval.ts`（不受锁定影响）。
3. **同步健康告警**：同步异常照常写入 `dingtalk_sync_logs`（`checkAndSendAlerts()` 只记录日志、不再实时发群——8/19 起实时群告警下线，原因是 parse_failures 噪音 + 历史 WHERE 优先级 bug 导致刷屏）；查看入口为「同步健康」页面。每天早上 9:00 通过 `DINGTALK_EXPORT_ROBOT_WEBHOOK` 发送昨日同步健康摘要（一天一条）：昨日零同步日志按异常告警（调度器可能整天未运行），有问题列失败/缺失/重复/解析失败计数，正常日发简短心跳（区分「正常」与「告警通道故障」）。webhook 消息需带 `DINGTALK_EXPORT_ROBOT_KEYWORD` 关键词前缀（机器人安全设置）。`parse_failures > 0` 计入异常，但**已撤销（TERMINATED）和进行中（RUNNING）的审批单**解析出 0 条签到属预期、不计入；COMPLETED 单解析为 0 才是真异常。如需恢复实时群告警，把 `checkAndSendAlerts` 改回调用 `sendSyncAlertsDigestToDingTalk`（多条合并为一条）即可。
4. **用户对账**：每天凌晨 3:00 执行 `reconcileUsers()`（`userSyncService.ts`）：先同步钉钉通讯录，再把 visits 中出现的人 upsert 进 `users`（不覆盖 role；姓名优先取钉钉通讯录），并按通讯录快照标记/恢复 `is_resigned`（admin 永不自动改；未配置钉钉时降级为只做新增/更新，不标离职）。部门白名单：只纳入一级部门为「供应链管理部/销售部/产品部」的人，白名单外的非 admin 用户置 `is_invalid=true`（`/users` 接口不返回）；`is_invalid` 只置位、**不自动恢复**（恢复只能管理员手工改库，防止车辆误导入账号这类手工隐藏记录被每晚对账翻回来）。防误伤：近 30 天有签到记录的人即使不在通讯录快照也不自动标离职，记入结果的 `skippedRecentActive` 供人工复核。白名单判定**按人而非按单条部门值**：该 user_id 出现过的任一部门段（visits 里全部 department 值，逗号分隔逐段取一级部门）在白名单内即通过——「销售渠道-XX」与销售部无对应关系，不能直接映射，但该销售通常同时有「销售部-XX」的签到部门，按人看集合即可覆盖；对账后若 `invalidated` 非空，调度器立即通过群机器人发告警（账号被置 is_invalid 即无法登录，需管理员当天核实并手工恢复）。
5. **统计排除用户（`users.exclude_from_stats`）**：标记为 true 的用户可正常登录、只看自己的控制台（staff 口径天然满足），但其 visits 数据不进入任何聚合口径——company-dashboard、risk-summary 排行榜、mileage-distribution、regional-overview、org-tree/org-overview/排行榜/日周月报（经 `orgService`）全部按 `NOT EXISTS (SELECT 1 FROM users ux WHERE ux.user_id = visits.user_id AND ux.exclude_from_stats)` 排除；夜间对账完全跳过此类用户（不覆盖姓名/部门、不置 is_invalid、不标离职）。权限上他们通常为 admin（可看全部数据），但 `getPublicAdminUserIds` 会把 exclude_from_stats 用户从「全员可见 admin」中剔除——别人看不到他们的单人数据，仅自查。当前用于「陈列」「李杰」两人（2026-08-28 加入，部门置「其他」）。新增同类人员：`UPDATE users SET role='admin', department='其他', exclude_from_stats=true WHERE user_id='...'`。
6. **报告生成**：日报每天 9:00（生成昨天）、周报周日 18:00（生成本周一~当天）、月报每月 1 日 9:00（生成上月）。启动时补跑缺失的报告（`catchUpReportGeneration`，trigger_source 记 `catchup`）；单维度失败重试 1 次、不中断整个 run；每次 run 写入 `report_generation_logs` 并发一条汇总消息（优先走 `DINGTALK_EXPORT_CHAT_ID` 应用机器人 /chat/send，未配置时回退自定义机器人 webhook，webhook 受群安全关键词限制）。报告的客户数统计与客户拜访列表通过 `users.home_address`（`addressWhitelistService`）排除员工住址，并通过 `company_addresses` 表排除公司地址签到（对全体员工生效），拜访轨迹不受影响。客户列表最多展示 Top 50（钉钉文档 API 对内容大小有限制）。**个人日报消息推送**：定时任务（trigger_source=`scheduler`）的日报生成成功后推送钉钉消息——**优先走应用机器人单聊**（`/v1.0/robot/oToMessages/batchSend`，**必须走 `api.dingtalk.com` 域名**——误用 `oapi.dingtalk.com` 会返回 HTTP 200 + `{"errcode":404}` 旧版错误体，消息实际未发送且代码检查不到（2026-08-21 假成功事故）；`sendRobotMarkdownToUsers` 已同时检查 `code` 与 `errcode`。robotCode 默认取 `DINGTALK_APP_KEY`，可用 `DINGTALK_ROBOT_CODE` 覆盖；消息以机器人 1 对 1 会话出现在消息列表），失败自动回退工作通知（`DINGTALK_AGENT_ID`）：本人收个人版（拜访数/里程/异常数 + 自己日报链接，0 拜访也推）；区总/负责人每个层级只收**一条汇总**（只报「生成 N 份、成功 X、失败 Y、总拜访 Z 次」+ 其可见的第一层级入口链接：区总→该区日报、部门负责人→部门日报、「公司」配置人→公司日报，成员明细进 wiki 自行查看）。接收人解析：`REPORT_DEPT_LEADERS`（格式 `华南一部:李朝晖;软件产品线:洪晨备`，姓名按 `users.user_name` 解析，兜底查 `dingtalk_users` 通讯录缓存，也可直接配 userid）**配了就以配置为准**，未配置的子部门/部门回退为 role=manager 的用户；manual 不推；catchup 仅当补跑的是「昨天」的日报时才推（9:00 前部署重启时启动补跑会抢先生成昨天日报，若 catchup 一律不推则 9:00 定时任务会因「已生成」跳过、整天无人收到推送——8/19 案例）；发送失败不影响生成结果。

7. **CRM 摘要周报**：每周一 9:20（北京时间，避开 9:00 日报/整点任务）执行 `startCrmDigestScheduler` → `crmDigestService.sendCrmDigest`：生成 markdown 摘要（①公海挽回 Top 10 + 高阶段客户总数；②私海健康度预警 Top 5——掉保率最高且私海数 ≥ 10 的负责人；③阶段漏斗私海数一行速览，末尾注明 CRM 数据快照日期），经 `sendReportMessageToUsers`（机器人单聊优先、失败回退工作通知）推送。**灰度接收机制**：接收人只由环境变量 `CRM_DIGEST_RECIPIENTS`（逗号/分号分隔姓名或 userid，姓名按 `users.user_name` 解析、兜底 `dingtalk_users`、纯数字直接当 userid，复用 `resolveLeaderUserIds`）决定；**为空则任务完全不执行**（不生成内容，日志一行跳过）；解析不到的接收人只 warn 不中断。手动触发入口 `POST /crm-analytics/digest/send`（admin）。

### 同步数据校验

`dingtalk_sync_logs` 表记录了每次同步的对账信息，新增字段含义：

- `source_approval_ids_hash`：源端（钉钉）审批单 ID 集合的 MD5 hash。
- `db_approval_ids_hash`：落库后 `visits` 中对应审批单 ID 集合的 MD5 hash。
- `missing_count`：解析成功但库中缺失的审批单数。
- `duplicate_count`：库中 `approval_id + user_id + sequence` 重复记录数。
- `raw_visit_count`：本次同步写入 `raw_visits` 的数量。
- `alert_sent`：是否已发送告警。

校验逻辑集中在 `backend/src/services/syncCheckService.ts`。新增或维护钉钉同步相关代码时，应确保同步完成后调用 `checkAndSendAlerts()` 并正确更新 `dingtalk_sync_logs` 的对账字段。

### 钉钉双表单（v1/v2，2026-08-07 起）

新旧两套审批表单并存，**严格按 process_code 分流，不按表单中文名、不按日期**：

- v1 旧表单「用车里程登记&客户签到」：`DINGTALK_PROCESS_CODE`；v2 新表单「用车里程登记&拜访客户签到」：`DINGTALK_PROCESS_CODE_V2`（为空则只同步 v1）。同步时两个 code 分别 listids 轮询，`raw_approvals.process_code` 落库作为版本依据。
- 解析分发在 `parseApprovalInstance(instance, processCode)`：v2 走 `parseApprovalInstanceV2`（dingtalk.ts），v1 逻辑一行未改。两套映射输出相同的 `ParsedVisit` 字段、落同一张 `visits` 表，下游（控制台/报告/风险）无感知。
- v2 关键差异：客户名「拜访客户N」在打卡点**之后**（向后找，v1 是向前找）；拜访客户2~5 嵌在 TableField（取 `rowValue` 内 OpenDataField 的 `value`，多行=多客户）；未填写字段是 schema 回显 JSON 而非 null，必须显式判空；无逐段里程，填报总里程 = 终点读数 − 出发前读数（= 表单「今日出行总里程」）。`visit_note` 优先取表单 DDAIField「AI总结」按「总结内容N」拆块的内容（2026-08-06 表单新增），无值时兜底拼接 `沟通内容详情N`/`存在问题点N`；原始字段另存 `visits.visit_detail` JSONB（comm/issues/ai）供弹窗按 v2 字段名展示。
- **AI 总结延迟**：AI总结在审批单结束后才生成，而写入是「存在即跳过」——v2 重复行开放 `visit_note`/`visit_detail` 刷新通道（processParsedVisits，`IS DISTINCT FROM` 才写），其他字段不刷新。
- **里程读数异常（mileage_reading_invalid）v2 口径**（anomalyDetection.ts）：v2 单只判定起点（出发读数缺失）与终点（终点读数缺失/终点<出发/差值超限），途经点无读数不参与判定；RUNNING 中的 v2 单不判终点缺失（审批完成后才判）。v1 单维持逐点判定不变。「累计里程不一致」规则对 v2 天然不触发（v2 无逐段累计值），无需改动。
- **填报里程与里程偏差 v2 整单口径**（mileageAnalysis.ts）：v2 单只有出发前/终点两个里程读数，中间签到点无读数，逐段口径算不出。填报里程聚合（`computeMileageByApprovalForUsers`）与里程偏差（`computeMileageSegments`）对 v2 统一走整单：填报 = 终点读数 − 出发前读数（读数缺失兜底取单内最大填报里程），高德 = 单内各段 routes 之和，任何一段路线缺失则整单跳过。v1/Excel 维持逐段口径不变。
- **拜访计数口径分流**（`ParsedVisit.form_version='v2'`）：v2 按「出行方式 × 客户名称」逐个判定——真实客户名数为 0（空或全部为占位名）→ `exclude_from_visit_count=true`，不看地址；有真实客户名即使在住址/公司/酒店也算拜访；混合填写真实客户照计。占位判定分两层（normalization.ts）：子串模式 `PLACEHOLDER_CUSTOMER_PATTERN` = `/虚拟|签到用|住址|住所|住处|回家|到家|在家|家里|加油/`（2026-08-10 起模糊识别手写住址类字眼，不匹配单独的「家」字防误伤「厂家」等；2026-09-23 加「加油」排除加油站打卡），叠加整词模式 `GENERIC_PLACE_PATTERN` = `/^(回|返|在|到|去|住|于)?(公司|酒店|宾馆)(开会|办公|加班|休息|住宿|驻点|值班|签到|办事|培训)?$/`（2026-09-23 起排除手写「公司」「酒店」类泛化地点词；必须整词匹配，子串「公司」会误伤「XX有限公司」等真实客户名）；改这两层模式后需重跑 `backfill:visit-exclusion` 刷新存量打标。v1/Excel 仍走住址+公司地址白名单（纯地址制，不看客户名）。`backfillVisitExclusion` 脚本同样按此分流。
- **一个打卡点 N 家客户 = N 次拜访**：`visits.customer_count`（v2 按客户数写；v1/Excel 按 customer_name 分隔符 `[,，、]` 拆分计，空名单值按 1；存量用 `npm run backfill:customer-count` 回填）。「拜访次数」类统计一律 `SUM(customer_count)`，不要用 `COUNT(*)`；「客户数」类统计用 `splitCustomerNames`（normalization.ts）拆分去重，不要在 SQL 里 LATERAL 展开（会让同行其他聚合翻倍）。
- 旧表单停用时清空 `DINGTALK_PROCESS_CODE` 即可，v1 解析代码保留用于历史重跑。详见 PLAN.md Step 3.6。

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
# 扫码登录复用这对 Key/Secret 作为 clientId/clientSecret
DINGTALK_APP_KEY=YOUR_DINGTALK_APP_KEY
DINGTALK_APP_SECRET=YOUR_DINGTALK_APP_SECRET
DINGTALK_PROCESS_CODE=YOUR_DINGTALK_PROCESS_CODE
# 新审批表单（v2「用车里程登记&拜访客户签到」）process_code；为空则只同步旧表单
DINGTALK_PROCESS_CODE_V2=

# 钉钉扫码登录允许的前端回调 origin（逗号分隔），回调地址为 <origin>/login/callback
DINGTALK_LOGIN_ALLOWED_ORIGINS=http://localhost:5173,http://8.219.97.3:5173

# 应急密码登录通道（管理员），生产建议关闭
AUTH_PASSWORD_LOGIN_ENABLED=false

# 旧的 X-User-Id 信任头回退：仅限本地开发过渡，生产必须保持 false
AUTH_HEADER_FALLBACK=false

# 钉钉文档（知识库）导出操作人 user_id
# 需要是该企业内的真实钉钉用户，用于调用钉钉文档 API 创建文档、文件夹并授权
DINGTALK_OPERATOR_USERID=

# 可选：钉钉文档知识库名称，不填则默认为「外勤行为分析报告」
DINGTALK_DOC_WORKSPACE_NAME=

# 控制台导出报告目标钉钉群 chatid
DINGTALK_EXPORT_CHAT_ID=

# 可选：自定义机器人 webhook，用于发送文字摘要
DINGTALK_EXPORT_ROBOT_WEBHOOK=

# 钉钉企业内部应用 AgentId，用于 ConsolePage「导出到我的工作通知」
DINGTALK_AGENT_ID=YOUR_DINGTALK_AGENT_ID

# 自建 LLM 拜访总结（OpenAI 兼容，默认 DeepSeek；不配置则维持原始兜底文本）
LLM_API_KEY=
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# CRM 摘要周报接收人（灰度）：逗号/分号分隔的钉钉姓名或 userid（如 程丽敏）
# 姓名按 users.user_name 解析，兜底 dingtalk_users，纯数字直接当 userid
# 为空则每周一 9:20 的 CRM 摘要推送完全不执行
CRM_DIGEST_RECIPIENTS=
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
| GET | `/visits/synced-dates` | 钉钉同步已成功覆盖的日期列表（全局口径，所有登录角色可读；前端日历轴据此把「已同步但无数据」的日期置灰展示，与「未同步」区分） |
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
| GET | `/analytics/customer-visit-frequency?start=&end=` | 同客户高频拜访关注清单（仅 flagged 条目，最多 100 条 + flaggedCount） |
| GET | `/analytics/departments` | 规范部门列表 |
| POST | `/analytics/init-department-aliases` | 初始化部门别名映射 |
| GET/PUT | `/analytics/department-aliases` | 部门别名 CRUD |
| GET/POST | `/dingtalk/*` | 钉钉同步相关接口（含 `/sync-logs`、`/sync-health`、`/sync-alerts`、`/sync-force`） |
| GET | `/data-lineage/approvals` | 数据血缘：审批单分页列表（含签到点数、质量问题计数） |
| GET | `/data-lineage/approvals/:id` | 数据血缘：单张审批单 原始表单→重新解析→已入库 三步对照 |
| GET/POST/PUT/DELETE | `/users/*` | 用户管理（GET 返回 `last_visit_date`，按角色过滤：admin 全量 / manager 本部门含子部门 / staff 仅自己） |
| POST | `/users/sync` | 手动触发用户对账（admin），body `{ dryRun?: boolean }`，dryRun 只预览不写库 |
| GET/POST/PUT | `/feedback/*` | 反馈申诉 |
| POST | `/export/console-report` | 导出控制台报告并发送到当前登录用户的钉钉工作通知 |
| POST | `/export/console-report-to-doc` | 导出控制台报告到钉钉文档知识库（三级结构） |
| POST | `/export/generate-reports` | 手动触发日/周/月报生成（trigger_source 记 `manual`） |
| GET | `/export/generation-logs` | 报告生成日志（page/pageSize 分页，report_type/status/start/end 筛选） |
| GET | `/crm-analytics/overview` | 客户分析总览：总数、私海/公海、未跟进占比、审批中、30 天新增、按 customer_type 分布、`snapshot_date`（最近一次手工导入批次时间）（聚合口径，登录角色全量可见） |
| GET | `/crm-analytics/cross?type=follow_only\|visit_only\|both\|unmatched&page=&pageSize=` | 客户×拜访交叉：只跟不访/只访不跟/都有 三个计数 + `unmatched_count` 待确认桶 + 分页明细（行级按可见负责人收敛）。匹配分三层（见下文「CRM 交叉匹配口径」） |
| GET | `/crm-analytics/wordcloud` | 跟进纪要词频 `[{word,count}]`（领域词典匹配 + 高频二元组补充，Top 200） |
| GET | `/crm-analytics/opportunity-map` | 客户地址分布：坐标（可能为 null）+ 拜访次数 + `pending_count`/`failed_count`；每次请求限流新解析 30 条坐标（优先从未解析的，失败的 attempts<5 可重试），前端可轮询补全 |
| GET | `/crm-analytics/stuck?kind=approval_stuck\|zombie&page=&pageSize=` | 审批卡死（审批中超 7 天）+ 躺尸客户（私海超 30 天未跟进**且近 30 天无实际拜访**）计数与分页明细（明细含 `last_visit_time`） |
| GET | `/crm-analytics/recovery-list?stage=&owner=&page=&pageSize=` | 公海挽回清单（仅 admin）：公海且 follow_status 为高阶段（方案/报价/已发合同/合同回传/付款/发货/已经交付）的客户明细，按「离成交最近」阶段权重 + return_pool_time 倒序；含 total 与按阶段分组计数 summary（summary 不受筛选影响） |
| GET | `/crm-analytics/pool-health` | 私海健康度（聚合口径，登录可见）：顶部全公司汇总 + 按负责人（私海 owner_name）汇总私海数/零跟进数/30 天无跟进数/历史被掉保数（按 last_owner）/掉保率，按掉保率降序 |
| GET | `/crm-analytics/funnel` | 阶段漏斗（聚合口径，登录可见）：follow_status 分组计数 × 公私海拆分（空值归「无阶段」桶），带 snapshot_date |
| POST | `/crm-analytics/digest/send` | 手动触发 CRM 周报推送（仅 admin），接收人由 `CRM_DIGEST_RECIPIENTS` 配置，返回接收人/成功解析/解析失败列表；未配置时 skipped=true 不发送 |

### CRM 交叉匹配口径（cross / stuck 共用）

visits 客户名 → CRM 客户的匹配在 `backend/src/routes/crmAnalytics.ts` + `backend/src/services/customerMatch.ts`，查询时计算、无派生落库：

- visits 侧客户名先用 `splitRealCustomerNames` 过滤占位名（「虚拟客户」「住址（签到用）」等），占位名不计入任何拜访计数；保持「一个打卡点 N 个真实客户 = N 次拜访」。
- 匹配三层：① `name_norm` 精确匹配；② 规则归并——a) 去尾部「分公司/子公司/分厂/办事处/营业部」分支后缀再精确匹配，b) 双向包含（一方包含另一方且较短者长度 ≥ 4，取最长候选，并列最长视为歧义不归并）；③ 仍对不上 → 「待确认」桶（`type=unmatched`），**不计入** follow_only/visit_only/both 三个结论数字，沿用拜访人可见性收敛。
- 躺尸判定复用同一归并口径：CRM 客户近 30 天内有 visits 拜访（`NOT exclude_from_visit_count`）则不算躺尸；明细行带 `last_visit_time`（无拜访为 null）。
- 机会地图地理编码失败可重试：`crm_customer_geocode` 有 `attempts`/`last_attempt_at` 字段，每次失败 attempts+1，≥ 5 不再重试；响应 `failed_count`（attempts≥5 且无坐标）与 `pending_count`。
| GET | `/analytics/customer-visit-frequency?start=&end=` | 同客户高频拜访关注清单（仅 flagged 条目，总览页口径：全角色可见，不做权限收敛） |

前后端代理路径：

- 开发环境：Vite 把 `/api/*` 代理到 `http://localhost:3000/`，并去掉 `/api` 前缀。
- 生产环境：Nginx 把 `/api/*` 代理到 `http://backend:3000/`，并去掉 `/api` 前缀。
- 后端 Express 路由直接挂在根路径，例如 `/visits`。

### 同客户高频拜访口径

「同一员工 × 同一客户」频次统计仅作管理关注展示，**不落 anomalies、不计风险分**。核心逻辑在 `backend/src/services/customerVisitFrequency.ts`（`computeCustomerVisitFrequency`，阈值常量 `FREQ_WEEK_THRESHOLD=2` 单业务周 / `FREQ_MONTH_THRESHOLD=3` 单自然月，任一超过即 flagged）。口径：`NOT exclude_from_visit_count` + 非 v2 行叠加跨员工住址/公司地址过滤；客户名 `splitRealCustomerNames` 展开（过滤占位名）+ `normalizeCustomerName` 归并分组；决策页接口额外排除 `users.exclude_from_stats`。两个出口：决策页「同客户高频拜访」卡片（`DecisionPage.tsx`），以及周报/月报的「高频拜访关注」章节（`wikiReportMarkdown.ts` 的 `renderFreqSection`，日报不渲染）。纯查询时计算，无派生落库，改阈值不需要重算历史数据。

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

生产环境推荐使用仓库里的 `docker-compose.ghcr.yml` 直接拉取 GHCR 镜像，服务器上不需要 git，也不需要本地编译。详细步骤见 `DEPLOY.md`。

关键点：

- `.env` 中必须包含 `GHCR_OWNER` 和 `AMAP_KEY`（高德 Web 服务 Key）。
- GHCR 镜像如果是私有的，需要先用 `docker login ghcr.io` 登录（Token 需要 `read:packages`）。
- 如果服务器上已有 postgres 数据，但初始化时的密码不是 `sales123`，后端会报 `password authentication failed`。修复：
  ```bash
  docker exec -i sales-map-postgres psql -U sales -d sales_map -c "ALTER USER sales WITH PASSWORD 'sales123';"
  docker compose -f docker-compose.ghcr.yml up -d --force-recreate backend
  ```
- `scripts/deploy.sh` 每次都会生成随机数据库密码并覆盖 `docker-compose.yml`，仅适合**首次全新部署**；服务器上已有数据后不要使用，请按 `DEPLOY.md` 操作。

更新代码后重新部署：

```bash
cd /root/sales-map
docker compose -f docker-compose.ghcr.yml pull backend frontend
docker compose -f docker-compose.ghcr.yml up -d
```

查看日志：

```bash
cd /root/sales-map
docker compose -f docker-compose.ghcr.yml logs -f backend
docker compose -f docker-compose.ghcr.yml logs -f frontend
docker compose -f docker-compose.ghcr.yml logs -f postgres
```

## 安全注意事项

1. **不要把真实 Key 提交到仓库**：`AMAP_KEY`、`VITE_AMAP_KEY`、钉钉 `APP_SECRET`、`GITHUB_TOKEN` 等敏感信息只应出现在 `.env`、GitHub Secrets 或服务器环境变量中。`.gitignore` 已排除 `.env`、`.env.local`。

2. **部署脚本问题**：`scripts/deploy.sh` 中硬编码了 `AMAP_KEY` 和服务器 IP，且每次运行都会生成随机数据库密码。它只适合首次全新部署；服务器上已有 postgres 数据时直接运行会导致后端连不上数据库。有数据后请按 `DEPLOY.md` 使用 `docker-compose.ghcr.yml` 部署。

3. **认证已改为 session token**：钉钉扫码登录签发 `auth_sessions` token（7 天）。旧的 `X-User-Id` 信任头仅在 `AUTH_HEADER_FALLBACK=true` 时可用——生产环境绝不能开启，否则任何人知道用户 ID 就能模拟身份。

4. **上传目录安全**：`backend/uploads/` 存放上传的 Excel 临时文件，文件名由 multer 随机生成。生产环境建议定期清理，并限制上传文件大小与类型。

5. **SQL 注入防护**：后端使用参数化查询（`pg` 的 `$1, $2` 占位符），不要拼接 SQL 字符串。

6. **CORS**：后端当前使用 `app.use(cors())` 允许所有来源。生产部署时应限制为前端域名。

7. **地理编码兜底精度低**：未配置 `AMAP_KEY` 时使用内置城市坐标表加随机抖动，不适合高精度场景。

## 已知问题与注意事项

- `backend/schema.sql` 与 `backend/src/db.ts` 不同步，实际 schema 以 `db.ts` 为准。
- **v2 行的 `visit_note`/`visit_detail.ai` 现由自建 LLM 总结生成**（`llmSummaryService.ts`，OpenAI 兼容接口，`LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` 走环境变量，默认 DeepSeek），替代已失效的钉钉 DDAIField「AI总结」字段；同步成功后经 `recomputeDerivedDataForVisits` fire-and-forget 补写。未配置 key 或调用失败时维持原始兜底拼接（「沟通内容：...；存在问题：...」），存量回填执行 `cd backend && npm run backfill:ai-summary`（`--dry` 预览）。回写时保留 visit_note 末尾的里程备注后缀（如「[缺少终点里程读数]」）。
- 权限系统已完成收口（见「认证方式」章节）：核心接口均按角色过滤数据，越权返回 403。
- 部门名称通过 `department_aliases` 表规范化，当前有 10 个规范部门/分组。
- **部门归一化（查询时生效，不回填数据）**：部分销售挂在钉钉「销售渠道-华南区域 / 销售渠道-江苏区域 / 销售渠道-浙江区域」顶层渠道部门下，业务主部门是「销售部-华南一部 / 华东昆山 / 华东宁波」。`visits.department` 保留原始值，所有组织归属/聚合/级联选择器口径在查询时归一化：第一段部门名命中 `department_aliases` 且 `canonical_name` 非空时，映射为「销售部-canonical」（canonical 本身含 `-` 则原样），否则保持原始第一段。统一入口在 `departmentAliasService.ts`（JS 侧 `normalizePrimaryDepartment` + `loadDepartmentAliasMap`，SQL 侧 `normalizedPrimaryDeptSql` + `departmentAliasJoinSql`）；`orgService`（组织树/归属多数派/排行榜分组）、`userSyncService.fetchVisitUsers`（users.department 归属）、`companyDashboard`（词云/雷达）、`buildDingTalkOrgTree`（级联选择器树，归一化后补挂到主部门节点）均走该口径。「销售渠道」顶层黑名单（`EXCLUDED_TOP_DEPARTMENTS`）继续保留，归一化后自然不再命中。别名配置脚本：`cd backend && npm run alias:sales-channels`（幂等写入三条 销售渠道-X区域 → 主部门 映射）。纯查询时归一化，改别名配置不需要重算派生数据。
- 风险摘要缓存策略：历史日期优先读 `risk_summary_cache`，今天及以后实时计算。
- 钉钉表单中的 `累计里程N` 是截至本次签到的累计值，系统统计时应按 `approval_id` 取 `MAX(reported_distance_km)`，不能直接 `SUM`。
- 路线计算已按 `approval_id` 分组，控制台地图支持按审批单切换视图。
- 里程读数异常上限通过环境变量 `MILEAGE_VALIDATION_MAX_KM`（后端）和 `VITE_MILEAGE_MAX_KM`（前端）配置，默认 5000 km。
- 钉钉审批同步的 `originator_user_name` 可能为空，导致 `visits.user_name` 写入数字 userid。`userSyncService` 每日对账时会按「钉钉通讯录姓名 > visits 最近姓名」的优先级自动修正 `users.user_name`；`visits` 表里的历史姓名可通过 `backend/scripts/fixUserNames.ts` 修复：在职员工调用 `topapi/v2/user/get`，已离职员工回退到智能人事花名册 `topapi/smartwork/hrm/employee/list`，并自动标记 `users.is_resigned=true`。
- 车辆/油卡/油耗模型（Step 4）已暂缓，相关表结构在 `PLAN.md` 中有设计但未实现。
- 月维度数据导出（Step 5）尚未实现。
- 员工住址（`users.home_address`）用于异常检测和报告客户列表的住址排除。报告口径是**跨员工排除**：命中任何一位员工的住址（文本匹配或 500 米坐标半径）都不算客户（例如出差留宿在同事家小区）；异常检测仍按拜访人自己的住址匹配。**v2 表单例外**：v2 行的 `exclude_from_visit_count` 已包含「客户名 × 地址」完整判定（真实客户名即使在住址/公司打卡也算拜访），报告层（`reportGenerationService.ts`、`/export/console-report-to-doc`）的住址/公司地址过滤只作用于 v1/Excel 数据，v2 行不参与地址二次排除（2026-08-14 修复：否则 v2 真实客户在公司地址打卡会被误排，日报显示 0 拜访）。住址来源是线下收集的《国内业务人员常住地址》Excel（姓名 + 地址两列即可），通过 `backend/scripts/importEmployeeAddresses.ts` 导入：`cd backend && npx ts-node scripts/importEmployeeAddresses.ts /path/to/employee_addresses.xlsx`。脚本是幂等 UPDATE，Excel 有更新（新人入职、地址变更）时改完重跑即可；仅当员工在 `users` 或 `visits` 中已有记录才能匹配写入（新入职未产生签到数据的人会在产生数据后下次导入时补上）。目前仅覆盖业务人员，非业务部门按业务决定不收集。
- 住址坐标持久化：导入/回填时把住址一次性地理编码存入 `users.home_lat/home_lng`，匹配时优先用坐标半径（500 米），不再依赖运行时实时解析高德（运行时解析曾遇限流导致整批漏过滤）。存量数据回填：`cd backend && npm run backfill:home-coords`（`--force` 全部重解析）。地理编码带回退简化（逐级截掉 幢/栋/单元/室 尾缀重试）；仍失败的记录按脚本提示人工核实坐标写入 `address_fallback_coordinates` 表后重跑（注意：高德「解析成功但位置跑偏」的情况兜底表不会生效，需直接 UPDATE users 的 home_lat/home_lng）。
- 公司地址白名单：`company_addresses` 表（名称 + 地址 + 坐标），报告客户统计与异常检测（重复签到，见 `anomalyDetection.ts` 的 `filterExcludedVisits`）都会对全体员工排除命中公司地址的签到。维护：`cd backend && npm run upsert:company-address -- "创维数字大厦" "广东省深圳市宝安区石岩街道创维数字大厦"`（重复执行按 address upsert）。已知公司地址两处：①深圳创维数字大厦（小胖峰/丹弗，已入白名单）；②苏州小胖峰（2026-09-23 业务确认存在，**暂不加入白名单**，待业务通知后再 upsert）。
- 拜访次数统计口径：`visits.exclude_from_visit_count` 标记命中**员工本人住址**或**公司地址白名单**的签到，全系统「拜访次数」类统计（决策页总拜访/趋势/活跃度/部门人均、控制台拜访频率/人均/排行榜/拜访点数、风险摘要 visit_count、日周月报与导出报告）统一加 `AND NOT exclude_from_visit_count` 过滤；**不影响**轨迹展示、停留点、里程与异常检测（「拜访量不足」规则刻意保持原口径，待重新设计）。打标时机：新数据在 `processParsedVisits` 入库时自动打标；存量与住址/公司地址变更后需重跑 `cd backend && npm run backfill:visit-exclusion`（幂等全量重打标，`--dry` 预览，同时修正 `risk_summary_cache.visit_count`）。

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
