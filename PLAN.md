# 销售外勤行为分析系统 - 开发计划

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

---

## 待开发

### Step 2：Date Range 支持

#### 2.1 决策系统

- 保持单日排名为主
- 增加快捷筛选：今天 / 昨天 / 本周 / 本月
- 本周/本月风险分基于日缓存聚合

#### 2.2 Dashboard / 控制台

- 日期选择器改为 `RangePicker`
- 后端接口 `/visits`、`/stops`、`/routes`、`/analytics/mileage`、`/analytics/anomaly` 支持 `start` + `end`
- 轨迹地图支持展示多天的连续轨迹

---

### Step 3：钉钉 API 自动接入

#### 前置条件

- 钉钉开放平台企业内部应用
- `appKey` / `appSecret`
- 审批模板 ID（`process_code`）

#### 任务

- [ ] 钉钉 AccessToken 获取与缓存
- [ ] 拉取审批实例列表
- [ ] 解析审批实例详情，写入 `raw_visits`
- [ ] 增量同步（按更新时间）
- [ ] 定时任务（每天凌晨同步前一天）
- [ ] 从钉钉同步用户/部门信息到 `users` 表

---

### Step 4：车辆 / 油卡 / 油耗模型

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

### Step 6：权限系统

#### 角色设计

| 角色 | 权限 |
|---|---|
| admin | 查看全部 |
| manager | 查看本部门 |
| staff | 仅查看自己 |

#### 任务

- [ ] `users` 表补充 role、department 字段
- [ ] 后端接口增加权限过滤
- [ ] 前端根据角色渲染导航和数据范围
- [ ] 普通员工个人页

---

## 待讨论 / 低优先级

- [ ] Dashboard 字段命名：「停留点数」「停留时长」是否改名/移除
- [ ] 坐标补齐：当前 3 个 geocoding 失败地址（公司/翡翠滨江/莲花苑）暂不处理
- [ ] 更多异常规则：夜间/节假日签到、短时间密集签到等
- [ ] 上传接口查重策略细化（接入钉钉 API 后评估）
