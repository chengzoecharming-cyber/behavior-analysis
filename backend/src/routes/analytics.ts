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
import {
  getAnomalyWeights,
  updateAnomalyWeight,
} from "../services/anomalyWeights";

const router = Router();

function eachDate(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const parse = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

router.get("/mileage", async (req: Request, res: Response) => {
  const { user, date, start, end } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  try {
    let rangeStart: string;
    let rangeEnd: string;
    let responseDate: any;

    if (start && end) {
      rangeStart = start as string;
      rangeEnd = end as string;
      responseDate = { start, end };
    } else if (date) {
      rangeStart = `${date}T00:00:00+08:00`;
      rangeEnd = `${date}T23:59:59+08:00`;
      responseDate = { date };
    } else {
      res.status(400).json({ error: "Missing date or start/end parameter" });
      return;
    }

    let routesResult = await pool.query(
      `SELECT * FROM routes
       WHERE user_id = $1
         AND from_visit_id IN (
           SELECT id FROM visits WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         )`,
      [user, rangeStart, rangeEnd]
    );

    let routes: Route[] = routesResult.rows;
    if (routes.length === 0 && start && end) {
      // 范围模式：按天补算 route
      const dates = eachDate(start as string, end as string);
      for (const d of dates) {
        const dayStart = `${d}T00:00:00+08:00`;
        const dayEnd = `${d}T23:59:59+08:00`;
        const dayRoutes = await computeAndPersistRoutes(
          user as string,
          dayStart,
          dayEnd
        );
        routes.push(...dayRoutes);
      }
    } else if (routes.length === 0) {
      routes = await computeAndPersistRoutes(
        user as string,
        rangeStart,
        rangeEnd
      );
    }

    const totalKm = routes.reduce((sum, r) => sum + r.distance_km, 0);

    // 计算填报总里程（累加所有 visit 的 reported_distance_km）
    const visitsResult = await pool.query(
      `SELECT reported_distance_km
       FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
      [user, rangeStart, rangeEnd]
    );
    const reportedDistanceKm = visitsResult.rows.reduce(
      (sum: number, row: any) => sum + (row.reported_distance_km || 0),
      0
    );

    res.json({
      user_id: user,
      ...responseDate,
      totalKm: parseFloat(totalKm.toFixed(2)),
      reportedDistanceKm: parseFloat(reportedDistanceKm.toFixed(2)),
      segmentCount: routes.length,
      estimatedFuelCost: parseFloat((totalKm * 0.8).toFixed(2)), // 假设 0.8 元/km
    });
  } catch (err) {
    console.error("Failed to compute mileage:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/anomaly", async (req: Request, res: Response) => {
  const { user, date, start, end } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  try {
    // 范围模式：直接查询已持久化的 anomalies
    if (start && end) {
      const result = await pool.query(
        `SELECT * FROM anomalies
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at ASC`,
        [user, start, end]
      );
      res.json(result.rows);
      return;
    }

    if (!date) {
      res.status(400).json({ error: "Missing date or start/end parameter" });
      return;
    }

    const dayStart = `${date}T00:00:00+08:00`;
    const dayEnd = `${date}T23:59:59+08:00`;

    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user, dayStart, dayEnd]
    );
    const visits: Visit[] = visitsResult.rows;

    const stops = detectStops(visits);

    const routes: Route[] = [];
    for (let i = 1; i < visits.length; i++) {
      routes.push(await planRoute(visits[i - 1], visits[i], user as string));
    }

    const anomalies = await detectAnomalies({
      userId: user as string,
      analysisDate: new Date(date as string),
      visitsToday: visits,
      stopsToday: stops,
      routesToday: routes,
    });

    // 持久化异常事件
    await pool.query(
      `DELETE FROM anomalies WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [user, dayStart, dayEnd]
    );

    const persisted: Anomaly[] = [];
    for (const a of anomalies) {
      const r = await pool.query(
        `INSERT INTO anomalies
         (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
          a.metadata || {},
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

// 异常规则权重配置
router.get("/anomaly-weights", async (_req: Request, res: Response) => {
  try {
    const weights = await getAnomalyWeights();
    res.json(Object.values(weights));
  } catch (err) {
    console.error("Failed to fetch anomaly weights:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.put("/anomaly-weights/:key", async (req: Request, res: Response) => {
  const { key } = req.params;
  const { weight, threshold_value, enabled, rule_name, description } = req.body;

  try {
    const updated = await updateAnomalyWeight(key, {
      weight,
      threshold_value,
      enabled,
      rule_name,
      description,
    });
    if (!updated) {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("Failed to update anomaly weight:", err);
    res.status(500).json({ error: "Database error" });
  }
});


// 单日风险评分
router.get("/risk-score", async (req: Request, res: Response) => {
  const { user_id, date } = req.query;
  if (!user_id || !date) {
    res.status(400).json({ error: "Missing user_id or date parameter" });
    return;
  }

  const start = `${date}T00:00:00+08:00`;
  const end = `${date}T23:59:59+08:00`;

  try {
    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user_id, start, end]
    );
    const visits: Visit[] = visitsResult.rows;

    const stops = detectStops(visits);
    const routes: Route[] = [];
    for (let i = 1; i < visits.length; i++) {
      routes.push(await planRoute(visits[i - 1], visits[i], user_id as string));
    }

    const anomalies = await detectAnomalies({
      userId: user_id as string,
      analysisDate: new Date(date as string),
      visitsToday: visits,
      stopsToday: stops,
      routesToday: routes,
    });

    const { score, reasons } = await calculateRiskScore(anomalies);

    res.json({
      user_id,
      date,
      risk_score: score,
      risk_level: getRiskLevel(score),
      anomaly_count: anomalies.length,
      reasons,
      anomalies: anomalies.map((a) => ({
        type: a.type,
        description: a.description,
        severity: a.severity,
      })),
    });
  } catch (err) {
    console.error("Failed to compute risk score:", err);
    res.status(500).json({ error: "Database error" });
  }
});

import { calculateRiskScore, getRiskLevel } from "../services/riskScoring";

export default router;
