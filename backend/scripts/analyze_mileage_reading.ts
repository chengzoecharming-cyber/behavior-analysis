import { pool } from "../src/db";

async function main() {
  // 1. 有多少审批单有出发里程读数
  const hasStartOdometer = await pool.query(`
    SELECT
      COUNT(DISTINCT approval_id) as total_approvals,
      COUNT(DISTINCT CASE WHEN start_odometer IS NOT NULL THEN approval_id END) as with_start,
      COUNT(DISTINCT CASE WHEN start_odometer IS NULL THEN approval_id END) as without_start
    FROM visits
    WHERE approval_id IS NOT NULL
  `);
  console.log("=== 审批单出发里程读数覆盖情况 ===");
  console.table(hasStartOdometer.rows);

  // 2. 分段里程计算方式分布：有读数差 vs 用累计值差
  const segmentCalc = await pool.query(`
    WITH ordered AS (
      SELECT
        id,
        approval_id,
        sequence,
        timestamp,
        start_odometer,
        end_odometer,
        reported_distance_km,
        LAG(end_odometer) OVER (PARTITION BY approval_id ORDER BY sequence) as prev_end_odometer,
        LAG(start_odometer) OVER (PARTITION BY approval_id ORDER BY sequence) as prev_start_odometer,
        LAG(reported_distance_km) OVER (PARTITION BY approval_id ORDER BY sequence) as prev_reported
      FROM visits
      WHERE approval_id IS NOT NULL
    )
    SELECT
      CASE
        WHEN end_odometer IS NOT NULL AND (prev_end_odometer IS NOT NULL OR prev_start_odometer IS NOT NULL) THEN 'odometer_diff'
        WHEN reported_distance_km IS NOT NULL AND prev_reported IS NOT NULL THEN 'cumulative_diff'
        WHEN reported_distance_km IS NOT NULL AND prev_reported IS NULL THEN 'cumulative_direct'
        ELSE 'unknown'
      END as calc_method,
      COUNT(*) as cnt
    FROM ordered
    WHERE sequence > 1
    GROUP BY calc_method
  `);
  console.log("=== 分段里程计算方式分布 ===");
  console.table(segmentCalc.rows);

  // 3. 里程偏差大的具体案例
  const highDeviation = await pool.query(`
    SELECT
      v1.user_name,
      v1.approval_id,
      v1.timestamp as start_time,
      v1.location_name as start_loc,
      v1.address as start_addr,
      v1.start_odometer,
      v2.timestamp as end_time,
      v2.location_name as end_loc,
      v2.address as end_addr,
      v2.end_odometer,
      v2.reported_distance_km,
      v2.end_odometer - v1.start_odometer as odometer_diff,
      v2.reported_distance_km as reported_cumulative,
      v2.timestamp::date as business_date
    FROM visits v1
    JOIN visits v2 ON v1.approval_id = v2.approval_id
      AND v2.sequence = (SELECT MIN(sequence) FROM visits v WHERE v.approval_id = v1.approval_id AND v.sequence > 1)
      AND v1.sequence = 1
    WHERE v1.approval_id IS NOT NULL
      AND v2.reported_distance_km IS NOT NULL
    ORDER BY v2.reported_distance_km DESC
    LIMIT 20
  `);
  console.log("=== 累计里程最大的审批单（前20） ===");
  console.table(highDeviation.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
