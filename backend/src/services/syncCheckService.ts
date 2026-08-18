import { pool } from "../db";
import { buildRobotSignedUrl, getExportConfig } from "./dingtalkFile";
import { getYesterdayBeijing } from "../utils/timezone";

/**
 * 群自定义机器人若配置了安全关键词，消息内容必须包含该关键词，否则被拒（310000）。
 * 统一在文本前加【关键词】前缀（与报告群汇总的处理一致）。
 */
function withRobotKeyword(text: string): string {
  const keyword = process.env.DINGTALK_EXPORT_ROBOT_KEYWORD || "";
  return keyword ? `【${keyword}】${text}` : text;
}

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
  const hasReconciliationFields =
    row.source_approval_ids_hash !== null &&
    row.source_approval_ids_hash !== "" &&
    row.db_approval_ids_hash !== null &&
    row.db_approval_ids_hash !== "";

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
    // 两端 hash 已统一为 approval_id 口径：无缺失时应相等，不等且 missing>0 时提示集合不一致
    if (
      hasReconciliationFields &&
      row.source_approval_ids_hash !== row.db_approval_ids_hash &&
      row.missing_count > 0
    ) {
      issues.push("源端与库中审批单集合不一致");
    }
    // raw/visits 一致性检查：要求有对账字段且缺失数大于 0，才认为真的没写入
    if (
      hasReconciliationFields &&
      row.total_instances > 0 &&
      row.normalized_inserted === 0 &&
      row.parsed_visits > 0 &&
      row.missing_count > 0
    ) {
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
    // 发送通道不可用时必须抛错：否则调用方会把告警标记为「已发送」，
    // 实际从未送达且永不重发（8/3 事故的教训）
    throw new Error("机器人 webhook 未配置，无法发送告警");
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
      markdown: { title: "钉钉同步异常告警", text: withRobotKeyword(text) },
    }),
  });

  if (!res.ok) {
    throw new Error(`机器人告警发送失败: HTTP ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    throw new Error(`机器人告警发送失败: ${data.errmsg} (${data.errcode})`);
  }
}

/**
 * 多条告警合并为一条汇总消息发送。
 * 自定义机器人限流 20 条/分钟：逐条发送在积压超过 20 条时会打爆通道，
 * 失败的不标记、下轮重试，形成永久告警风暴（8/16 事故：107 条积压全是
 * parse_failures>0 的常规噪音）。汇总为一条后单轮最多 1 条消息。
 */
export async function sendSyncAlertsDigestToDingTalk(alerts: SyncAlert[]): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    throw new Error("机器人 webhook 未配置，无法发送告警");
  }

  const url = buildRobotSignedUrl(robotWebhook, process.env.DINGTALK_EXPORT_ROBOT_SECRET);

  const lines = [
    `## 🚨 钉钉同步异常告警（${alerts.length} 条）`,
    "",
    ...alerts.map(
      (a) =>
        `- **#${a.id}** ${a.startDate} ~ ${a.endDate}（${a.triggeredBy}）：${a.issues.join("；")}`
    ),
    "",
    "请进入「同步健康」页面查看详情并处理。",
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: {
        title: `钉钉同步异常告警（${alerts.length} 条）`,
        text: withRobotKeyword(lines.join("\n")),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`机器人告警发送失败: HTTP ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    throw new Error(`机器人告警发送失败: ${data.errmsg} (${data.errcode})`);
  }
}

/** 发送机器人 markdown 消息，失败抛错（调用方据此决定是否记录/重试） */
async function sendRobotMarkdown(title: string, text: string): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    throw new Error("机器人 webhook 未配置，无法发送消息");
  }
  const url = buildRobotSignedUrl(robotWebhook, process.env.DINGTALK_EXPORT_ROBOT_SECRET);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { title, text: withRobotKeyword(text) } }),
  });
  if (!res.ok) {
    throw new Error(`机器人消息发送失败: HTTP ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json().catch(() => null);
  if (data && data.errcode !== 0) {
    throw new Error(`机器人消息发送失败: ${data.errmsg} (${data.errcode})`);
  }
}

export async function sendDailySyncSummary(): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    console.log("[syncCheck] 机器人 webhook 未配置，跳过每日摘要");
    return;
  }

  const dateStr = getYesterdayBeijing();

  const result = await pool.query(
    `SELECT COUNT(*) AS total_runs,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count,
            SUM(missing_count) AS total_missing,
            SUM(duplicate_count) AS total_duplicate,
            SUM(parse_failures) AS total_parse_failures
     FROM dingtalk_sync_logs
     WHERE start_date <= $1 AND end_date >= $1`,
    [dateStr]
  );
  const row = result.rows[0];
  const totalRuns = parseInt(row.total_runs, 10) || 0;

  // 盲区修复：昨日一行同步日志都没有 = 调度器可能整天未运行（服务/数据库故障），
  // 必须告警——此前被当作「无异常」静默跳过（8/3 事故时就是这样漏掉的）
  if (totalRuns === 0) {
    await sendRobotMarkdown(
      "昨日同步健康摘要（异常）",
      [
        `## 🚨 昨日同步健康摘要（${dateStr}）`,
        "",
        "**昨日没有任何同步记录**——定时同步可能整天未运行。",
        "请检查后端服务与数据库状态。",
      ].join("\n")
    );
    console.warn(`[syncCheck] ${dateStr} 无任何同步日志，已发送异常摘要`);
    return;
  }

  const hasIssue =
    (row.failed_count || 0) > 0 ||
    (row.total_missing || 0) > 0 ||
    (row.total_duplicate || 0) > 0 ||
    (row.total_parse_failures || 0) > 0;

  // 心跳：正常日也发一条简短摘要，让「一切正常」与「告警通道故障」可区分
  if (!hasIssue) {
    await sendRobotMarkdown(
      "昨日同步健康摘要",
      [
        `## ✅ 昨日同步健康摘要（${dateStr}）`,
        "",
        `成功同步 ${row.success_count || 0} 次，无缺失、无重复、无解析失败。`,
      ].join("\n")
    );
    console.log("[syncCheck] 昨日同步正常，已发送心跳摘要");
    return;
  }

  await sendRobotMarkdown(
    "昨日同步健康摘要",
    [
      `## 📊 昨日同步健康摘要（${dateStr}）`,
      "",
      `**成功同步**：${row.success_count || 0} 次`,
      `**失败同步**：${row.failed_count || 0} 次`,
      `**缺失记录**：${row.total_missing || 0}`,
      `**重复记录**：${row.total_duplicate || 0}`,
      `**解析失败**：${row.total_parse_failures || 0}`,
      "",
      "请进入「同步健康」页面查看详情。",
    ].join("\n")
  );
}

export async function checkAndSendAlerts(): Promise<SyncAlert[]> {
  const alerts = await getSyncAlerts(true);
  if (alerts.length === 0) return [];

  // 合并为一条汇总消息发送（机器人限流 20 条/分钟，逐条发会打爆通道）；
  // 发送失败不标记 alert_sent，下轮重发
  try {
    await sendSyncAlertsDigestToDingTalk(alerts);
    await markAlertsSent(alerts.map((a) => a.id));
  } catch (err) {
    console.error(`[syncCheck] 汇总告警发送失败（${alerts.length} 条）:`, err);
  }
  return alerts;
}
