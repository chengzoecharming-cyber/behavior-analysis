import { pool } from "../src/db";

interface QualityIssue {
  table: string;
  issue: string;
  count: number;
}

interface FixResult {
  table: string;
  issue: string;
  fixedCount: number;
  details?: any[];
}

interface CleanReport {
  scannedAt: string;
  issuesBefore: QualityIssue[];
  fixes: FixResult[];
  issuesAfter: QualityIssue[];
  manualReviewItems: ManualReviewItem[];
}

interface ManualReviewItem {
  table: string;
  issue: string;
  count: number;
  sampleIds: (number | string)[];
  suggestion: string;
}

async function countIssues(client: any): Promise<QualityIssue[]> {
  const result = await client.query(`
    SELECT * FROM (
      SELECT 'visits' AS table_name, 'negative_distance' AS issue, COUNT(*) AS cnt
      FROM visits WHERE reported_distance_km < 0
      UNION ALL
      SELECT 'visits', 'null_coords', COUNT(*) FROM visits WHERE lat IS NULL OR lng IS NULL
      UNION ALL
      SELECT 'visits', 'zero_coords', COUNT(*) FROM visits WHERE lat = 0 AND lng = 0
      UNION ALL
      SELECT 'visits', 'nan_coords', COUNT(*) FROM visits WHERE lat = 'NaN'::float OR lng = 'NaN'::float
      UNION ALL
      SELECT 'visits', 'invalid_timestamp', COUNT(*) FROM visits WHERE timestamp IS NULL OR timestamp > NOW() + INTERVAL '1 day'
      UNION ALL
      SELECT 'stops', 'null_coords', COUNT(*) FROM stops WHERE lat IS NULL OR lng IS NULL
      UNION ALL
      SELECT 'stops', 'zero_coords', COUNT(*) FROM stops WHERE lat = 0 AND lng = 0
      UNION ALL
      SELECT 'stops', 'negative_duration', COUNT(*) FROM stops WHERE duration_minutes < 0
      UNION ALL
      SELECT 'routes', 'negative_distance', COUNT(*) FROM routes WHERE distance_km < 0
      UNION ALL
      SELECT 'routes', 'zero_distance', COUNT(*) FROM routes WHERE distance_km = 0
      UNION ALL
      SELECT 'anomalies', 'null_type', COUNT(*) FROM anomalies WHERE type IS NULL
      UNION ALL
      SELECT 'anomalies', 'null_date', COUNT(*) FROM anomalies WHERE anomaly_date IS NULL
      UNION ALL
      SELECT 'risk_summary_cache', 'negative_score', COUNT(*) FROM risk_summary_cache WHERE risk_score < 0
      UNION ALL
      SELECT 'risk_summary_cache', 'null_date', COUNT(*) FROM risk_summary_cache WHERE date IS NULL
    ) t
    WHERE cnt > 0
    ORDER BY table_name, issue
  `);
  return result.rows;
}

async function fixNegativeDistance(client: any): Promise<FixResult> {
  const before = await client.query(
    `SELECT id, user_name, reported_distance_km, timestamp AT TIME ZONE 'Asia/Shanghai' AS beijing_time
     FROM visits WHERE reported_distance_km < 0`
  );

  await client.query(
    `UPDATE visits SET reported_distance_km = NULL WHERE reported_distance_km < 0`
  );

  return {
    table: "visits",
    issue: "negative_distance",
    fixedCount: before.rows.length,
    details: before.rows,
  };
}

async function fixAnomaliesMissingDate(client: any): Promise<FixResult> {
  const before = await client.query(
    `SELECT id, type, user_id, start_time, created_at
     FROM anomalies WHERE anomaly_date IS NULL`
  );

  await client.query(`
    UPDATE anomalies
    SET anomaly_date = COALESCE(
      (start_time AT TIME ZONE 'Asia/Shanghai')::date,
      (created_at AT TIME ZONE 'Asia/Shanghai')::date
    )
    WHERE anomaly_date IS NULL
  `);

  return {
    table: "anomalies",
    issue: "null_date",
    fixedCount: before.rows.length,
    details: before.rows.slice(0, 10),
  };
}

async function analyzeZeroDistanceRoutes(client: any): Promise<ManualReviewItem> {
  const result = await client.query(`
    SELECT r.id, r.user_id, r.from_visit_id, r.to_visit_id, r.distance_km,
           vf.lat AS from_lat, vf.lng AS from_lng, vf.geocode_status AS from_geocode,
           vt.lat AS to_lat, vt.lng AS to_lng, vt.geocode_status AS to_geocode
    FROM routes r
    LEFT JOIN visits vf ON r.from_visit_id = vf.id
    LEFT JOIN visits vt ON r.to_visit_id = vt.id
    WHERE r.distance_km = 0
    ORDER BY r.id
    LIMIT 50
  `);

  const missingFromCoords = result.rows.filter((r: any) => r.from_lat == null).length;
  const missingToCoords = result.rows.filter((r: any) => r.to_lat == null).length;
  const bothCoordsPresent = result.rows.filter(
    (r: any) => r.from_lat != null && r.to_lat != null
  ).length;

  return {
    table: "routes",
    issue: "zero_distance",
    count: result.rows.length,
    sampleIds: result.rows.slice(0, 5).map((r: any) => r.id),
    suggestion: `共 ${result.rows.length} 条 route 距离为 0。其中 from 坐标缺失 ${missingFromCoords} 条，to 坐标缺失 ${missingToCoords} 条，两端坐标均存在 ${bothCoordsPresent} 条。建议人工确认是否保留或删除。`,
  };
}

async function main() {
  const client = await pool.connect();
  const report: CleanReport = {
    scannedAt: new Date().toISOString(),
    issuesBefore: [],
    fixes: [],
    issuesAfter: [],
    manualReviewItems: [],
  };

  try {
    await client.query("BEGIN");

    console.log("[1/4] 扫描脏数据...");
    report.issuesBefore = await countIssues(client);
    console.log("发现异常项：", report.issuesBefore);

    console.log("\n[2/4] 修复安全项...");

    // 2.1 负里程
    const negativeDistanceFix = await fixNegativeDistance(client);
    report.fixes.push(negativeDistanceFix);
    console.log(`  - 修复负里程: ${negativeDistanceFix.fixedCount} 条`);

    // 2.2 anomalies 缺 anomaly_date
    const missingDateFix = await fixAnomaliesMissingDate(client);
    report.fixes.push(missingDateFix);
    console.log(`  - 填充 anomaly_date: ${missingDateFix.fixedCount} 条`);

    console.log("\n[3/4] 生成人工复核项...");
    const zeroDistanceReview = await analyzeZeroDistanceRoutes(client);
    report.manualReviewItems.push(zeroDistanceReview);
    console.log(`  - 零距离 routes: ${zeroDistanceReview.count} 条`);

    console.log("\n[4/4] 再次扫描确认...");
    report.issuesAfter = await countIssues(client);
    console.log("剩余异常项：", report.issuesAfter);

    await client.query("COMMIT");

    console.log("\n==================== 清洗报告 ====================");
    console.log(JSON.stringify(report, null, 2));

    // 写入文件
    const fs = await import("fs");
    const reportPath = `./clean-report-${new Date().toISOString().slice(0, 10)}.json`;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n报告已保存到: ${reportPath}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("清洗失败，已回滚:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
