import { Router, Request, Response } from "express";
import { pool } from "../db";
import { detectAnomalies } from "../services/anomalyDetection";
import { detectStops } from "../services/stopDetection";

import { computeAndPersistRoutes } from "../services/routeService";
import { MAX_MILEAGE_KM } from "../services/mileageConfig";
import {
  computeMileageSegments,
  computeMileageStats,
} from "../services/mileageAnalysis";
import { computeUserOverview } from "../services/userOverviewService";
import { Visit, Stop, Route, Anomaly } from "../types";
import {
  getAnomalyWeights,
  updateAnomalyWeight,
} from "../services/anomalyWeights";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
  toBeijingDayStart,
  toBeijingDayEnd,
  formatBeijingDate,
  parseDateTimeAsBeijing,
} from "../utils/timezone";

const router = Router();

function eachDate(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const parse = (s: string) => new Date(toBeijingDayStart(s.slice(0, 10)));
  const start = parse(startStr);
  const end = parse(endStr);
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    dates.push(formatBeijingDate(current));
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
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start as string);
      if (isDateOnly) {
        const range = toBeijingRange(start as string, end as string);
        rangeStart = range.start;
        rangeEnd = range.end;
      } else {
        rangeStart = ensureBeijingTimestamp(start as string);
        rangeEnd = ensureBeijingTimestamp(end as string);
      }
      responseDate = { start, end };
    } else if (date) {
      rangeStart = toBeijingDayStart(date as string);
      rangeEnd = toBeijingDayEnd(date as string);
      responseDate = { date };
    } else {
      res.status(400).json({ error: "Missing date or start/end parameter" });
      return;
    }

    let routesResult = await pool.query(
      `SELECT * FROM routes
       WHERE user_id = $1
         AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
         AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
      [user, rangeStart, rangeEnd]
    );

    let routes: Route[] = routesResult.rows;
    if (routes.length === 0 && start && end) {
      // 范围模式：按天补算 route
      const dates = eachDate(start as string, end as string);
      for (const d of dates) {
        const dayStart = toBeijingDayStart(d);
        const dayEnd = toBeijingDayEnd(d);
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

    // 计算填报总里程：钉钉的 reported_distance_km 是累计值，
    // 同一 approval_id 内应取最后一个累计值（MAX），再跨审批求和。
    const reportedResult = await pool.query(
      `SELECT approval_group, MAX(reported_distance_km) AS trip_total
       FROM (
         SELECT reported_distance_km,
                COALESCE(approval_id, user_id || '_' || business_date::text) AS approval_group
         FROM visits
         WHERE user_id = $1
           AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
           AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
           AND (trip_type IS NULL OR trip_type NOT LIKE '%公共交通%')
       ) t
       WHERE reported_distance_km > 0 AND reported_distance_km <= $4
       GROUP BY approval_group`,
      [user, rangeStart, rangeEnd, MAX_MILEAGE_KM]
    );
    const reportedDistanceKm = reportedResult.rows.reduce(
      (sum: number, row: any) => sum + (row.trip_total ? parseFloat(row.trip_total) : 0),
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
    // 范围模式：直接查询已持久化的 anomalies，并排除已批准的申诉豁免
    if (start && end) {
      const result = await pool.query(
        `SELECT a.* FROM anomalies a
         WHERE a.user_id = $1 AND a.anomaly_date >= $2::date AND a.anomaly_date <= $3::date
           AND NOT EXISTS (
             SELECT 1 FROM anomaly_exceptions e
             WHERE e.user_id = a.user_id
               AND a.anomaly_date BETWEEN e.start_date AND e.end_date
           )
         ORDER BY a.created_at ASC`,
        [user, start, end]
      );
      res.json(result.rows);
      return;
    }

    if (!date) {
      res.status(400).json({ error: "Missing date or start/end parameter" });
      return;
    }

    const dayStart = toBeijingDayStart(date as string);
    const dayEnd = toBeijingDayEnd(date as string);

    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND business_date = $2::date
       ORDER BY timestamp ASC`,
      [user, date]
    );
    const visits: Visit[] = visitsResult.rows;

    const stops = detectStops(visits);

    // 按 approval_id 分组计算路线，避免跨审批串点
    const routes: Route[] = await computeAndPersistRoutes(
      user as string,
      dayStart,
      dayEnd
    );

    const anomalies = await detectAnomalies({
      userId: user as string,
      analysisDate: parseDateTimeAsBeijing(date as string),
      visitsToday: visits,
      stopsToday: stops,
      routesToday: routes,
    });

    // 持久化异常事件：按业务日期删除旧记录，避免历史日期重算时残留
    await pool.query(
      `DELETE FROM anomalies WHERE user_id = $1 AND anomaly_date = $2::date`,
      [user, date]
    );

    const persisted: Anomaly[] = [];
    for (const a of anomalies) {
      const r = await pool.query(
        `INSERT INTO anomalies
         (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids, metadata, anomaly_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          date,
        ]
      );
      persisted.push(r.rows[0]);
    }

    // 排除已批准的申诉豁免区间（单日模式：date 落在任一区间内即全部豁免）
    const exceptionsResult = await pool.query(
      `SELECT start_date, end_date FROM anomaly_exceptions
       WHERE user_id = $1 AND start_date <= $2::date AND end_date >= $2::date`,
      [user, date]
    );
    const isExempt = exceptionsResult.rows.length > 0;

    res.json(isExempt ? [] : persisted);
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
    const rangeStart = ensureBeijingTimestamp(start as string);
    const rangeEnd = ensureBeijingTimestamp(end as string);
    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE business_date >= ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
         AND business_date <= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       ORDER BY user_id, timestamp ASC`,
      [rangeStart, rangeEnd]
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


// 单个员工周期总览
router.get("/user-overview", async (req: Request, res: Response) => {
  const { user, start, end } = req.query;

  if (!user || !start || !end) {
    res.status(400).json({ error: "Missing user, start or end parameter" });
    return;
  }

  try {
    const result = await computeUserOverview(
      user as string,
      start as string,
      end as string
    );
    res.json(result);
  } catch (err) {
    console.error("Failed to compute user overview:", err);
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

  const start = toBeijingDayStart(date as string);
  const end = toBeijingDayEnd(date as string);

  try {
    const visitsResult = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user_id, start, end]
    );
    const visits: Visit[] = visitsResult.rows;

    const stops = detectStops(visits);
    const routes: Route[] = await computeAndPersistRoutes(
      user_id as string,
      start,
      end
    );

    const anomalies = await detectAnomalies({
      userId: user_id as string,
      analysisDate: parseDateTimeAsBeijing(date as string),
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
