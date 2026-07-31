/**
 * 定向重算「拜访量不足」(low_visit_count) 异常。
 *
 * 背景：2026-07-30 起，low_visit_count 统计排除员工住址与公司地址白名单
 * （company_addresses 表），历史日期需要按新口径重算。
 *
 * 只处理 low_visit_count 这一条规则，不重算里程/路径/其他异常：
 * 1. 找出所有「业务周最后一天」的 (user_id, business_date)；
 * 2. 按新口径（排除住址 + 公司地址）重新统计该业务周拜访量；
 * 3. 删除旧的 low_visit_count 异常，按新结果决定是否重新写入；
 * 4. 基于更新后的 anomalies 重算该员工当天的风险分，更新 risk_summary_cache。
 *
 * 用法：
 *   npx ts-node scripts/recomputeLowVisitCount.ts        # 实际执行
 *   npx ts-node scripts/recomputeLowVisitCount.ts --dry  # 只预览，不写库
 */
import { pool } from "../src/db";
import { Anomaly, Visit } from "../src/types";
import { getEnabledAnomalyWeights } from "../src/services/anomalyWeights";
import { calculateRiskScore, getRiskLevel } from "../src/services/riskScoring";
import {
  loadUserHomeAddresses,
  loadCompanyAddresses,
  isHomeAddress,
  isCompanyAddress,
  CompanyAddress,
} from "../src/services/addressWhitelistService";
import { formatBeijingDate } from "../src/utils/timezone";
import {
  getCurrentBusinessWeekRange,
  isBusinessWeekEnd,
  formatBusinessPeriod,
} from "../src/utils/businessPeriod";

const DRY_RUN = process.argv.includes("--dry");

async function main() {
  const weights = await getEnabledAnomalyWeights();
  const lowVisitConfig = weights["low_visit_count"];
  if (!lowVisitConfig) {
    console.warn("[警告] low_visit_count 规则当前未启用，仍会按阈值重算并写库");
  }
  const threshold = lowVisitConfig?.threshold_value ?? 10;
  console.log(`阈值: ${threshold} 次/业务周, dryRun=${DRY_RUN}`);

  const companyAddresses = await loadCompanyAddresses();
  console.log(`公司地址白名单 ${companyAddresses.length} 条`);

  // 所有有数据的 (员工, 业务日期)
  const pairs = await pool.query<{ user_id: string; bd: string }>(
    `SELECT DISTINCT user_id, business_date::text AS bd FROM visits ORDER BY bd, user_id`
  );
  const today = formatBeijingDate(new Date());

  let inserted = 0;
  let removed = 0;
  let kept = 0;
  let cacheUpdated = 0;
  let cacheMissing = 0;

  for (const { user_id: userId, bd } of pairs.rows) {
    // 规则只在业务周最后一天触发，其余日期不可能有 low_visit_count
    if (bd > today || !isBusinessWeekEnd(bd)) continue;

    const period = getCurrentBusinessWeekRange(bd);
    const periodStart = formatBeijingDate(period.start);
    const periodEnd = formatBeijingDate(period.end);

    const visitsResult = await pool.query<Visit>(
      `SELECT * FROM visits
       WHERE user_id = $1
         AND business_date >= $2::date
         AND business_date <= $3::date
       ORDER BY timestamp ASC`,
      [userId, periodStart, periodEnd]
    );

    // 新口径：排除员工本人住址 + 公司地址白名单
    const homeAddressMap = await loadUserHomeAddresses([userId]);
    const homeAddress = homeAddressMap.get(userId);
    const weeklyVisits: Visit[] = [];
    for (const v of visitsResult.rows) {
      const d = new Date(v.timestamp);
      if (d < period.start || d > period.end) continue;
      if (homeAddress && (await isHomeAddress(v, homeAddress))) continue;
      if (isCompanyAddress(v, companyAddresses)) continue;
      weeklyVisits.push(v);
    }

    // 申诉豁免期内不产生异常
    const exemptResult = await pool.query(
      `SELECT 1 FROM anomaly_exceptions
       WHERE user_id = $1 AND start_date <= $2::date AND end_date >= $2::date`,
      [userId, bd]
    );
    const isExempt = exemptResult.rows.length > 0;

    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM anomalies
       WHERE user_id = $1 AND anomaly_date = $2::date AND type = 'low_visit_count'`,
      [userId, bd]
    );
    const hadBefore = existing.rows.length > 0;
    const shouldHave = !isExempt && weeklyVisits.length < threshold;

    if (shouldHave && !hadBefore) inserted++;
    if (!shouldHave && hadBefore) removed++;
    if (shouldHave && hadBefore) kept++;

    if (!DRY_RUN) {
      await pool.query(
        `DELETE FROM anomalies
         WHERE user_id = $1 AND anomaly_date = $2::date AND type = 'low_visit_count'`,
        [userId, bd]
      );

      if (shouldHave) {
        const description = `${formatBusinessPeriod(period.start, period.end)} 拜访量 ${weeklyVisits.length} 次，低于 ${threshold} 次阈值`;
        await pool.query(
          `INSERT INTO anomalies
           (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids, metadata, anomaly_date, layer)
           VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4, $5, $6, $7::date, 'judge')`,
          [
            userId,
            "low_visit_count",
            description,
            weeklyVisits.length < threshold * 0.6 ? "high" : "medium",
            weeklyVisits.map((v) => v.id),
            JSON.stringify({
              period_start: periodStart,
              period_end: periodEnd,
              visit_count: weeklyVisits.length,
              threshold,
            }),
            bd,
          ]
        );
      }

      // 基于更新后的异常集合重算当天风险分并更新缓存
      const anomaliesResult = await pool.query<Anomaly>(
        `SELECT * FROM anomalies WHERE user_id = $1 AND anomaly_date = $2::date`,
        [userId, bd]
      );
      const { score, reasons } = await calculateRiskScore(anomaliesResult.rows);
      const riskLevel = getRiskLevel(score);
      const countBy = (s: string) =>
        anomaliesResult.rows.filter((a) => a.severity === s).length;

      const updateResult = await pool.query(
        `UPDATE risk_summary_cache
         SET risk_score = $3, risk_level = $4, anomaly_count = $5,
             high_anomaly_count = $6, medium_anomaly_count = $7, low_anomaly_count = $8,
             reasons = $9
         WHERE user_id = $1 AND date = $2::date`,
        [
          userId,
          bd,
          score,
          riskLevel,
          anomaliesResult.rows.length,
          countBy("high"),
          countBy("medium"),
          countBy("low"),
          JSON.stringify(reasons),
        ]
      );
      if (updateResult.rowCount && updateResult.rowCount > 0) {
        cacheUpdated++;
      } else {
        cacheMissing++;
        console.log(`  [跳过缓存] ${userId} ${bd} 无 risk_summary_cache 行`);
      }
    }

    if (shouldHave !== hadBefore) {
      console.log(
        `  ${userId} ${bd}: 拜访量 ${weeklyVisits.length}/${threshold}，` +
          `${hadBefore ? "原有异常" : "原无异常"} → ${shouldHave ? "保留/新增异常" : "移除异常"}`
      );
    }
  }

  console.log("\n===== 汇总 =====");
  console.log(`新增异常: ${inserted}`);
  console.log(`移除异常: ${removed}`);
  console.log(`维持异常: ${kept}`);
  if (!DRY_RUN) {
    console.log(`缓存更新: ${cacheUpdated}, 无缓存行跳过: ${cacheMissing}`);
  } else {
    console.log("(dry-run，未写库)");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
