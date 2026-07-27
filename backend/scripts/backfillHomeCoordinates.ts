/**
 * 回填存量住址坐标：为 users 表中已有 home_address 但缺 home_lat/home_lng 的记录
 * 做一次性地理编码并持久化（带回退简化，串行 + 节流避免高德限流）。
 *
 * 用法：cd backend && npx ts-node scripts/backfillHomeCoordinates.ts [--force]
 *   --force 忽略已有坐标，全部重新解析（住址口径调整后用）
 */
import { pool, initDB } from "../src/db";
import { geocodeAddressWithSimplification } from "../src/services/geocoding";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await initDB();
  const force = process.argv.includes("--force");

  const condition = force
    ? `home_address IS NOT NULL AND home_address <> ''`
    : `home_address IS NOT NULL AND home_address <> '' AND (home_lat IS NULL OR home_lng IS NULL)`;
  const result = await pool.query(
    `SELECT user_id, user_name, home_address FROM users WHERE ${condition} ORDER BY user_name`
  );

  console.log(`待回填坐标 ${result.rows.length} 条`);
  let geocoded = 0;
  const failed: { name: string; address: string }[] = [];

  for (const row of result.rows) {
    const geo = await geocodeAddressWithSimplification(row.home_address);
    await sleep(200);
    if (geo) {
      await pool.query(
        `UPDATE users SET home_lat = $1, home_lng = $2 WHERE user_id = $3`,
        [geo.coords.lat, geo.coords.lng, row.user_id]
      );
      geocoded++;
      const suffix = geo.usedAddress !== row.home_address ? `（用「${geo.usedAddress}」简化命中）` : "";
      console.log(`  [OK] ${row.user_name}: ${row.home_address} → ${geo.coords.lat},${geo.coords.lng} ${suffix}`);
    } else {
      await pool.query(
        `UPDATE users SET home_lat = NULL, home_lng = NULL WHERE user_id = $1`,
        [row.user_id]
      );
      failed.push({ name: row.user_name, address: row.home_address });
      console.log(`  [失败] ${row.user_name}: ${row.home_address}`);
    }
  }

  console.log(`\n完成：${geocoded} 条成功，${failed.length} 条失败`);
  if (failed.length > 0) {
    console.log(`失败记录请人工核实坐标后写入 address_fallback_coordinates 表（address 列填原始住址），再重跑本脚本。`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
