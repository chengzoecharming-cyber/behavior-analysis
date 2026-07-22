# 数据质量监控落地方案（Data Observability Plan）

> 目标：解决“反复检查数据、反复重算、必须等人反馈才知道错”的问题。
> 文档状态：可执行方案 + 代码骨架，不引入新工具，优先在现有 PostgreSQL + Express 架构中落地。

---

## 1. 你现在的问题分类

| 痛苦 | 具体表现 | 需要的能力 | 标准术语 |
|---|---|---|---|
| 数据导入出错但不知道 | Excel 日期解析异常、坐标缺失、字段格式错 | 导入时断言 + 隔离异常记录 | Data Quality Assertions |
| 同步后发现不了不一致 | 钉钉同步丢单、重复、覆盖 | 同步后对账 + 自动告警 | Reconciliation / CheckSum |
| 下游指标口径变就要重算 | 修改时间解析后，要手动跑多个 recompute 脚本 | 计算血缘 + 受影响下游自动重算 | Data Lineage / Dependency DAG |
| 不知道指标是否合理 | 有人反馈“某员工里程偏差 60000%”才注意到 | 指标基线 + 异常波动告警 | Metric Baseline / Anomaly Detection |

---

## 2. 核心思路：从“人眼检查”到“护栏系统”

你现在的流程：

```text
数据进来 → 转换写入 → 人眼检查 → 发现异常 → 手动修复 → 手动重算
```

目标流程：

```text
数据进来 → 自动校验 → 异常隔离 → 自动告警 → 定向修复 → 触发下游重算
```

关键点：不是所有数据错误都能被自动发现，但**80% 的明显错误可以被护栏捕获**，剩下的 20% 通过指标基线发现。

---

## 3. 落地四层护栏

### 3.1 第一层：导入时断言（Import Assertions）

在 `normalization.ts` 的 `processParsedVisits` 中，对每条记录做显式检查，不直接拒绝，而是记录到 `data_quality_records` 表。

检查项：

| 字段 | 检查规则 | 严重等级 |
|---|---|---|
| `time` | 是否能解析为有效时间 | error |
| `user_id` | 是否为空、是否能匹配 `users` 表 | error / warning |
| `lat`/`lng` | 是否为空、是否在中国范围 | error / warning |
| `reported_distance_km` | 是否为负、是否超过 `MAX_MILEAGE_KM` | error |
| `start_odometer`/`end_odometer` | 是否缺失、是否非单调 | warning |
| `trip_type` | 是否在允许值集合内 | warning |
| `approval_id` + `sequence` | 是否重复 | error |

注意：这里不是简单跳过，而是**写入 visits + 记录 quality record**。这样下游计算可以决定是否参考 quality record。

### 3.2 第二层：同步后对账（Reconciliation）

扩展 `syncCheckService.ts`，在每次钉钉同步后自动运行：

| 对账项 | 源端 | 目标端 | 检查方式 |
|---|---|---|---|
| 审批单数量 | 钉钉拉取的实例数 | `raw_approvals` 写入数 | 计数 |
| 审批单集合 | 钉钉 `process_instance_id` 列表 MD5 | `raw_approvals.approval_id` 列表 MD5 | CheckSum |
| 解析出的 visit 数 | `raw_approvals.form_json` 解析后 | `visits` 中对应 approval_id 数 | 计数 |
| visits 写入率 | `parsed_visits` | `normalized_inserted` | 百分比 |
| 重复 visit | 无 | `visits` 中 `approval_id + sequence` 重复 | SQL 查询 |

### 3.3 第三层：指标基线（Metric Baseline）

每天/每小时自动计算核心指标，与历史基线比较：

| 指标 | 正常范围 | 异常处理 |
|---|---|---|
| 昨日总拜访数 | 与过去 30 天平均 ±30% | 告警 |
| 人均日拜访数 | 3-8 次 | 告警 |
| 坐标缺失率 | <5% | 告警 |
| 里程偏差率 >100% | <1% | 告警 |
| 同步成功率 | 100% | 失败立刻告警 |
| 解析失败率 | <1% | 告警 |

### 3.4 第四层：计算血缘与自动重算（Lineage & Auto-Refresh）

把 `recompute*` 脚本之间的依赖关系明确化：

```text
raw_visits → visits → routes → anomalies → risk_summary_cache
                ↘ stops ↗
```

当 `visits` 层发生变更（比如时间解析规则修改），系统应知道：
- 必须重算 `routes`、`stops`、`anomalies`
- 然后刷新 `risk_summary_cache`

最小可用做法：维护一个 `computation_dependency` 表，记录每个计算步骤依赖的表和触发条件。修复数据后，按依赖图触发重算。

---

## 4. 需要新增的表结构

见 `backend/src/services/dataQuality/schema.ts`（代码骨架）。

新增三张表：
- `data_quality_records`：单条记录级异常
- `data_quality_summary`：每次导入/同步的汇总报告
- `reconciliation_checks`：对账结果
- `metric_baselines`：指标基线配置与历史值
- `computation_dependencies`：计算依赖图
- `computation_queue`：待执行重算任务队列

---

## 5. 集成到现有代码的位置

| 现有文件 | 改动点 |
|---|---|
| `backend/src/services/normalization.ts` | 在 `processParsedVisits` 中调用 `recordQualityCheck` |
| `backend/src/services/excelParser.ts` | 在解析阶段记录 `raw_row_index`、`source_file` 等上下文 |
| `backend/src/services/syncCheckService.ts` | 同步完成后调用 `runReconciliationChecks` |
| `backend/src/services/scheduler.ts` | 每日/每小时触发 `runMetricBaselineChecks` |
| `backend/src/index.ts` | 启动时初始化 `data_quality_*` 表 |
| `backend/src/routes/dingtalk.ts` | 同步接口返回中附带 `quality_summary` |
| `backend/src/routes/upload.ts` | 上传接口返回中附带 `quality_summary` |

---

## 6. 告警与通知

复用现有钉钉机器人能力：`sendSyncAlertToDingTalk`。

新增告警类型：
- 同步对账失败
- 导入异常记录数 > 0
- 指标偏离基线
- 计算队列堆积

告警内容应包含：
- 问题类型
- 影响范围（时间、用户、审批单）
- 直接跳转链接（如 `/sync-logs`、`/data-quality`）
- 建议修复动作

---

## 7. 实施节奏建议

| 阶段 | 内容 | 预计时间 | 收益 |
|---|---|---|---|
| Week 1 | 建表 + 导入时断言 | 2-3 天 | 立刻知道 Excel/钉钉导入错在哪 |
| Week 2 | 同步后对账 + 告警 | 2-3 天 | 不再丢单、重复、漏写 |
| Week 3 | 指标基线 | 2-3 天 | 主动发现异常趋势 |
| Week 4 | 计算血缘 + 自动重算 | 3-5 天 | 修复后自动重算下游，减少手动操作 |

---

## 8. 验收标准

- 任意一次 Excel/钉钉导入，都能在页面/API 看到 `quality_summary`。
- 钉钉同步完成后，如果存在 missing/duplicate/parse_failure，自动收到钉钉告警。
- 每日能收到一份“昨日数据健康摘要”：总记录数、异常数、同步成功率、指标偏离项。
- 修复一条脏数据后，只需点击“重算受影响下游”或自动触发，无需手动跑多个脚本。

---

## 9. 与《数据密集型应用系统设计》的关系

这份方案本质上是把 DDIA 第 1 章的“可靠性、可维护性”落地为工程实践：
- 导入断言 = 故障容忍（Fault Tolerance）
- 对账 = 一致性检查（Consistency Check）
- 指标基线 = 可观测性（Observability）
- 计算血缘 = 可维护性（Maintainability）

读完 DDIA Ch1 后，可以回头对照这份方案，理解“为什么这些步骤不能省”。
