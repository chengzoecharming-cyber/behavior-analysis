# 销售外勤行为分析系统 - 后续开发计划

## 已上线：Phase 1（数据治理 + 控制台增强）

- ✅ 1A 钉钉宽表解析 & 数据模型扩展
- ✅ 1B 批量地理编码 + 失败 fallback + 手动坐标修正接口
- ✅ 1C 里程对比分析 + 新增异常类型
- ✅ 1D Dashboard 合并地图轨迹 + 决策系统下钻

---

## Phase 2：可配置权重后台 + 行为评分（已完成）

### 目标
建立可动态调整的异常规则权重体系，输出员工单日/单周风险评分，支撑决策系统风险排名。

### 初始权重与阈值

| 规则 key | 规则名 | 权重 | 阈值 |
|---|---|---|---|
| low_visit_count | 拜访量不足 | 0.25 | 5 个工作日累计签到 < 15 次 |
| duplicate_location | 重复签到 | 0.20 | 2 周同一地点重复签到 ≥ 7 次 |
| mileage_deviation | 里程偏差 | 0.20 | 填报里程 vs 高德里程偏差 > 30% |
| long_stop | 停留过长 | 0.15 | 停留 > 120 分钟 |
| route_detour | 路径绕行 | 0.10 | 实际距离 > 直线距离 × 2 |
| idle_gap | 长时间未移动 | 0.05 | > 180 分钟无记录 |
| missing_special_reason | 特殊签到缺原因 | 0.05 | 特殊签到未填写原因 |

### 任务

- [ ] 创建 `anomaly_weights` 配置表
- [ ] 初始化 7 条默认规则
- [ ] 新增 `GET /analytics/anomaly-weights` 查询权重
- [ ] 新增 `PUT /analytics/anomaly-weights/:key` 更新权重/阈值/开关
- [ ] 将 `detectAnomalies` 改为读取权重配置
- [ ] 新增 `GET /analytics/risk-score?user_id=&date=` 单日评分
- [ ] 新增 `GET /analytics/risk-score/weekly?user_id=&week=` 单周评分
- [ ] 增强 `GET /analytics/risk-summary` 返回评分、命中规则明细
- [ ] 前端新增「规则配置」页面
- [ ] 决策系统卡片按风险评分排序

---

## Phase 3：车辆/油卡/加油记录导入 + 油耗预估模型

### 目标
支持员工整理的车辆、油卡、加油记录批量导入，建立油耗预估与实际对比能力。

### 表结构

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
  user_id INTEGER REFERENCES users(id)
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

### 计算逻辑

```text
预估油耗(升) = 实际里程(km) × 车型百公里油耗 × 1.2 / 100
油耗偏差(升) = 实际加油量(升) - 预估油耗(升)
```

### 任务

- [ ] 创建 vehicles / fuel_cards / fuel_records 表
- [ ] 新增车辆信息 Excel/CSV 导入接口
- [ ] 新增油卡信息 Excel/CSV 导入接口
- [ ] 新增加油记录 Excel/CSV 导入接口
- [ ] 新增油耗预估接口 `GET /analytics/fuel-estimate?user_id=&month=`
- [ ] 前端新增「油耗数据上传」页面
- [ ] 控制台显示预估油耗与实际加油对比

---

## Phase 4：月维度数据导出

### 目标
支持按月份导出员工/部门的拜访、里程、油耗、异常汇总报表。

### 任务

- [ ] 新增 `GET /analytics/export/monthly?month=&department=` 导出 Excel
- [ ] 导出字段：员工、部门、拜访次数、总里程、停留次数、异常次数、预估油耗、实际加油、风险评分
- [ ] 前端新增「月报导出」入口
- [ ] 时间筛选支持「过去一个月」「过去两周」「过去五个工作日」

---

## Phase 5：钉钉 API 自动接入

### 目标
通过钉钉自建应用自动拉取审批数据，替代手动 Excel 导入。

### 前置条件

- 钉钉开放平台企业内部应用
- `appKey` / `appSecret`
- 审批模板 ID（`process_code`）

### 任务

- [ ] 新增钉钉 AccessToken 获取与缓存
- [ ] 新增审批实例列表拉取任务
- [ ] 新增审批实例详情解析，写入 `raw_visits`
- [ ] 增量同步逻辑（按更新时间）
- [ ] 定时任务（每天凌晨同步前一天）
- [ ] 接入成功后，users 表从钉钉同步用户/部门信息

---

## Phase 6：权限系统

### 目标
基于用户角色控制数据查看范围。

### 角色设计

| 角色 | 权限 |
|---|---|
| admin | 查看全部 |
| manager | 查看本部门 |
| staff | 仅查看自己 |

### 任务

- [ ] users 表补充 role、department 字段
- [ ] 后端所有查询接口增加权限过滤
- [ ] 前端根据角色渲染导航和数据范围
- [ ] 普通员工个人页（轨迹、异常、油耗）

---

## 未决定/低优先级

- [ ] 坐标补齐：当前 3 个 geocoding 失败地址（公司/翡翠滨江/莲花苑）暂不处理
- [ ] 更多异常规则：夜间/节假日签到、短时间密集签到等
- [ ] 路线规划结果缓存，进一步降低 risk-summary 耗时
