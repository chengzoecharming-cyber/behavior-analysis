import { Router, Request, Response } from "express";
import { pool } from "../db";
import { detectAnomalies } from "../services/anomalyDetection";
import { detectStops } from "../services/stopDetection";
import { planRoute } from "../services/routePlanning";
import { computeAndPersistRoutes } from "../services/routeService";
import {
  computeMileageSegments,
  computeMileageStats,
} from "../services/mileageAnalysis";
import { Visit, Stop, Route, Anomaly } from "../types";

const router = Router();

router.get("/mileage", async (req: Request, res: Response) => {
  const { user, date } = req.query;

  if (!user || !date) {
    res.status(400).json({ error: "Missing user or date parameter" });
    return;
  }

  const start = `${date}T00:00:00+08:00`;
  const end = `${date}T23:59:59+08:00`;

  try {
    let routesResult = await pool.query(
      `SELECT * FROM routes
       WHERE user_id = $1
         AND from_visit_id IN (
           SELECT id FROM visits WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         )`,
      [user, start, end]
    );

    let routes: Route[] = routesResult.rows;
    if (routes.length === 0) {
      routes = await computeAndPersistRoutes(user as string, start, end);
    }

    const totalKm = routes.reduce((sum, r) => sum + r.distance_km, 0);

    res.json({
      user_id: user,
      date,
      totalKm: parseFloat(totalKm.toFixed(2)),
      segmentCount: routes.length,
      estimatedFuelCost: parseFloat((totalKm * 0.8).toFixed(2)), // 假设 0.8 元/km
    });
  } catch (err) {
    console.error("Failed to compute mileage:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/anomaly", async (req: Request, res: Response) => {
  const { user, date } = req.query;

  if (!user || !date) {
    res.status(400).json({ error: "Missing user or date parameter" });
    return;
  }

  const start = `${date}T00:00:00+08:00`;
  const end = `${date}T23:59:59+08:00`;

  try {
    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user, start, end]
    );
    const visits: Visit[] = visitsResult.rows;

    const stops = detectStops(visits);

    const routes: Route[] = [];
    for (let i = 1; i < visits.length; i++) {
      routes.push(await planRoute(visits[i - 1], visits[i], user as string));
    }

    const anomalies = await detectAnomalies(visits, stops, routes);

    // 持久化异常事件
    await pool.query(
      `DELETE FROM anomalies WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [user, start, end]
    );

    const persisted: Anomaly[] = [];
    for (const a of anomalies) {
      const r = await pool.query(
        `INSERT INTO anomalies
         (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
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
        ]
      );
      persisted.push(r.rows[0]);
    }

    res.json(persisted);
  } catch (err) {
    console.error("Failed to detect anomalies:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /analytics/mileage-distribution?start=&end=
// 返回填报里程 vs 高德里程的偏差分布，用于训练集分析
router.get("/mileage-distribution", async (req: Request, res: Response) => {
  const { start, end } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: "Missing start or end parameter" });
    return;
  }

  try {
    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE timestamp >= $1 AND timestamp <= $2
       ORDER BY user_id, timestamp ASC`,
      [start, end]
    );
    const visits: Visit[] = visitsResult.rows;

    const segments = await computeMileageSegments(visits);
    const stats = computeMileageStats(segments);

    res.json({
      start,
      end,
      totalSegments: segments.length,
      stats,
      segments: segments.slice(0, 100), // 最多返回 100 条明细
    });
  } catch (err) {
    console.error("Failed to compute mileage distribution:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
