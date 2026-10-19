import { pool } from "../src/db";

async function main() {
  await pool.query("SELECT 1"); // ensure connected

  // 1. 点数最多的审批单
  const perApprovalRes = await pool.query(`
    SELECT approval_id, COUNT(*) as cnt
    FROM visits
    WHERE approval_id IS NOT NULL
    GROUP BY approval_id
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log("=== 点数最多的审批单 ===");
  console.table(perApprovalRes.rows);

  // 2. 每个审批单的点数分布
  const distRes = await pool.query(`
    SELECT cnt, COUNT(*) as approval_count FROM (
      SELECT approval_id, COUNT(*) as cnt
      FROM visits
      WHERE approval_id IS NOT NULL
      GROUP BY approval_id
    ) t
    GROUP BY cnt ORDER BY cnt
  `);
  console.log("=== 每个审批单的点数分布 ===");
  console.table(distRes.rows);

  // 3. 同一天同地点多次打卡
  const dupRes = await pool.query(`
    SELECT user_id, user_name, location_name, business_date, COUNT(*) as cnt
    FROM visits
    WHERE business_date IS NOT NULL AND location_name IS NOT NULL
    GROUP BY user_id, user_name, location_name, business_date
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log("=== 同一天同地点多次打卡 ===");
  console.table(dupRes.rows);

  // 4. 同一天坐标相距<=150米的打卡对（用简化平面距离估算，1度约111km）
  const coordDupRes = await pool.query(`
    SELECT
      v1.user_id,
      v1.user_name,
      v1.location_name,
      v2.location_name as next_location_name,
      v1.business_date,
      v1.timestamp as first_time,
      v2.timestamp as second_time,
      v1.lat as lat1,
      v1.lng as lng1,
      v2.lat as lat2,
      v2.lng as lng2
    FROM visits v1
    JOIN visits v2 ON v1.user_id = v2.user_id
      AND v1.business_date = v2.business_date
      AND v1.id < v2.id
      AND v1.lat IS NOT NULL AND v1.lng IS NOT NULL
      AND v2.lat IS NOT NULL AND v2.lng IS NOT NULL
    WHERE
      SQRT(
        POW((v1.lat - v2.lat) * 111000, 2) +
        POW((v1.lng - v2.lng) * 111000 * COS(RADIANS(v1.lat)), 2)
      ) <= 150
    ORDER BY v1.user_id, v1.business_date, v1.timestamp
    LIMIT 30
  `);
  console.log("=== 同一天坐标相距<=150米的打卡对 ===");
  console.table(coordDupRes.rows);

  // 5. 相邻签到点之间的时间间隔分布
  const gapRes = await pool.query(`
    WITH sorted AS (
      SELECT
        user_id,
        user_name,
        timestamp,
        location_name,
        LAG(timestamp) OVER (PARTITION BY user_id, business_date ORDER BY timestamp) as prev_time
      FROM visits
      WHERE business_date IS NOT NULL
    )
    SELECT
      CASE
        WHEN gap_min < 10 THEN '<10 min'
        WHEN gap_min < 30 THEN '10-30 min'
        WHEN gap_min < 60 THEN '30-60 min'
        WHEN gap_min < 120 THEN '1-2 h'
        WHEN gap_min < 240 THEN '2-4 h'
        ELSE '>4 h'
      END as gap_range,
      COUNT(*) as cnt
    FROM (
      SELECT user_id, user_name, timestamp, location_name, prev_time,
        EXTRACT(EPOCH FROM (timestamp - prev_time)) / 60 as gap_min
      FROM sorted
      WHERE prev_time IS NOT NULL
    ) t
    GROUP BY gap_range
    ORDER BY MIN(gap_min)
  `);
  console.log("=== 相邻签到点时间间隔分布 ===");
  console.table(gapRes.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
