import { pool } from "../src/db";

async function main() {
  const beijingDate = "2026-06-23";

  // 李艳茹 6.23 当天及前后一点的数据
  const visits = await pool.query(`
    SELECT
      id,
      approval_id,
      sequence,
      timestamp,
      location_name,
      address,
      customer_name,
      source_detail,
      reported_distance_km,
      trip_type,
      vehicle,
      visit_note,
      business_date
    FROM visits
    WHERE user_name = '李艳茹'
      AND business_date BETWEEN '2026-06-22'::date AND '2026-06-25'::date
    ORDER BY timestamp
  `);
  console.log("=== 李艳茹 2026-06-22 ~ 06-25 的拜访记录 ===");
  console.table(visits.rows);

  // 计算相邻点间隔
  console.log("\n=== 相邻点间隔 ===");
  for (let i = 1; i < visits.rows.length; i++) {
    const prev = visits.rows[i - 1];
    const curr = visits.rows[i];
    const gapMin = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / (1000 * 60);
    const gapHours = gapMin / 60;
    console.log(
      `${prev.location_name} (${prev.timestamp}) → ${curr.location_name} (${curr.timestamp}) : ${gapMin.toFixed(1)} 分钟 (${gapHours.toFixed(1)} 小时)`
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
