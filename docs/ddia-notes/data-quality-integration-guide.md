# 数据质量监控集成示例

> 本文档是代码骨架的集成说明，展示如何在现有流程中调用 `backend/src/services/dataQuality/` 的函数。
> 注意：这些改动**目前没有实际应用到任何已有文件**，只是示例，等你修完旧逻辑后再按此集成。

---

## 1. 初始化表结构

在 `backend/src/db.ts` 的 `initDB()` 末尾调用：

```ts
import { initDataQualitySchema } from "./services/dataQuality/schema";

export async function initDB(): Promise<void> {
  // ... 原有建表逻辑 ...
  await initDataQualitySchema(client);
}
```

这样启动服务时，会自动创建 `data_quality_*`、`reconciliation_checks`、`metric_*`、`computation_*` 等表。

---

## 2. 在 Excel/钉钉导入流程中记录质量异常

修改 `backend/src/services/normalization.ts` 的 `processParsedVisits`：

```ts
import { persistVisitQualityFailures, recordQualitySummary } from "../services/dataQuality";

export async function processParsedVisits(
  parsedVisits: ParsedVisit[],
  source: "excel" | "dingtalk"
): Promise<ProcessResult> {
  let totalErrorCount = 0;
  let totalWarningCount = 0;
  let totalInfoCount = 0;

  for (let i = 0; i < parsedVisits.length; i++) {
    const visit = parsedVisits[i];

    // 原有的标准化和写入逻辑保持不变 ...

    // 新增：记录数据质量异常
    const counts = await persistVisitQualityFailures(source, visit, i);
    totalErrorCount += counts.errorCount;
    totalWarningCount += counts.warningCount;
    totalInfoCount += counts.infoCount;
  }

  // 新增：导入完成后写入汇总
  await recordQualitySummary({
    jobType: source === "excel" ? "excel_upload" : "dingtalk_sync",
    totalRecords: parsedVisits.length,
    errorCount: totalErrorCount,
    warningCount: totalWarningCount,
    infoCount: totalInfoCount,
    insertedCount: insertedNormalized.length,
    skippedCount: skippedCount,
    details: { affectedUserDates: Array.from(affectedUserDates) },
  });

  return { ... };
}
```

这样每次导入完成后，你都能在 `data_quality_records` 里看到具体哪条记录有问题，而不是靠人眼去 Excel 里找。

---

## 3. 在同步完成后做对账

修改 `backend/src/services/dingtalk.ts` 的同步落库逻辑，在写入 `dingtalk_sync_logs` 并标记成功后调用：

```ts
import { runReconciliationChecks } from "../services/dataQuality";

// 假设 syncLogId 是刚写入的日志 ID
const sourceApprovalIds = instances.map((i) => i.processInstanceId).filter(Boolean);

await runReconciliationChecks({
  syncLogId,
  startDate,
  endDate,
  sourceApprovalIds,
  parsedVisitCount: parsedVisits.length,
  normalizedInsertedCount: insertedNormalized.length,
  rawVisitCount: insertedRaw.length,
});
```

---

## 4. 对账失败时告警

在 `backend/src/services/syncCheckService.ts` 的 `sendSyncAlertToDingTalk` 之前，可以加入：

```ts
import { isSyncReconciliationPassed, getReconciliationChecks } from "../services/dataQuality";
import { sendDataQualityAlert, buildReconciliationAlert } from "../services/dataQuality";

const passed = await isSyncReconciliationPassed(syncLogId);
if (!passed) {
  const failedChecks = await getReconciliationChecks(syncLogId);
  const failedNames = failedChecks.filter((c) => c.status === "failed").map((c) => c.check_name);
  await sendDataQualityAlert(buildReconciliationAlert(syncLogId, failedNames));
}
```

这样同步一结束，如果对账失败，立刻钉钉告警。

---

## 5. 每日健康摘要

在 `backend/src/services/scheduler.ts` 中新增一个定时任务，例如每天早上 9:00：

```ts
import { buildDailyHealthSummary, sendDataQualityAlert, buildDailyHealthAlert } from "../services/dataQuality";

async function sendDailyHealthSummary() {
  const yesterday = formatBeijingDate(new Date(Date.now() - 86400000));
  const summary = await buildDailyHealthSummary(yesterday);
  await sendDataQualityAlert(buildDailyHealthAlert(summary));
}
```

---

## 6. 修复数据后自动重算下游

假设你修正了 `visits` 表中某些时间戳，想自动重算 `routes`、`stops`、`anomalies`、`risk_summary_cache`：

```ts
import { refreshTableAndDownstream } from "../services/dataQuality";

await refreshTableAndDownstream("visits", { business_date: "2026-07-18" });
```

这会按 `computation_dependencies` 表里的依赖关系，生成重算队列。

---

## 7. 最小可用验证步骤

1. 启动服务，确认新表已创建。
2. 导入一个 Excel，查看 `data_quality_summary` 是否有记录。
3. 触发一次钉钉同步，查看 `reconciliation_checks` 是否有记录。
4. 手动修改一条 `visits` 数据，调用 `refreshTableAndDownstream("visits")`，查看 `computation_queue` 是否生成任务。
5. 每天早上确认是否收到钉钉健康摘要。

---

## 8. 与 DDIA 的对应关系

| 集成点 | 解决的问题 | DDIA 概念 |
|---|---|---|
| 导入时断言 | 数据进来就有问题 | Fault Tolerance |
| 同步后对账 | 两边数据不一致 | Consistency / CheckSum |
| 指标基线 | 看不出来指标异常 | Observability |
| 计算血缘 | 改了上游要手动重算 | Maintainability / Lineage |
