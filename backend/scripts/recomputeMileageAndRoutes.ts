import { pool } from "../src/db";
import { computeAndPersistRoutes } from "../src/services/routeService";
import { persistRiskSummaryCache } from "../src/services/riskSummaryService";
import { toBeijingDayStart, toBeijingDayEnd, formatBeijingDate } from "../src/utils/timezone";

async function main() {
  const isFull = process.argv.includes("--full");

  try {
    if (isFull) {
      console.log("[1/3] Clearing existing routes (--full mode)...");
      await pool.query("DELETE FROM routes");
    } else {
      console.log("[1/3] Incremental mode: only recompute missing routes...");
    }

    const pairsResult = await pool.query(
      `SELECT DISTINCT user_id, business_date
       FROM visits
       WHERE business_date IS NOT NULL
       ORDER BY business_date, user_id`
    );
    const allPairs = pairsResult.rows as {
      user_id: string;
      business_date: Date;
    }[];

    let pairs = allPairs;
    if (!isFull) {
      // 只保留没有 routes 的 user/date 对
      const routesResult = await pool.query(
        `SELECT DISTINCT user_id, business_date FROM routes`
      );
      const routeSet = new Set(
        routesResult.rows.map(
          (r) => `${r.user_id}_${formatBeijingDate(r.business_date)}`
        )
      );
      pairs = allPairs.filter((p) => {
        const key = `${p.user_id}_${formatBeijingDate(p.business_date)}`;
        return !routeSet.has(key);
      });
    }

    console.log(
      `[2/3] Recomputing routes for ${pairs.length}/${allPairs.length} user/date pairs...`
    );

    for (let i = 0; i < pairs.length; i++) {
      const { user_id, business_date } = pairs[i];
      const dateStr = formatBeijingDate(business_date);
      const start = toBeijingDayStart(dateStr);
      const end = toBeijingDayEnd(dateStr);
      try {
        const routes = await computeAndPersistRoutes(user_id, start, end);
        console.log(
          `[${i + 1}/${pairs.length}] Routes recomputed: ${user_id} @ ${dateStr} (${routes.length} segments)`
        );
      } catch (err) {
        console.error(
          `[${i + 1}/${pairs.length}] Failed routes for ${user_id} @ ${dateStr}:`,
          err
        );
      }
      // 避免高德 QPS / 日限流，每对之间间隔 500ms
      if (i < pairs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const datesResult = await pool.query(
      `SELECT DISTINCT business_date
       FROM visits
       WHERE business_date IS NOT NULL
       ORDER BY business_date`
    );
    const dates = datesResult.rows.map(
      (r) => formatBeijingDate(r.business_date)
    );
    console.log(`[3/3] Refreshing risk summary cache for ${dates.length} dates...`);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      try {
        await persistRiskSummaryCache(date, { useExistingRoutes: true });
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
