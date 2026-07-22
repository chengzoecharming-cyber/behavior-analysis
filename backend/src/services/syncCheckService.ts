import { pool } from "../db";
import { buildRobotSignedUrl, getExportConfig } from "./dingtalkFile";

export type SyncHealthStatus = "healthy" | "warning" | "error";

export interface SyncHealthItem {
  id: number;
  triggeredBy: string;
  status: string;
  startDate: string;
  endDate: string;
  totalInstances: number;
  parsedVisits: number;
  normalizedInserted: number;
  skipped: number;
  parseFailures: number;
  rawVisitCount: number;
  sourceApprovalIdsHash: string | null;
  dbApprovalIdsHash: string | null;
  missingCount: number;
  duplicateCount: number;
  healthStatus: SyncHealthStatus;
  issues: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface SyncAlert {
  id: number;
  triggeredBy: string;
  startDate: string;
  endDate: string;
  totalInstances: number;
  parsedVisits: number;
  normalizedInserted: number;
  skipped: number;
  parseFailures: number;
  rawVisitCount: number;
  missingCount: number;
  duplicateCount: number;
  issues: string[];
  createdAt: string;
  alertSent: boolean;
}

function evaluateHealth(row: any): { status: SyncHealthStatus; issues: string[] } {
  const issues: string[] = [];

  if (row.status === "failed") {
    issues.push(`同步失败：${row.error_message || "未知错误"}`);
  }

  if (row.status === "success") {
    if (row.missing_count > 0) {
      issues.push(`缺失 ${row.missing_count} 条审批单记录`);
    }
    if (row.duplicate_count > 0) {
      issues.push(`存在 ${row.duplicate_count} 条重复记录`);
    }
    if (row.parse_failures > 0) {
      issues.push(`${row.parse_failures} 条审批单解析失败`);
    }
    if (
      row.source_approval_ids_hash &&
      row.db_approval_ids_hash &&
      row.source_approval_ids_hash !== row.db_approval_ids_hash
    ) {
      issues.push("源端与库中审批单集合不一致");
    }
    // 粗略的 raw/visits 一致性检查：如果源端有实例但入库为 0
    if (row.total_instances > 0 && row.normalized_inserted === 0 && row.parsed_visits > 0) {
      issues.push("解析成功但未写入 visits");
    }
  }

  let status: SyncHealthStatus = "healthy";
  if (row.status === "failed" || issues.some((i) => i.includes("同步失败") || i.includes("缺失"))) {
    status = "error";
  } else if (issues.length > 0) {
    status = "warning";
  }

  return { status, issues };
}

export async function checkSyncHealth(limit = 7): Promise<SyncHealthItem[]> {
  const result = await pool.query(
    `SELECT id, triggered_by, status, start_date, end_date,
            total_instances, parsed_visits, parse_failures,
            normalized_inserted, skipped, raw_visit_count,
            source_approval_ids_hash, db_approval_ids_hash,
            missing_count, duplicate_count,
            started_at, finished_at, error_message
     FROM dingtalk_sync_logs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => {
    const { status, issues } = evaluateHealth(row);
    return {
      id: row.id,
      triggeredBy: row.triggered_by,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      totalInstances: row.total_instances,
      parsedVisits: row.parsed_visits,
      normalizedInserted: row.normalized_inserted,
      skipped: row.skipped,
      parseFailures: row.parse_failures,
      rawVisitCount: row.raw_visit_count,
      sourceApprovalIdsHash: row.source_approval_ids_hash,
      dbApprovalIdsHash: row.db_approval_ids_hash,
      missingCount: row.missing_count,
      duplicateCount: row.duplicate_count,
      healthStatus: status,
      issues,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  });
}

export async function getSyncAlerts(unacknowledgedOnly = true): Promise<SyncAlert[]> {
  const status = unacknowledgedOnly ? "AND alert_sent = false" : "";
  const result = await pool.query(
    `SELECT id, triggered_by, start_date, end_date,
            total_instances, parsed_visits, parse_failures,
            normalized_inserted, skipped, raw_visit_count,
            missing_count, duplicate_count,
            started_at, alert_sent
     FROM dingtalk_sync_logs
     WHERE status = 'failed' OR missing_count > 0 OR duplicate_count > 0 OR parse_failures > 0
     ${status}
     ORDER BY started_at DESC
     LIMIT 100`
  );

  return result.rows.map((row) => {
    const { issues } = evaluateHealth(row);
    return {
      id: row.id,
      triggeredBy: row.triggered_by,
      startDate: row.start_date,
      endDate: row.end_date,
      totalInstances: row.total_instances,
      parsedVisits: row.parsed_visits,
      normalizedInserted: row.normalized_inserted,
      skipped: row.skipped,
      parseFailures: row.parse_failures,
      rawVisitCount: row.raw_visit_count,
      missingCount: row.missing_count,
      duplicateCount: row.duplicate_count,
      issues,
      createdAt: row.started_at,
      alertSent: row.alert_sent,
    };
  });
}

export async function ackSyncAlert(syncLogId: number): Promise<void> {
  await pool.query(
    `UPDATE dingtalk_sync_logs SET alert_sent = true WHERE id = $1`,
    [syncLogId]
  );
}

export async function markAlertsSent(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE dingtalk_sync_logs SET alert_sent = true WHERE id = ANY($1)`,
    [ids]
  );
}

export async function sendSyncAlertToDingTalk(alert: SyncAlert): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    console.log("[syncCheck] 机器人 webhook 未配置，跳过告警发送");
    return;
  }

  const url = buildRobotSignedUrl(robotWebhook, process.env.DINGTALK_EXPORT_ROBOT_SECRET);

  const text = [
    `## 🚨 钉钉同步异常告警`,
    "",
    `**同步范围**：${alert.startDate} ~ ${alert.endDate}`,
    `**触发方式**：${alert.triggeredBy}`,
    `**总审批实例**：${alert.totalInstances}`,
    `**解析 visits**：${alert.parsedVisits}`,
    `**写入 visits**：${alert.normalizedInserted}`,
    `**写入 raw_visits**：${alert.rawVisitCount}`,
    `**跳过/失败**：${alert.skipped} / ${alert.parseFailures}`,
    `**缺失记录**：${alert.missingCount}`,
    `**重复记录**：${alert.duplicateCount}`,
    "",
    "**问题**：",
    ...alert.issues.map((issue) => `- ${issue}`),
    "",
    "请进入「同步健康」页面查看详情并处理。",
  ].join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title: "钉钉同步异常告警", text },
    }),
  });

  if (!res.ok) {
    console.warn("[syncCheck] 机器人告警发送失败:", res.status, res.statusText);
    return;
  }

  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    console.warn("[syncCheck] 机器人告警发送失败:", data.errmsg, `(${data.errcode})`);
  }
}

export async function sendDailySyncSummary(): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    console.log("[syncCheck] 机器人 webhook 未配置，跳过每日摘要");
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count,
            SUM(missing_count) AS total_missing,
            SUM(duplicate_count) AS total_duplicate,
            SUM(parse_failures) AS total_parse_failures
     FROM dingtalk_sync_logs
     WHERE start_date <= $1 AND end_date >= $1`,
    [dateStr]
  );
  const row = result.rows[0];

  const hasIssue =
    (row.failed_count || 0) > 0 ||
    (row.total_missing || 0) > 0 ||
    (row.total_duplicate || 0) > 0 ||
    (row.total_parse_failures || 0) > 0;

  if (!hasIssue) {
    console.log("[syncCheck] 昨日同步无异常，不发送摘要");
    return;
  }

  const url = buildRobotSignedUrl(robotWebhook, process.env.DINGTALK_EXPORT_ROBOT_SECRET);

  const text = [
    `## 📊 昨日同步健康摘要（${dateStr}）`,
    "",
    `**成功同步**：${row.success_count || 0} 次`,
    `**失败同步**：${row.failed_count || 0} 次`,
    `**缺失记录**：${row.total_missing || 0}`,
    `**重复记录**：${row.total_duplicate || 0}`,
    `**解析失败**：${row.total_parse_failures || 0}`,
    "",
    "请进入「同步健康」页面查看详情。",
  ].join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title: "昨日同步健康摘要", text },
    }),
  });

  if (!res.ok) {
    console.warn("[syncCheck] 每日摘要发送失败:", res.status, res.statusText);
    return;
  }

  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    console.warn("[syncCheck] 每日摘要发送失败:", data.errmsg, `(${data.errcode})`);
  }
}

export async function checkAndSendAlerts(): Promise<SyncAlert[]> {
  const alerts = await getSyncAlerts(true);
  if (alerts.length === 0) return [];

  const sentIds: number[] = [];
  for (const alert of alerts) {
    try {
      await sendSyncAlertToDingTalk(alert);
      sentIds.push(alert.id);
    } catch (err) {
      console.error(`[syncCheck] 发送告警 ${alert.id} 失败:`, err);
    }
  }

  await markAlertsSent(sentIds);
  return alerts;
}
