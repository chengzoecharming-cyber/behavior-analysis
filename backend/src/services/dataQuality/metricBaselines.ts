import { pool } from "../../db";

export interface MetricCheckResult {
  metricName: string;
  value: number;
  businessDate: string;
  status: "passed" | "failed" | "warning";
  message: string;
}

/**
 * 计算某一天的指标基线检查。
 * 通常放在 scheduler.ts 中每天凌晨运行。
 */
export async function runMetricBaselineChecks(businessDate: string): Promise<MetricCheckResult[]> {
  const baselines = await pool.query(
    `SELECT * FROM metric_baselines WHERE enabled = true ORDER BY metric_name`
  );

  const results: MetricCheckResult[] = [];

  for (const baseline of baselines.rows) {
    try {
      // 计算当前值
      const currentResult = await pool.query(baseline.query.replace(/CURRENT_DATE - 1/g, `'${businessDate}'`));
      const currentValue = Number(currentResult.rows[0].value ?? 0);

      // 写入历史
      await pool.query(
        `INSERT INTO metric_history (metric_name, value, business_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (metric_name, business_date) DO UPDATE SET value = EXCLUDED.value`,
        [baseline.metric_name, currentValue, businessDate]
      );

      // 取历史平均值
      const historyResult = await pool.query(
        `SELECT AVG(value) AS avg_value
         FROM metric_history
         WHERE metric_name = $1
           AND business_date < $2
           AND business_date >= $2 - ($3 || ' days')::interval`,
        [baseline.metric_name, businessDate, baseline.lookback_days]
      );
      const avgValue = Number(historyResult.rows[0].avg_value ?? 0);

      let status: "passed" | "failed" | "warning" = "passed";
      let message = `${baseline.metric_name} = ${currentValue}${baseline.unit || ""}`;

      if (baseline.min_value != null && currentValue < baseline.min_value) {
        status = "failed";
        message += `，低于下限 ${baseline.min_value}`;
      } else if (baseline.max_value != null && currentValue > baseline.max_value) {
        status = "failed";
        message += `，高于上限 ${baseline.max_value}`;
      } else if (avgValue > 0 && baseline.max_delta_percent != null) {
        const delta = Math.abs((currentValue - avgValue) / avgValue) * 100;
        if (delta > baseline.max_delta_percent) {
          status = "warning";
          message += `，相对过去 ${baseline.lookback_days} 天均值 ${avgValue.toFixed(2)} 波动 ${delta.toFixed(1)}%，超过阈值 ${baseline.max_delta_percent}%`;
        }
      }

      results.push({ metricName: baseline.metric_name, value: currentValue, businessDate, status, message });
    } catch (err) {
      results.push({
        metricName: baseline.metric_name,
        value: 0,
        businessDate,
        status: "failed",
        message: `指标计算失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}

/**
 * 获取最近几天的指标历史，用于前端趋势图。
 */
export async function getMetricHistory(metricName: string, days: number = 30): Promise<any[]> {
  const result = await pool.query(
    `SELECT business_date, value FROM metric_history
     WHERE metric_name = $1
     ORDER BY business_date DESC
     LIMIT $2`,
    [metricName, days]
  );
  return result.rows;
}

/**
 * 更新指标基线配置（管理后台用）。
 */
export async function updateMetricBaseline(
  metricName: string,
  updates: {
    minValue?: number;
    maxValue?: number;
    maxDeltaPercent?: number;
    enabled?: boolean;
  }
): Promise<void> {
  await pool.query(
    `UPDATE metric_baselines
     SET min_value = COALESCE($2, min_value),
         max_value = COALESCE($3, max_value),
         max_delta_percent = COALESCE($4, max_delta_percent),
         enabled = COALESCE($5, enabled),
         updated_at = NOW()
     WHERE metric_name = $1`,
    [metricName, updates.minValue, updates.maxValue, updates.maxDeltaPercent, updates.enabled]
  );
}

/**
 * 生成昨日数据健康摘要，用于每日钉钉机器人推送。
 */
export async function buildDailyHealthSummary(businessDate: string): Promise<{
  date: string;
  totalVisits: number;
  activeUsers: number;
  geocodeFailed: number;
  unresolvedQualityErrors: number;
  unresolvedQualityWarnings: number;
  syncFailures: number;
  metricFailures: MetricCheckResult[];
}> {
  const visitsResult = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS users,
            COUNT(*) FILTER (WHERE geocode_status = 'failed') AS geocode_failed
     FROM visits WHERE business_date = $1`,
    [businessDate]
  );

  const qualityResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE severity = 'error') AS errors,
       COUNT(*) FILTER (WHERE severity = 'warning') AS warnings
     FROM data_quality_records
     WHERE resolved = false AND business_date = $1`,
    [businessDate]
  );

  const syncResult = await pool.query(
    `SELECT COUNT(*) AS failures FROM dingtalk_sync_logs
     WHERE status = 'failed' AND started_at >= $1::date AND started_at < $1::date + INTERVAL '1 day'`,
    [businessDate]
  );

  const metricChecks = await runMetricBaselineChecks(businessDate);

  return {
    date: businessDate,
    totalVisits: Number(visitsResult.rows[0].total),
    activeUsers: Number(visitsResult.rows[0].users),
    geocodeFailed: Number(visitsResult.rows[0].geocode_failed),
    unresolvedQualityErrors: Number(qualityResult.rows[0].errors),
    unresolvedQualityWarnings: Number(qualityResult.rows[0].warnings),
    syncFailures: Number(syncResult.rows[0].failures),
    metricFailures: metricChecks.filter((m) => m.status !== "passed"),
  };
}
