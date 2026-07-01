# 销售外勤行为分析系统 - 开发计划

> 最后更新：2026-06-26
> 当前重点：修复时区与数据质量问题，完成钉钉同步闭环。

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
  - [ ] 统一后端 `/visits`、`/routes`、`/stops`、`/analytics/*` 的时区处理
  - [ ] 统一前端日期传参格式
  - [ ] 清空并重建风险摘要缓存

#### 3.5.2 用户去重（中优先级）

- **问题**：`/visits/users` 按 `(user_id, user_name, department)` 去重，同一人 department 不同导致下拉框重复。
- **方案**：按 `user_id` 去重，department 取最新/最常出现值。
- **任务**：
  - [ ] 修改 `/visits/users` 去重逻辑
  - [ ] 下拉框 label 只显示 `user_name`（部门放入副标题或不显示）

#### 3.5.3 清理旧脏数据（中优先级）

- **问题**：历史同步残留 4 条 `reported_distance_km` 为负数的记录（如季昕亚 -187920），导致总里程异常。
- **方案**：
  - 删除或修正这 4 条旧记录
  - 统计时过滤负数里程
- **任务**：
  - [ ] 定位并修复负里程记录
  - [ ] 在 `/analytics/mileage` 加防御性过滤

#### 3.5.4 Dashboard 与控制台的定位区分（待讨论）

- **Dashboard（看板/Overview）**：按 **地区/部门 + 时间范围** 筛选，展示热力图/点位分布，不需要连线，用于管理者看区域覆盖情况。
- **控制台/轨迹查询**：按 **单个员工 + 时间范围** 查询，展示该员工的行驶轨迹、拜访点、里程、异常。
- **任务**：
  - [ ] 明确 Dashboard 改为「区域 Overview + 热力图」
  - [ ] 控制台/决策系统保留「个人轨迹 + 风险分析」
  - [ ] 设计地区/部门筛选器的数据来源（从 visits 聚合 or 从 users 表）

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

#### 待收口

- [ ] `/analytics/*`、`/visits/*`、`/routes/*`、`/stops/*`、`/upload-excel`、`/dingtalk/*` 等核心业务接口接入权限过滤
- [ ] 前端导航栏按角色隐藏入口
- [ ] Dashboard/控制台按角色限制数据范围
- [ ] 普通员工个人页

---

## 待讨论 / 低优先级

- [ ] Dashboard 字段命名：「停留点数」「停留时长」是否改名/移除
- [ ] Dashboard 热力图实现方案（前端地图聚合 or 后端生成热力图数据）
- [ ] 坐标补齐：当前 3 个 geocoding 失败地址（公司/翡翠滨江/莲花苑）暂不处理
- [ ] 更多异常规则：夜间/节假日签到、短时间密集签到等
- [ ] 上传接口查重策略细化（接入钉钉 API 后评估）
- [ ] 钉钉通讯录可见范围生效后，公共交通记录是否重新纳入
