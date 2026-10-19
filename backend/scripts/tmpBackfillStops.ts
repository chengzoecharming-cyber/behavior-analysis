/**
 * 历史补算：对指定业务日期范围内每个 user+date 重算停留点（本地计算，不调外部 API）。
 * 用法：npx ts-node scripts/tmpBackfillStops.ts 2025-10-01 2026-05-31
 */
import { pool } from "../src/db";
import { computeAndPersistStops } from "../src/services/stopDetection";
import { formatBeijingDate } from "../src/utils/timezone";

async function main() {
  const start = process.argv[2];
  const end = process.argv[3];
  if (!start || !end) throw new Error("用法: tmpBackfillStops.ts <start> <end>");

  const result = await pool.query(
    `SELECT DISTINCT user_id, business_date FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
     ORDER BY business_date, user_id`,
    [start, end]
  );
  const pairs = result.rows as { user_id: string; business_date: Date }[];
  console.log(`共 ${pairs.length} 个 user+date 待补算 stops`);

  let ok = 0, fail = 0;
  for (let i = 0; i < pairs.length; i++) {
    const dateStr = formatBeijingDate(pairs[i].business_date);
    try {
      const stops = await computeAndPersistStops(pairs[i].user_id, dateStr);
      ok++;
      if ((i + 1) % 100 === 0) console.log(`进度 ${i + 1}/${pairs.length}（${dateStr}，最近一天 ${stops.length} 个停留点）`);
    } catch (e: any) {
      fail++;
      console.error(`失败 ${pairs[i].user_id} @ ${dateStr}: ${e?.message}`);
    }
  }
  console.log(`完成：成功 ${ok}，失败 ${fail}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
