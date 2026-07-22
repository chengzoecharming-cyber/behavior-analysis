import { getExportConfig, buildRobotSignedUrl } from "../dingtalkFile";
import { MetricCheckResult } from "./metricBaselines";

export interface DataQualityAlert {
  title: string;
  level: "error" | "warning" | "info";
  message: string;
  link?: string;
}

/**
 * 发送数据质量告警到钉钉机器人。
 * 复用现有的 buildRobotSignedUrl 签名逻辑。
 */
export async function sendDataQualityAlert(alert: DataQualityAlert): Promise<void> {
  const { robotWebhook } = getExportConfig();
  if (!robotWebhook) {
    console.log("[dataQuality] 机器人 webhook 未配置，跳过告警发送");
    return;
  }

  const url = buildRobotSignedUrl(robotWebhook, process.env.DINGTALK_EXPORT_ROBOT_SECRET);

  const text = [
    `## ${alert.level.toUpperCase()} | ${alert.title}`,
    "",
    alert.message,
    alert.link ? `查看详情：${alert.link}` : "",
  ].join("\n");

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title: alert.title, text } }),
    });

    if (!resp.ok) {
      console.error("[dataQuality] 发送告警失败:", await resp.text());
    }
  } catch (err) {
    console.error("[dataQuality] 发送告警异常:", err);
  }
}

/**
 * 同步对账失败时的告警。
 */
export function buildReconciliationAlert(syncLogId: number, failedChecks: string[]): DataQualityAlert {
  return {
    title: "钉钉同步对账失败",
    level: "error",
    message: `同步日志 ID: ${syncLogId}\n未通过对账项: ${failedChecks.join(", ")}`,
    link: `/sync-logs`,
  };
}

/**
 * 导入存在质量异常时的告警。
 */
export function buildImportQualityAlert(
  jobType: string,
  jobId: string | undefined,
  errorCount: number,
  warningCount: number
): DataQualityAlert {
  return {
    title: `${jobType === "dingtalk_sync" ? "钉钉同步" : "Excel 导入"} 存在数据异常`,
    level: errorCount > 0 ? "error" : "warning",
    message: `任务: ${jobId || "未知"}\n错误: ${errorCount} 条\n警告: ${warningCount} 条`,
    link: `/data-quality`,
  };
}

/**
 * 每日健康摘要告警。
 */
export function buildDailyHealthAlert(summary: {
  date: string;
  totalVisits: number;
  activeUsers: number;
  geocodeFailed: number;
  unresolvedQualityErrors: number;
  unresolvedQualityWarnings: number;
  syncFailures: number;
  metricFailures: MetricCheckResult[];
}): DataQualityAlert {
  const lines = [
    `日期: ${summary.date}`,
    `总拜访: ${summary.totalVisits} 条`,
    `活跃员工: ${summary.activeUsers} 人`,
    `坐标缺失: ${summary.geocodeFailed} 条`,
    `未解决质量错误: ${summary.unresolvedQualityErrors} 条`,
    `未解决质量警告: ${summary.unresolvedQualityWarnings} 条`,
    `同步失败: ${summary.syncFailures} 次`,
  ];

  if (summary.metricFailures.length > 0) {
    lines.push("指标异常:");
    for (const m of summary.metricFailures) {
      lines.push(`- ${m.message}`);
    }
  }

  const hasIssue =
    summary.unresolvedQualityErrors > 0 ||
    summary.syncFailures > 0 ||
    summary.metricFailures.length > 0;

  return {
    title: `昨日数据健康摘要 (${summary.date})`,
    level: hasIssue ? "warning" : "info",
    message: lines.join("\n"),
    link: `/data-quality`,
  };
}

/**
 * 计算血缘重算失败时的告警。
 */
export function buildComputationFailedAlert(procedure: string, error: string): DataQualityAlert {
  return {
    title: "下游重算失败",
    level: "error",
    message: `步骤: ${procedure}\n错误: ${error}`,
    link: `/data-quality/computation-queue`,
  };
}
