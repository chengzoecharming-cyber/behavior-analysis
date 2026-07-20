import { pool } from "../src/db";
import { detectStops } from "../src/services/stopDetection";
import { detectAnomalies } from "../src/services/anomalyDetection";
import { Visit, Route, Anomaly } from "../src/types";
import {
  toBeijingDayStart,
  toBeijingDayEnd,
  parseDateTimeAsBeijing,
} from "../src/utils/timezone";
import { persistRiskSummaryCache } from "../src/services/riskSummaryService";

async function main() {
  try {
    console.log("[1/4] Clearing existing anomalies...");
    await pool.query("DELETE FROM anomalies");

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
    console.log(`[2/4] Recomputing anomalies for ${pairs.length} user/date pairs...`);

    let computedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < pairs.length; i++) {
      const { user_id, business_date } = pairs[i];
      const dateStr = business_date.toISOString().split("T")[0];
      const start = toBeijingDayStart(dateStr);
      const end = toBeijingDayEnd(dateStr);

      try {
        const visitsResult = await pool.query(
          `SELECT * FROM visits
           WHERE user_id = $1
             AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
             AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
           ORDER BY timestamp ASC`,
          [user_id, start, end]
        );
        const visits: Visit[] = visitsResult.rows;
        if (visits.length === 0) {
          skippedCount++;
          continue;
        }

        const stops = detectStops(visits);

        // 优先使用已持久化的 routes，避免重新调用高德 API
        const routesResult = await pool.query(
          `SELECT * FROM routes
           WHERE user_id = $1
             AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
             AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
          [user_id, start, end]
        );
        const routes: Route[] = routesResult.rows;

        const anomalies = await detectAnomalies({
          userId: user_id,
          analysisDate: parseDateTimeAsBeijing(dateStr),
          visitsToday: visits,
          stopsToday: stops,
          routesToday: routes,
        });

        for (const a of anomalies) {
          await pool.query(
            `INSERT INTO anomalies
             (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids, metadata, anomaly_date, layer)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              a.user_id,
              a.type,
              a.description,
              a.start_time,
              a.end_time,
              a.lat,
              a.lng,
              a.severity,
              a.related_visit_ids,
              a.metadata || {},
              dateStr,
              a.layer || null,
            ]
          );
        }

        computedCount++;
        console.log(
          `[${i + 1}/${pairs.length}] Anomalies recomputed: ${user_id} @ ${dateStr} (${anomalies.length} anomalies)`
        );
      } catch (err) {
        console.error(
          `[${i + 1}/${pairs.length}] Failed anomalies for ${user_id} @ ${dateStr}:`,
          err
        );
      }
    }

    console.log(`[3/4] Computed ${computedCount} pairs, skipped ${skippedCount} empty pairs.`);

    const datesResult = await pool.query(
      `SELECT DISTINCT business_date
       FROM visits
       WHERE business_date IS NOT NULL
       ORDER BY business_date`
    );
    const dates = datesResult.rows.map(
      (r) => r.business_date.toISOString().split("T")[0]
    );
    console.log(`[4/4] Refreshing risk summary cache for ${dates.length} dates...`);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      try {
        await persistRiskSummaryCache(date, { useExistingRoutes: true });
        console.log(`[${i + 1}/${dates.length}] Risk cache refreshed: ${date}`);
      } catch (err) {
        console.error(`[${i + 1}/${dates.length}] Failed risk cache for ${date}:`, err);
      }
    }

    console.log("All done.");
  } catch (err) {
    console.error("Failed to run recompute anomalies script:", err);
  } finally {
    await pool.end();
  }
}

main();
