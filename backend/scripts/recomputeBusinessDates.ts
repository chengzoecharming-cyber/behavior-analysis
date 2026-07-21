import { pool } from "../src/db";
import { formatBeijingDate } from "../src/utils/timezone";

async function main() {
  try {
    console.log("[1/3] 查询需要修正的钉钉 visits...");
    const visitsResult = await pool.query(
      `SELECT id, timestamp
       FROM visits
       WHERE source = 'dingtalk'
       ORDER BY id`
    );
    console.log(`找到 ${visitsResult.rows.length} 条钉钉 visits`);

    let updated = 0;
    for (let i = 0; i < visitsResult.rows.length; i++) {
      const row = visitsResult.rows[i];
      const businessDate = formatBeijingDate(new Date(row.timestamp));

      try {
        const updateResult = await pool.query(
          `UPDATE visits
           SET business_date = $1
           WHERE id = $2`,
          [businessDate, row.id]
        );
        updated += updateResult.rowCount || 0;

        if ((i + 1) % 500 === 0 || i === visitsResult.rows.length - 1) {
          console.log(`[${i + 1}/${visitsResult.rows.length}] 已更新 ${updated} 条 visits`);
        }
      } catch (err) {
        console.error(`[${i + 1}/${visitsResult.rows.length}] visit ${row.id} 处理失败:`, err);
      }
    }

    console.log(`[3/3] 共更新 ${updated} 条 visits 的 business_date`);
    console.log("All done.");
  } catch (err) {
    console.error("Failed to run recomputeBusinessDates:", err);
  } finally {
    await pool.end();
  }
}

main();
