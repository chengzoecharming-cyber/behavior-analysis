import { pool } from "../src/db";

async function main() {
  // 1. mock 数据情况
  console.log("=== 1. mock 数据情况 ===");
  const mockVisits = await pool.query("SELECT COUNT(*) as cnt FROM visits WHERE source = 'seed'");
  const mockRawVisits = await pool.query("SELECT COUNT(*) as cnt FROM raw_visits WHERE source = 'seed'");
  const allSources = await pool.query("SELECT source, COUNT(*) as cnt FROM visits GROUP BY source");
  const allRawSources = await pool.query("SELECT source, COUNT(*) as cnt FROM raw_visits GROUP BY source");
  console.log("visits 中 source='seed' 数量:", mockVisits.rows[0].cnt);
  console.log("raw_visits 中 source='seed' 数量:", mockRawVisits.rows[0].cnt);
  console.log("visits 来源分布:", allSources.rows);
  console.log("raw_visits 来源分布:", allRawSources.rows);

  // 2. 审批单只有1个点的情况分析
  console.log("\n=== 2. 只有1个点的审批单详情 ===");
  const singlePointApprovals = await pool.query(`
    SELECT approval_id, COUNT(*) as cnt
    FROM visits
    WHERE approval_id IS NOT NULL
    GROUP BY approval_id
    HAVING COUNT(*) = 1
    LIMIT 10
  `);
  console.log("只有1个点的审批单ID样例:");
  console.table(singlePointApprovals.rows);

  // 查这些单点记录的详细信息
  const singleDetails = await pool.query(`
    SELECT v.approval_id, v.user_name, v.timestamp, v.location_name, v.address, v.customer_name, v.sequence, v.source_detail
    FROM visits v
    JOIN (
      SELECT approval_id
      FROM visits
      WHERE approval_id IS NOT NULL
      GROUP BY approval_id
      HAVING COUNT(*) = 1
      LIMIT 5
    ) t ON v.approval_id = t.approval_id
    ORDER BY v.approval_id
  `);
  console.log("这些单点记录的详情:");
  console.table(singleDetails.rows);

  // 3. 出发点相关统计
  console.log("\n=== 3. 出发点（source_detail='trip_start'）统计 ===");
  const startPointStats = await pool.query(`
    SELECT source_detail, COUNT(*) as cnt
    FROM visits
    GROUP BY source_detail
    ORDER BY cnt DESC
  `);
  console.log("source_detail 分布:");
  console.table(startPointStats.rows);

  // 4. 刀具柜交付详情
  console.log("\n=== 4. 刀具柜交付详情 ===");
  const knifeDelivery = await pool.query(`
    SELECT
      v.id,
      v.user_id,
      v.user_name,
      v.approval_id,
      v.timestamp,
      v.location_name,
      v.address,
      v.customer_name,
      v.sequence,
      v.source_detail,
      v.business_date,
      v.visit_note,
      v.reported_distance_km,
      v.trip_type,
      v.vehicle
    FROM visits v
    WHERE v.location_name LIKE '%刀具柜交付%'
       OR v.customer_name LIKE '%刀具柜%'
    ORDER BY v.user_id, v.business_date, v.timestamp
  `);
  console.log("刀具柜交付相关记录:");
  console.table(knifeDelivery.rows);

  // 5. <10分钟间隔的实际数据
  console.log("\n=== 5. 相邻签到点间隔 < 10 分钟的数据 ===");
  const shortGap = await pool.query(`
    WITH sorted AS (
      SELECT
        id,
        user_id,
        user_name,
        timestamp,
        location_name,
        address,
        customer_name,
        approval_id,
        sequence,
        business_date,
        LAG(timestamp) OVER (PARTITION BY user_id, business_date ORDER BY timestamp) as prev_time,
        LAG(location_name) OVER (PARTITION BY user_id, business_date ORDER BY timestamp) as prev_location,
        LAG(approval_id) OVER (PARTITION BY user_id, business_date ORDER BY timestamp) as prev_approval_id
      FROM visits
      WHERE business_date IS NOT NULL
    )
    SELECT
      user_id,
      user_name,
      business_date,
      prev_time,
      prev_location,
      prev_approval_id,
      timestamp as curr_time,
      location_name as curr_location,
      approval_id as curr_approval_id,
      ROUND(EXTRACT(EPOCH FROM (timestamp - prev_time)) / 60, 1) as gap_minutes
    FROM sorted
    WHERE prev_time IS NOT NULL
      AND EXTRACT(EPOCH FROM (timestamp - prev_time)) / 60 < 10
    ORDER BY user_id, business_date, timestamp
    LIMIT 50
  `);
  console.log(`共 ${shortGap.rows.length} 条间隔<10分钟记录，前50条:`);
  console.table(shortGap.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
