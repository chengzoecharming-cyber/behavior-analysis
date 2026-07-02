# 销售外勤行为分析系统 - 开发计划

> 最后更新：2026-07-02
> 当前重点：P0 热修复——时间轴语义统一、权限收口、里程口径修正。

## P0 热修复（当前冲刺）

### 背景

接入真实数据后发现，系统存在两类阻断性风险：

1. **时间轴语义不统一**：Excel 日期解析异常、部分代码未按北京时间处理业务日期、前端日期选择器受浏览器时区影响，导致"选 7 月 1 日查不到数据"、"风险摘要算错日期"、"工作日/周末误判"。
2. **权限系统未收口**：大量核心业务接口未挂载认证与角色过滤，存在数据泄露和越权操作风险。

这两类问题不解决，后续所有分析功能都建立在不可信的数据和不受控的访问之上。

---

### P0-1 时间轴语义统一

#### 产品目标

> 定义并落地「业务时间契约」：**任何无显式时区的日期/时间字符串，统一按 Asia/Shanghai（UTC+8）解释；数据库继续以 UTC 时间戳存储；前端日期选择器反映业务日期，而非浏览器本地日期。**

#### 核心原则

| 原则 | 说明 |
|---|---|
| 业务日期唯一解释 | `2026-07-01` = 2026-07-01 00:00:00 +08:00，不受服务器/浏览器时区影响 |
| 数据库统一存 UTC | 使用 `TIMESTAMPTZ`，写入前完成 +08:00 → UTC 转换 |
| 前后端参数简化 | 前端传 `YYYY-MM-DD`，后端按 +08:00 解释 |
| 工作日按北京时间 | 周末/工作日判断基于 Asia/Shanghai 的星期几 |

#### 任务拆分

- [x] **T1. Excel 日期解析标准化**
  - 修复 `services/normalization.ts:25-30`：`XLSX.SSF.parse_date_code` 返回对象而非 `Date`，需显式转换为 JS `Date`
  - 验收：所有 Excel/钉钉导入记录的 `timestamp` 为有效 UTC 时间戳

- [x] **T2. 坐标缺失/无效防御**
  - 修复 `routes/upload.ts` / `services/normalization.ts`：`parseFloat("")` 会产生 `NaN` 且 `NaN ?? 0` 不触发 fallback
  - 验收：`visits.lat` / `visits.lng` 无 `NaN`；无效记录标记 `geocode_status='failed'` 并可进入"待修正坐标"列表

- [x] **T3. 地理编码兜底策略修正**
  - 修复 `services/geocoding.ts`：移除随机抖动；高德失败时查询 `address_fallback_coordinates` 兜底地址表；仍失败返回 `null`
  - `visits.lat` / `visits.lng` 改为可空，不再入库 `0,0`
  - 下游 `stopDetection`、`routePlanning`、`anomalyDetection` 均跳过/防御 `null` 坐标
  - 验收：同一地址多次 geocode 返回同一结果；无效地址坐标为 `null` 并标记 `geocode_status='failed'`

- [x] **T4. 后端查询接口时区统一**
  - 扫描并修复 `routes/visits.ts`、`routes/stops.ts`、`routes/routes.ts`、`routes/analytics.ts`、`routes/riskSummary.ts`、`routes/dingtalk.ts`
  - 替换所有 `new Date(dateStr)` / `getDay()` 等本地时区依赖，统一使用 `services/utils/timezone.ts`
  - 验收：服务器无论部署在何种时区，按 `start`/`end`/`date` 查询的结果一致

- [x] **T5. 计算逻辑时区统一**
  - 修复 `services/anomalyDetection.ts`、`services/riskSummaryService.ts`、`services/scheduler.ts`
  - 工作日判断、日期格式化、定时任务调度全部基于北京时间
  - 验收：定时任务在北京时间每天 02:00 / 02:30 触发；周末异常不误判

- [x] **T6. 前端日期组件时区统一**
  - 全局配置 `dayjs.tz.setDefault("Asia/Shanghai")`
  - 修复 `ConsolePage.tsx`、`MapPage.tsx`、`DecisionPage.tsx`、`FeedbackPage.tsx`、`DataSyncPage.tsx`、`MapContainer.tsx` 中的日期格式化
  - 验收：浏览器不在东八区时，选择"2026-07-01"仍查询北京时间的 2026-07-01

- [x] **T7. 历史脏数据清洗**
  - 编写 `backend/scripts/cleanHistoricalData.ts` 一次性脚本，幂等执行
  - 自动修复：负里程 → NULL、`anomalies.anomaly_date` 缺失 → 按北京时间推断
  - 分类报告：`routes` 零距离 18 条、`visits` null 坐标 3 条（预期状态）
  - 报告已保存：`backend/clean-report-2026-07-01.json`
  - 验收：核心表无负里程、无缺失业务日期；剩余异常项均为预期状态或待人工复核

---

### P0-2 权限系统收口

#### 产品目标

> **"数据范围"必须与"用户身份"绑定：staff 仅看自己，manager 看本部门，admin 看全部；写操作仅对 admin/manager 开放。**

#### 角色权限矩阵

| 角色 | 数据范围 | 可读接口 | 可写操作 |
|---|---|---|---|
| admin | 全部 | 全部 | 全部 |
| manager | 本部门员工 | 全部（按部门过滤） | 上传 Excel、部门别名维护、钉钉同步、规则配置 |
| staff | 仅自己 | `/visits`、`/stops`、`/routes`、`/analytics/*`（仅自己） | 提交申诉反馈 |

#### 任务拆分

- [ ] **P2-1. 后端路由统一认证**
  - 为 `/analytics/*`、`/visits/*`、`/routes/*`、`/stops/*`、`/upload-excel`、`/dingtalk/*` 挂载 `authMiddleware`
  - 验收：无 `X-User-Id` 请求头时返回 `401 Unauthorized`

- [ ] **P2-2. 后端数据范围过滤**
  - staff：`user_id = 当前用户`
  - manager：`department = 本部门` 或 `user_id` 在下属列表
  - admin：无限制
  - 验收：staff 通过 `?user=他人` 访问时返回 `403` 或空结果

- [ ] **P2-3. 写操作角色限制**
  - 上传 Excel、修改异常权重、初始化部门别名、钉钉同步、刷新风险摘要缓存 仅 admin/manager
  - 验收：staff 调用写接口返回 `403 Forbidden`

- [ ] **P2-4. 前端菜单与路由守卫**
  - `App.tsx` 按 `currentUser.role` 过滤 `navItems`
  - 无权限页面重定向或显示"无权限"
  - 验收：staff 看不到"规则配置"、"数据同步"、"用户管理"等入口

- [ ] **P2-5. 前端组件级权限**
  - 按钮、卡片、下钻链接按角色禁用或隐藏
  - 验收：staff 无法点击他人下钻链接，无法访问管理功能

---

## 已上线

### Phase 1：数据治理 + 控制台增强

- ✅ 1A 钉钉宽表解析 & 数据模型扩展
- ✅ 1B 批量地理编码 + 失败 fallback + 手动坐标修正接口
- ✅ 1C 里程对比分析 + 新增异常类型
- ✅ 1D Dashboard 合并地图轨迹 + 决策系统下钻

### Phase 2：可配置权重后台 + 行为评分

- ✅ 创建 `anomaly_weights` 配置表并初始化 8 条规则
- ✅ 后端权重 CRUD 接口
- ✅ `detectAnomalies` 读取权重配置
- ✅ 风险评分接口与决策系统排序
- ✅ 前端「规则配置」页面

### 数据质量修复

- ✅ Excel 重复导入去重
- ✅ 清理历史重复/mock 数据
- ✅ 地图点位防御性去重

### Dashboard UI/UX 优化

- ✅ 异常事件结构化展示
  - 涉及两地（mileage_deviation / route_detour）显示为 `A → B` 标题
  - 副标题显示 `填报 xx km vs 高德 xx km · 偏差 xx%`
  - 风险等级 tag 位于文字左侧
  - 后端 `anomalies` 表新增 `metadata` JSONB 字段
- ✅ 日期选择自动填充第一个可用日期，仍需点击「查询」加载
- ✅ 统计卡片调整
  - 「总里程 vs 估算里程」卡片移到第二行
  - 总里程 = 用户填报里程
  - 估算里程 = 高德路线规划里程
  - 无填报时显示「未填报」
- [ ] 字段命名待讨论：「停留点数」「停留时长」是否改名或移除

### Step 1：查询优化

- ✅ 数据库索引（visits / stops / routes / anomalies / risk_summary_cache）
- ✅ 新建 `risk_summary_cache` 预计算缓存表
- ✅ 每日凌晨 2 点定时任务增量计算前一天缓存
- ✅ `/analytics/risk-summary` 历史日期优先读缓存，今天实时计算
- ✅ 决策系统默认展示昨天数据
- ✅ 路线规划结果已持久化到 `routes` 表，缺失时补算

### Step 2：Date Range 支持

- ✅ 决策系统增加快捷筛选：今天 / 昨天 / 本周 / 本月 / 自定义
- ✅ 本周/本月默认不包含今天；自定义范围含今天时给出提示
- ✅ 新增 `/analytics/risk-summary/range` 基于日缓存聚合
- ✅ Dashboard 日期选择器改为 RangePicker，默认昨天单日
- ✅ 后端 `/stops`、`/routes`、`/analytics/mileage`、`/analytics/anomaly` 支持 `start` + `end`
- ✅ 员工卡片下钻链接携带 `start`/`end`，Dashboard 可按范围加载

---

## 待开发

---

### Step 3：钉钉 API 自动接入

#### 前置条件

- ✅ 钉钉开放平台企业内部应用
- ✅ `appKey` / `appSecret`
- ✅ 审批模板 ID（`process_code`）
- ✅ 「OA 审批管理」权限 `qyapi_aflow`
- ✅ 「通讯录读取」权限（用于反查 user_name，可见范围需覆盖全部员工）

#### 已搭建框架

- ✅ AccessToken 获取与内存缓存（`backend/src/services/dingtalk.ts`）
- ✅ 拉取审批实例列表（`topapi/processinstance/listids`）
- ✅ 拉取审批实例详情（`topapi/processinstance/get`）
- ✅ 新增 `raw_approvals` 表保存完整审批实例原始 JSON
- ✅ 专用解析器处理「用车里程登记&客户签到」多段行程表单
  - 一条审批拆成多个 visit 点
  - 从车辆字段提取用户名/车牌
  - 通过 `topapi/v2/user/get` 反查真实姓名
  - 跳过公共交通出行记录
- ✅ 手动同步接口 `POST /dingtalk/sync`
- ✅ 连接测试接口 `GET /dingtalk/test`
- ✅ 状态查询接口 `GET /dingtalk/status`
- ✅ 根据模板名称反查 `process_code` 接口 `GET /dingtalk/discover`
- ✅ 每日凌晨 2:30 定时同步任务
- ✅ 前端「数据同步」页面（/sync）
- ✅ 环境变量模板（`backend/.env.example`）

#### 待完成 / 已知问题

- [ ] 通讯录可见范围生效后，公共交通记录的真实姓名会自动补全
- [ ] 根据实际表单使用一段时间后再微调解析规则（如客户名称、特殊签到）
- [ ] 从钉钉同步用户/部门信息到 `users` 表（可选，目前从 visits 聚合用户）

---

### Step 3.5：钉钉同步后的数据修复与质量治理（当前重点）

接入真实钉钉数据后发现的问题：

#### 3.5.1 时区统一（高优先级）

- **问题**：数据库存 UTC，但钉钉返回北京时间；前后端部分接口按 UTC、部分按 `+08:00` 查询，导致选日期后内容为空、地图不显示、缓存算空。
- **方案**：所有时间统一按 **北京时间（Asia/Shanghai）** 处理。
  - 钉钉解析时把北京时间字符串正确转 UTC 存储
  - 所有查询接口把前端传入的日期按 `+08:00` 解释
  - 清空 `risk_summary_cache`，按新规则重新预计算
- **任务**：
  - [x] 统一后端 `/visits`、`/routes`、`/stops`、`/analytics/*` 的时区处理（初版）
  - [x] 统一前端日期传参格式（后端已兼容，前端保持 `YYYY-MM-DDTHH:mm:ss` 无 tz 格式）
  - [x] 清空并重建风险摘要缓存（2026-06-17 / 18 / 26 已重算）
  - [ ] **待收口**：仍有 `new Date(dateStr)` / `getDay()` / 前端 `dayjs()` 本地时区依赖（详见 P0-1 时间轴语义统一）

#### 3.5.2 用户去重（中优先级）

- **问题**：`/visits/users` 按 `(user_id, user_name, department)` 去重，同一人 department 不同导致下拉框重复。
- **方案**：按 `user_id` 去重，department 取最常出现的组合。
- **任务**：
  - [x] 修改 `/visits/users` 去重逻辑（`ROW_NUMBER` 取每组出现次数最多的一条）
  - [x] 下拉框 label 只显示 `user_name`，部门作为副标题展示

#### 3.5.3 清理旧脏数据（中优先级）

- **问题**：历史同步残留 4 条 `reported_distance_km` 为负数的记录（如季昕亚 -187920），导致总里程异常。
- **方案**：
  - 删除或修正这 4 条旧记录
  - 统计时过滤负数里程
- **任务**：
  - [x] 定位并修复负里程记录（已置 NULL）
  - [x] 在 `/analytics/mileage` 加防御性过滤（仅累加大于 0 的值）

#### 3.5.4 Dashboard 与控制台定位区分（已完成 V2）

- **决策系统首页（/）**：在风险卡片下方集成「区域拜访热力图 + 部门分布」，作为管理驾驶舱。
- **控制台（/console）**：按 **单个员工 + 时间范围** 查询，展示该员工的行驶轨迹、拜访点、里程、异常。
- **任务**：
  - [x] 决策系统首页新增区域拜访分析模块
    - 新增 `/analytics/regional-overview` 接口
    - 新增 `HeatMapContainer` 组件（高德 `AMap.HeatMap`）
    - 模块包含：日期范围筛选器、部门筛选器、区域拜访热力图、部门分布表
    - 筛选器使用 Semi Design 组件
    - 日期范围与顶部决策系统筛选器独立
  - [x] 控制台保留「个人轨迹 + 风险分析」
    - 原 `Dashboard.tsx` 改名为 `ConsolePage.tsx`
    - 导航只保留「决策系统」和「控制台」，移除独立的「区域看板」tab
    - 决策系统员工卡片下钻改为 `/console`
  - [x] 地区/部门筛选器数据源：通过 `department_aliases` 映射表规范化

#### 3.5.5 部门/区域名称标准化（待补充映射，当前先探测钉钉通讯录）

> 现状：接入钉钉审批后，`visits.department` 出现 18 种不同写法，无法直接作为 Dashboard 部门筛选器。

##### 当前 department 分类

1. **已干净（无需处理）**
   - `华东宁波`、`华东昆山`、`华北一部`、`华南一部`

2. **带前缀/路径，可规则清洗**
   - `销售部-华东宁波`、`销售部-华东昆山`、`销售部-华北一部`、`销售部-华南一部`
     - → 去掉 `销售部-` 前缀即可归入干净部门
   - `销售渠道-华南区域`、`销售渠道-江苏区域`、`销售渠道-浙江区域`
     - → 待定：是映射到对应区域，还是作为独立分组？

3. **多部门拼接，需要人工映射表**
   - `华北一部,华北区域`
   - `华南区域,东南区域,华南一部`
   - `华南区域,华南一部,东南一部,销售部`
   - `江苏区域,华东昆山`
   - `浙江区域,华东宁波`
   - `深圳丹弗科技有限公司,采购部,销售部,海外业务部`

4. **需要确认是否等价**
   - `软件产品线` 是否对应 `软件业务部`？

##### 目标部门（钉钉销售部实际架构）

> 由业务方确认：华南一部、华东昆山、华东宁波、华北一部、东南一部、海外业务部、软件业务部。

##### 推进方式

- [x] **第一步：探测钉钉通讯录同步能力**
  - 调用 `topapi/v2/department/listsub` 拉取官方部门树
    - 接口已接入：`GET /dingtalk/departments?deptId=1`
    - **结论**：默认根部门 `deptId=1` 返回 `50004`（不在应用可见范围内）
    - `GET /dingtalk/probe-user?userid=xxx` 同样返回 `50002`，说明当前应用没有通讯录可见范围
    - **暂时放弃钉钉通讯录同步方案**
- [x] **第二步：实施替代方案——部门别名映射表**
  - 新增 `department_aliases` 表：`alias`（原始 department 字符串）→ `canonical_name`（规范部门）
  - 新增 `POST /analytics/init-department-aliases`：扫描 `visits` 自动生成初始映射
  - 新增 `GET /analytics/department-aliases` 和 `PUT /analytics/department-aliases` 供后续维护
  - 当前 18 条原始写法中，14 条已自动映射到 7 个规范部门，4 条待人工确认
- [x] **第三步：应用映射到 Dashboard/控制台**
  - `/visits/users` 返回规范部门
  - `/analytics/regional-overview` 按规范部门聚合
  - 保留原始 `visits.department` 不变，查询时通过 `department_aliases` 映射

##### 已处理的 4 条映射

| 原始 department | 规范部门 | 说明 |
|---|---|---|
| `软件产品线` | `软件产品线` | 按业务方要求保留原名 |
| `销售渠道-华南区域` | `销售渠道-华南区域` | 单独保留 |
| `销售渠道-江苏区域` | `销售渠道-江苏区域` | 单独保留 |
| `销售渠道-浙江区域` | `销售渠道-浙江区域` | 单独保留 |

##### 当前规范部门列表

全部数据聚合后共 10 个部门/分组：

- 华南一部、华东昆山、华东宁波、华北一部、东南一部、海外业务部、软件产品线
- 销售渠道-华南区域、销售渠道-江苏区域、销售渠道-浙江区域

> 注意：季昕亚、文武江、贺鹏程 3 人同时出现在目标部门和销售渠道分组中（因为他们的审批里既有 `销售部-xxx` 也有 `销售渠道-xxx` 的 department 写法）。

##### 待核对

业务方提到销售部实际有 21 人，分布在 7 个部门 + 陈盐（老板）。当前 visits 数据里共有 27 个不同 user_id，可能与以下因素有关：
- 部分用户只有销售渠道的审批记录
- 存在非销售部人员（如采购部、海外业务部）的审批
- 钉钉可见范围不足导致部分用户无法解析真实姓名

建议业务方核对人员名单，确认是否需要过滤非销售部用户。

---

#### 3.5.6 里程累计值口径与地图按审批隔离

> 发现时间：2026-07-02

##### 问题

接入真实钉钉审批数据后发现，`visits.reported_distance_km` 被直接 `SUM` 作为员工填报总里程，但钉钉表单里的 `累计里程N` 实际是**截至本次签到的累计值**（后一段包含前一段），导致同一审批内的多次签到被重复累加，偏差可达数倍。

数据验证（311 条有里程的审批单）：

| 校验项 | 结果 |
|---|---|
| 最后一个累计值 = 今日累计里程 | 300 / 311（96.5%） |
| 各段累计值直接相加 = 今日累计里程 | 76 / 311（24.4%） |
| 累计值与里程表读数（终点 − 起点）一致 | 272 / 311（87.5%） |
| 相邻累计值之差 = 相邻终点读数之差 | 276 / 311（88.7%） |

结论：**应取每个审批单的最后一个累计值作为该次出差总里程**，同时清洗负值、>5000 km 等异常读数。

##### 方案

**后端口径修正：**
- `/analytics/mileage` 按 `approval_id` 分组，每组取 `MAX(reported_distance_km)`，过滤异常值后再跨组求和。
- `routeService` 计算路线时按 `approval_id` 分组，组内相邻点连线，**不同审批单之间不连线**。
- `mileageAnalysis` 分段里程优先使用里程表读数差（`curr.end_odometer − prev.end_odometer`），补全首段计算。
- 导入时校验：若 `end_odometer < start_odometer` 或单次差值 > 5000 km，标记为异常读数，不写入 `reported_distance_km`。
- 历史数据：清空 `routes` 表，按新规则重算；刷新 `risk_summary_cache` 与 `anomalies`。

**前端展示调整：**
- 控制台/地图在同一天、同一员工存在多个 `approval_id` 时，需要按审批单拆分展示（如 Tab、下拉选择或卡片列表），避免把多个独立出差串成一条轨迹。
- 单个审批单内仍按时间顺序展示完整轨迹；跨审批的“汇总视图”可作为可选功能，但需明确标注“多行程合并”。

##### 任务

- [x] 后端：修正 `/analytics/mileage` 填报总里程计算逻辑
- [x] 后端：`routeService` 按 `approval_id` 分组计算路线
- [x] 后端：`riskSummaryService` 复用按审批分组的路线
- [x] 后端：`mileageAnalysis` 补全首段分段里程
- [x] 后端：钉钉/Excel 导入时校验里程读数
- [x] 后端：新增脚本清空并重算历史 `routes`、`risk_summary_cache`、`anomalies`
- [x] 前端：控制台/地图支持按审批单切换轨迹（Tab 或选择器）
- [x] 产品：里程读数异常阈值已改为环境变量配置（`MILEAGE_VALIDATION_MAX_KM` / `VITE_MILEAGE_MAX_KM`），当前默认 5000 km

---

#### 3.5.7 控制台重构：日历视图与周期总览

> 发现时间：2026-07-02

##### 背景

控制台（ConsolePage）目前以「下拉选员工 + 日期选择器 + 查询按钮」作为入口，交互较重，且没有承载「用户 + 周/月」的周期分析能力。管理者实际有两个核心查询场景：

1. **单日复盘**：看某个员工某一天的轨迹、里程、异常。
2. **周期总览**：看某个员工本周/本月的拜访趋势、里程偏差、异常分布。

Dashboard 已承担「部门维度团队总览」的职责，因此控制台应聚焦在**单个员工**的查询与分析。

##### 目标结构

控制台拆分为两个 Tab：

###### Tab 1：日历视图（单日复盘）

- **顶部**：用户选择器 + 横向日期轴（覆盖该员工所有有数据日期）。
  - 无数据日期置灰。
  - 有异常日期显示小红点（无需数量）。
  - 提供「今天」快捷定位按钮。
- **当日详情面板**（选中日期后整页刷新）：
  1. 审批单 Tab：全天总览 / 各审批单
  2. 汇总卡片：拜访点数、停留点数、总里程 vs 估算里程、异常事件
  3. 左右分栏：左侧地图轨迹，右侧异常列表

###### Tab 2：周期总览（周/月）

- **顶部**：用户选择器 + 时间范围（本周 / 本月 / 自定义），默认本月且不含今天。
- **内容**：
  - 周期汇总卡片：总拜访次数、总停留时长、总填报里程 vs 总估算里程、异常事件总数
  - 趋势图 1：每日「填报里程 vs 估算里程」折线图
  - 趋势图 2：每日拜访次数 + 停留时长柱状图
  - 用户拜访热力图（周期内所有拜访点聚合）
  - 异常事件时间线（按日期分组，点击跳转日历视图该日）

##### 后端接口需求

| 功能 | 已有接口 | 需新增 |
|---|---|---|
| 日历日期轴 | `/visits/available-dates` | 可选：标记含异常的日期 |
| 单日详情 | `/visits`、`/routes`、`/stops`、`/analytics/mileage`、`/analytics/anomaly` | 无 |
| 周期趋势图 + 汇总 | — | `/analytics/user-overview?user=&start=&end=`，返回每日聚合 |
| 周期热力图 | `/visits`（范围查询） | 无 |

##### 任务

- [x] 前端：控制台新增「日历视图 / 周期总览」两个 Tab（周期总览当前为占位，后续补内容）
- [x] 前端：日历视图横向日期轴（覆盖全部有数据日期，无数据置灰，异常红点）
- [x] 后端：`/visits/available-dates` 支持 `with_anomaly` 标记异常日期
- [x] 前端：当日详情面板按「审批单 Tab → 卡片 → 地图+异常列表」重排
- [ ] 后端：新增 `/analytics/user-overview` 聚合接口
- [ ] 前端：周期总览趋势图与热力图
- [ ] 前端：异常事件时间线及跳转日历视图

---

### Step 4：车辆 / 油卡 / 油耗模型（暂缓）

> 注：车辆/油耗信息可从钉钉表单的车辆字段部分解析，但当前 demo 阶段先聚焦行程与轨迹分析，车辆主数据模型暂缓。

#### 4.1 表结构

```sql
CREATE TABLE vehicles (
  id SERIAL PRIMARY KEY,
  plate VARCHAR(32),
  model VARCHAR(64),
  fuel_consumption_per_100km DOUBLE PRECISION,
  user_id INTEGER REFERENCES users(id),
  is_public BOOLEAN DEFAULT false
);

CREATE TABLE fuel_cards (
  id SERIAL PRIMARY KEY,
  card_no VARCHAR(64),
  vehicle_id INTEGER REFERENCES vehicles(id),
  user_id INTEGER REFERENCES vehicles(id)
);

CREATE TABLE fuel_records (
  id SERIAL PRIMARY KEY,
  card_id INTEGER REFERENCES fuel_cards(id),
  user_id INTEGER REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  refuel_time TIMESTAMP,
  amount_yuan DOUBLE PRECISION,
  volume_liter DOUBLE PRECISION,
  odometer_km DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 4.2 计算逻辑

```text
预估油耗(升) = 实际里程(km) × 车型百公里油耗 × 1.2 / 100
油耗偏差(升) = 实际加油量(升) - 预估油耗(升)
```

#### 4.3 任务

- [ ] 创建 vehicles / fuel_cards / fuel_records 表
- [ ] 车辆信息 Excel/CSV 导入
- [ ] 油卡信息 Excel/CSV 导入
- [ ] 加油记录 Excel/CSV 导入
- [ ] 油耗预估接口
- [ ] 控制台显示预估油耗 vs 实际加油

---

### Step 5：月维度数据导出

- [ ] 后端 `GET /analytics/export/monthly?month=&department=` 导出 Excel
- [ ] 导出字段：员工、部门、拜访次数、总里程、停留次数、异常次数、预估油耗、实际加油、风险评分
- [ ] 前端「月报导出」入口
- [ ] 时间筛选支持「过去一个月」「过去两周」「过去五个工作日」

---

### Step 6：权限系统（框架已完成，核心业务接口待收口）

> 详见上方 **P0-2 权限系统收口**，本节保留历史记录。

#### 角色设计

| 角色 | 权限 |
|---|---|
| admin | 查看全部 |
| manager | 查看本部门 |
| staff | 仅查看自己 |

#### 已完成

- ✅ `users` 表补充 `role`、`department`、`manager_id` 字段
- ✅ `authMiddleware`、`requireRole` 等认证辅助函数
- ✅ `/users`、`/feedback` 接口已按角色过滤
- ✅ 前端 `App.tsx` 用户切换与角色展示

#### 待收口（已拆分为 P0-2 任务）

- [ ] P2-1. 后端路由统一认证：`/analytics/*`、`/visits/*`、`/routes/*`、`/stops/*`、`/upload-excel`、`/dingtalk/*`
- [ ] P2-2. 后端数据范围过滤（staff=自己 / manager=本部门 / admin=全部）
- [ ] P2-3. 写操作角色限制（上传、权重、部门别名、钉钉同步、缓存刷新）
- [ ] P2-4. 前端菜单与路由守卫
- [ ] P2-5. 前端组件级权限控制

---

## 待讨论 / 低优先级

- [ ] Dashboard 字段命名：「停留点数」「停留时长」是否改名/移除
- [ ] Dashboard 热力图实现方案（前端地图聚合 or 后端生成热力图数据）
- [ ] 坐标补齐：当前 3 个 geocoding 失败地址（公司/翡翠滨江/莲花苑）暂不处理
- [ ] 更多异常规则：夜间/节假日签到、短时间密集签到等
- [ ] 上传接口查重策略细化（接入钉钉 API 后评估）
- [ ] 钉钉通讯录可见范围生效后，公共交通记录是否重新纳入
