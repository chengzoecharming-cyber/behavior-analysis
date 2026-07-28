# 数据可观测性落地进展（Data Observability Progress Log）

> 本文档持续记录「数据质量监控落地方案」（[`data-observability-plan.md`](data-observability-plan.md)）的实际落地进度、设计决策、踩过的坑和未来方向。
> 代码在 `feature/data-observability` 分支。

## 已完成里程碑

| 时间 | Commit | 内容 |
|---|---|---|
| 2026-07-22 | `5cd57c2` | 第一层「导入时断言」收尾：批内重复检测、质量汇总记录、接口透传 |
| 2026-07-22 | `a4c3577` | 数据血缘查看器：钉钉审批单 ① 原始表单 → ② 重新解析 → ③ 已入库 三步对照 |
| 2026-07-23 | `2f5107f` | 「数据同步中心」页：同步记录 + 同步健康 + 数据血缘三合一 |

---

## 一、数据血缘查看器（a4c3577）

### 目标

解决「看不见数据」的痛点：一张钉钉审批单进来后，管理者想知道**原始表单长什么样、系统怎么解析的、最终存成了什么**，以及这张单有没有质量问题记录。

### 实现

- 后端：[`backend/src/services/lineageViewerService.ts`](../../backend/src/services/lineageViewerService.ts) + [`backend/src/routes/dataLineage.ts`](../../backend/src/routes/dataLineage.ts)
  - `GET /data-lineage/approvals`：分页列出所有审批单（含签到点数、质量问题计数）。
  - `GET /data-lineage/approvals/:id`：单张单的三步血缘详情。
    - ① 原始表单：从 `raw_approvals.form_json` 解析，控件类型 → 中文标签 + 可读值（TimeAndLocationField → 定位 tag，DDPhotoField → "N 张照片"，DDSelectField → 选项文本等）。
    - ② 重新解析：用当前代码的 `parseApprovalInstance()` 现场重跑一遍（**不写库**），验证解析逻辑本身。
    - ③ 已入库：查 `visits` 表按 sequence 排序，附地理编码状态。
    - 质量问题：查 `data_quality_records WHERE source='dingtalk' AND source_id=approval_id`。
- 前端：[`frontend/src/pages/DataLineagePage.tsx`](../../frontend/src/pages/DataLineagePage.tsx)
  - 列表（审批单号/员工/部门/状态/签到点数/质量问题 Badge）+ Drawer 三步对照（②③ 左右并排对比，一目了然）。

### 踩过的坑（重要，后续维护者必读）

1. **`business_id` 列不存在**：`raw_approvals` 表没有 `business_id` 列，SELECT 里写了就直接 500。schema 以 `db.ts` 为准，不要凭直觉猜列名。
2. **`isMultiStopRouteForm()` 依赖 `instance.title`**（[`dingtalk.ts`](../../backend/src/services/dingtalk.ts) L813-816）：重新解析时如果构造的 instance 没带 `title`，会拿 `process_instance_id` 去匹配 `/用车里程|客户签到|里程登记|外出签到/`，必然匹配不上 → 走单表单 fallback → 只产出 1 条退化的 "null" 字符串记录。**教训：解析函数对输入对象有隐式契约，重构或复用时必须把 title 传进去。**

---

## 二、数据同步中心（2f5107f）

### 设计决策：为什么是合并而不是删除

三个页面回答**不同维度**的问题，底层数据都要保留：

| 页面 | 维度 | 回答的问题 | 数据源 |
|---|---|---|---|
| 同步记录 | 批次/运行 | 每次同步跑了没有、跑了多少、耗时多久 | `dingtalk_sync_logs` |
| 同步健康 | 对账/告警 | 源端和库里的审批单 ID 集合对不对得上（缺失/重复） | `syncCheckService` 计算 + `dingtalk_sync_logs.missing_count/duplicate_count` |
| 数据血缘 | 单条记录 | 某张审批单原始→解析→入库各长什么样 | `raw_approvals` + `visits` + `data_quality_records` |

用户痛点是「三个入口太分散，而且血缘页看不出有没有同步过来」。所以 UI 合并成一个页面两个 Tab，数据各管各的。

### 实现

- 新页面 [`frontend/src/pages/DataSyncCenterPage.tsx`](../../frontend/src/pages/DataSyncCenterPage.tsx)（路由 `/sync-center`）：
  - **Tab1 同步概览**：同步记录表格（含对账列：缺失/重复/解析失败）+ 同步健康收成 badge（最近一次状态 + 近 14 次非健康计数 + 未处理告警数）+ 未处理告警横幅（可确认已处理）+ 强制同步弹窗。
  - **Tab2 数据血缘**：完整血缘查看器。
  - **跨 Tab 联动**：概览每行（和每条告警）的「血缘」按钮 → 切到血缘 Tab 并注入该次同步的日期范围作为过滤器。这是「从批次钻到单条记录」的关键路径。
- 重构：[`DataLineagePage.tsx`](../../frontend/src/pages/DataLineagePage.tsx) 拆出可控组件 `DataLineagePanel`（range 由父组件控制），默认导出保留为独立页兜底。
- 清理：删除 `SyncLogsPage.tsx` / `SyncHealthPage.tsx`；旧路由 `/sync-logs`、`/sync-health`、`/data-lineage` 全部 `<Navigate>` 重定向到 `/sync-center`；admin 下拉入口合并为单个「数据同步中心」。

### 小坑

- 同步范围日期在 `dingtalk_sync_logs` 里是 `YYYY-MM-DD`，但健康/告警接口返回的是 ISO 时间戳（`2026-07-18T16:00:00.000Z`）——前端统一用 `dayjs(v).format("YYYY-MM-DD")` 显示。
- Ant Design Tabs 默认 `destroyInactiveTabPane=false`，隐藏 Tab 的 DOM 还在——E2E 查询 DOM 时注意 `.ant-tabs-tabpane-hidden` 里的元素会干扰断言。

---

## 三、四个维度的排查路径（使用手册）

发现问题时的标准排查动作：

1. **「今天数据同步过来了吗？」** → 同步中心 Tab1，看最近一次同步的状态 + 对账列（缺失/重复应为 0）。
2. **「为什么这条拜访数据不对？」** → 同步中心 Tab2 搜员工名 → 点审批单号 → 看三步对照：原始表单值对不对（①）→ 解析结果对不对（②）→ 入库值对不对（③）。哪一步断了就修哪一步。
3. **「这批数据整体质量怎么样？」** → Tab1 未处理告警横幅 + 血缘列表的「质量问题」Badge 列。
4. **「某个范围数据缺失/重复了怎么办？」** → Tab1 用「强制同步」重跑该日期范围，然后「血缘」跳转验证。

---

## 四、未来方向（已认可，未开始）

按 [`data-observability-plan.md`](data-observability-plan.md) 的四层架构，目前状态：

| 层 | 模块 | 状态 |
|---|---|---|
| 第一层：导入时断言 | `dataQuality/assertions.ts` | ✅ 已接入 `processParsedVisits`（Excel + 钉钉） |
| 第二层：同步后对账 | `dataQuality/reconciliation.ts` + `syncCheckService.ts` | ✅ 已接入钉钉同步流程，`dingtalk_sync_logs` 有对账字段，UI 已展示 |
| 第三层：指标基线 | `dataQuality/metricBaselines.ts` | ⚠️ 代码骨架已写，**未接入业务流程** |
| 第四层：血缘与自动重算 | `dataQuality/lineage.ts` | ⚠️ 代码骨架已写，**未接入业务流程**；血缘查看器（人工排查）已完成 |
| 告警通知 | `dataQuality/alerts.ts` + `DINGTALK_EXPORT_ROBOT_WEBHOOK` | ✅ 同步健康告警已发钉钉机器人；质量记录告警未接 |

下一步候选（按优先级）：

1. **把 `metricBaselines` / `lineage` / `alerts` 骨架接入业务流程**（集成方法见 [`data-quality-integration-guide.md`](data-quality-integration-guide.md)）。
2. **后台任务统一台账**：所有定时任务（风险缓存刷新、钉钉同步、健康摘要）和脚本任务（recompute、backfill）统一记录到一张 `job_runs` 表，做「异常结论页」——目前只有钉钉同步有日志。
3. **风险摘要缓存的自动失效重算**：当某 user+date 的 visits 被修正（坐标修正、强制同步）后，对应日期的 `risk_summary_cache` 应自动标记 stale 并重算，而不是等凌晨 2 点的定时任务。
4. **数据血缘覆盖 Excel 导入**：目前血缘只覆盖钉钉审批单（`raw_approvals`），Excel 导入的 `raw_visits` 没有对应的三步对照。

---

## 五、实战案例（2026-07-23）：归日口径与客户名语义

> 这一节是两个真实故障的完整复盘，是理解「为什么需要数据可观测性」最好的教材。
> 相关代码修复在 main 分支（`1253868`~`0bae11f`），本节只记录教训。

### 案例 A：客户名错挂（语义理解错误）

**现象**：控制台里客户名称挂错了签到点。

**根因**：钉钉表单没有语义说明书，解析逻辑靠抽样逆向。同一字段有两种控件形态（OpenDataField / TableField）、编号从 2 开始（`客户名称N` 属于第 N+1 个签到点）、且 OpenDataField 在 OA 界面不渲染——每发现一个新形态就产生一次修复。

**修复**:`findBefore` 严格向前查找（dingtalk.ts）+ 覆盖模式 backfill（1677 条修正）。

**插曲**:排查中发现两个"疑似 bug"其实是**源数据真相**——李朝晖"公司办公"却选了占位客户"住址（签到用）"、范德康单上"多出来"的济南禾瑞其实是 OA 界面没渲染的 CRM 卡片字段。教训：**先查原始数据（raw_approvals），再怀疑解析逻辑**。占位客户填报问题单独记录在 [`../customer-placeholder-filling-issue.md`](../customer-placeholder-filling-issue.md)，定性为源数据治理问题，不在系统加规则。

### 案例 B:business_date 归日口径（口径漂移）

**现象**：李朝晖 7-02 控制台显示 3 张审批单，钉钉 OA 只有 2 张。

**根因链**（三层叠加，值得逐层看）:

1. 一张 7-01 创建的审批单，收尾签到实际发生在 7-02 07:20（跨天单）——OA 按创建日归档，控制台按归日口径展示，**两边口径不同，都没错**;
2. 但底层 `business_date` 存的是旧口径（审批单日期）,351 条历史数据与现行口径不符——**存储口径滞后**;
3. 更深处：7-21 的 d402944 把归日改成「每条签到实际时间」，与产品定义的「审批单只归一天」和里程口径「按审批单首次签到日期聚合」**三方打架**。

**最终定夺**：钉钉**审批单级归日**——整张单统一取首次签到的北京时间日期，与里程口径对齐；Excel 仍逐条归日。代码、历史数据、AGENTS.md/README 三处同步修正。

### 教训（数据可观测性视角）

1. **口径必须三位一体**：展示（控制台查询）、存储（business_date)、聚合（里程/风险）对同一实体必须用同一个归日规则，否则跨天单必然打架。改口径 = 代码 + 历史数据迁移 + 文档，三件事缺一不可。
2. **checksum 防不住语义错位**:351 条归日错误，行数、ID 集合全部对得上，同步对账一片绿。这类问题要靠**断言**（业务不变量）抓，例如现成的一条：`business_date <> (timestamp AT TIME ZONE 'Asia/Shanghai')::date`（在审批单级口径下，这条应只在跨天收尾签到上成立——断言本身也要跟口径走，这是很好的练习）。
3. **血缘查看器是最快排查路径**：两次故障都是先拉 `raw_approvals.form_json` 三步对照定位的，"先看原始数据再怀疑代码"应成为肌肉记忆。
4. **修复标准流程**（本次形成，以后照用）:dry-run 预览差异 → 覆盖/迁移更新 → 受影响 user+date 衍生数据重算（`recomputeDerivedDataForVisits`)→ SQL + 控制台双重抽查。
5. **新代码上线≠问题解决**：解析/口径类修复必须配套历史数据迁移脚本，且脚本要幂等（只处理不一致行）、可 dry-run、自动重算衍生数据。

### 对路线图的影响

- 第一层（导入断言）新增候选规则：归日一致性、客户名与拜访类型的占位冲突检测（仅记录不拦截）。
- 「口径文档」雏形：AGENTS.md 的 business_date 一节 + 占位客户文档，未来应收敛成一份完整的**钉钉表单语义规格**（每个字段的控件形态、编号约定、映射规则）。

---

## 相关文档

- 方案设计：[`data-observability-plan.md`](data-observability-plan.md)
- 集成示例：[`data-quality-integration-guide.md`](data-quality-integration-guide.md)
- 项目规范：[`AGENTS.md`](../../AGENTS.md)（含 `dingtalk_sync_logs` 对账字段说明）
