import { pool } from "../src/db";
import { computeAndPersistRoutes } from "../src/services/routeService";
import { persistRiskSummaryCache } from "../src/services/riskSummaryService";
import { toBeijingDayStart, toBeijingDayEnd } from "../src/utils/timezone";

async function main() {
  try {
    console.log("[1/3] Clearing existing routes...");
    await pool.query("DELETE FROM routes");

    const pairsResult = await pool.query(
      `SELECT DISTINCT user_id, business_date
       FROM visits
       WHERE business_date IS NOT NULL
       ORDER BY business_date, user_id`
    );
    const pairs = pairsResult.rows as {
      user_id: string;
      business_date: Date;
    }[];
    console.log(`[2/3] Recomputing routes for ${pairs.length} user/date pairs...`);

    for (let i = 0; i < pairs.length; i++) {
      const { user_id, business_date } = pairs[i];
      const dateStr = business_date.toISOString().split("T")[0];
      const start = toBeijingDayStart(dateStr);
      const end = toBeijingDayEnd(dateStr);
      try {
        await computeAndPersistRoutes(user_id, start, end);
        console.log(
          `[${i + 1}/${pairs.length}] Routes recomputed: ${user_id} @ ${dateStr}`
        );
      } catch (err) {
        console.error(
          `[${i + 1}/${pairs.length}] Failed routes for ${user_id} @ ${dateStr}:`,
          err
        );
      }
      // 避免请求过快导致网络超时，每对之间间隔 150ms
      if (i < pairs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    const datesResult = await pool.query(
      `SELECT DISTINCT business_date
       FROM visits
       WHERE business_date IS NOT NULL
       ORDER BY business_date`
    );
    const dates = datesResult.rows.map(
      (r) => r.business_date.toISOString().split("T")[0]
    );
    console.log(`[3/3] Refreshing risk summary cache for ${dates.length} dates...`);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      try {
        await persistRiskSummaryCache(date);
        console.log(`[${i + 1}/${dates.length}] Risk cache refreshed: ${date}`);
      } catch (err) {
        console.error(
          `[${i + 1}/${dates.length}] Failed risk cache for ${date}:`,
          err
        );
      }
    }

    console.log("All done.");
  } catch (err) {
    console.error("Failed to run recompute script:", err);
  } finally {
    await pool.end();
  }
}

main();
