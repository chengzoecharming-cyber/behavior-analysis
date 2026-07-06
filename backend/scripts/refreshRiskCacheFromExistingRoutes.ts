import { pool } from "../src/db";
import { persistRiskSummaryCache } from "../src/services/riskSummaryService";

async function main() {
  try {
    const result = await pool.query(
      `SELECT DISTINCT business_date FROM visits WHERE business_date IS NOT NULL ORDER BY business_date`
    );
    const dates = result.rows.map((r) => r.business_date.toISOString().split("T")[0]);

    console.log(`Refreshing risk summary cache for ${dates.length} dates...`);
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      try {
        await persistRiskSummaryCache(date, { useExistingRoutes: true });
        console.log(`[${i + 1}/${dates.length}] Refreshed ${date}`);
      } catch (err) {
        console.error(`[${i + 1}/${dates.length}] Failed ${date}:`, err);
      }
    }
    console.log("All done.");
  } catch (err) {
    console.error("Failed to refresh cache:", err);
  } finally {
    await pool.end();
  }
}

main();
