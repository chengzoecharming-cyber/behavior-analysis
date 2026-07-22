import { pool } from "../src/db";
import { computeAndPersistRoutes } from "../src/services/routeService";
import { toBeijingDayStart, toBeijingDayEnd, formatBeijingDate } from "../src/utils/timezone";

async function main() {
  try {
    const result = await pool.query(
      `WITH v AS (
         SELECT DISTINCT user_id, business_date
         FROM visits
         WHERE business_date IS NOT NULL
       ),
       r AS (
         SELECT DISTINCT user_id, business_date
         FROM routes
       )
       SELECT v.user_id, v.business_date
       FROM v
       LEFT JOIN r ON r.user_id = v.user_id AND r.business_date = v.business_date
       WHERE r.user_id IS NULL
       ORDER BY v.business_date, v.user_id`
    );

    const pairs = result.rows as { user_id: string; business_date: Date }[];
    console.log(`Found ${pairs.length} user/date pairs without routes`);

    for (let i = 0; i < pairs.length; i++) {
      const { user_id, business_date } = pairs[i];
      const dateStr = formatBeijingDate(business_date);
      const start = toBeijingDayStart(dateStr);
      const end = toBeijingDayEnd(dateStr);
      try {
        const routes = await computeAndPersistRoutes(user_id, start, end);
        console.log(
          `[${i + 1}/${pairs.length}] Filled ${routes.length} routes for ${user_id} @ ${dateStr}`
        );
      } catch (err: any) {
        console.error(
          `[${i + 1}/${pairs.length}] Failed to fill routes for ${user_id} @ ${dateStr}:`,
          err.message || err
        );
      }
      // 比全量重算更保守，避免高德 QPS / 日限流
      if (i < pairs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log("Fill missing routes done.");
  } catch (err) {
    console.error("Failed to fill missing routes:", err);
  } finally {
    await pool.end();
  }
}

main();
