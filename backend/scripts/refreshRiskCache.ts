import { pool } from "../src/db";
import { persistRiskSummaryCache } from "../src/services/riskSummaryService";

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "all"; // 'all' or 'date=YYYY-MM-DD'

  try {
    if (mode.startsWith("date=")) {
      const date = mode.replace("date=", "");
      console.log(`Refreshing risk summary cache for ${date}...`);
      await persistRiskSummaryCache(date);
      console.log("Done.");
    } else if (mode === "all") {
      // 获取所有有数据的日期
      const result = await pool.query(
        `SELECT DISTINCT DATE(timestamp) as date FROM visits ORDER BY date ASC`
      );
      const dates = result.rows.map((r) => r.date.toISOString().split("T")[0]);
      console.log(`Found ${dates.length} dates to refresh.`);

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        console.log(`[${i + 1}/${dates.length}] Refreshing ${date}...`);
        try {
          await persistRiskSummaryCache(date);
        } catch (err) {
          console.error(`Failed to refresh ${date}:`, err);
        }
      }
      console.log("All done.");
    } else {
      console.log("Usage: ts-node scripts/refreshRiskCache.ts [all|date=YYYY-MM-DD]");
    }
  } catch (err) {
    console.error("Failed to run refresh script:", err);
  } finally {
    await pool.end();
  }
}

main();
