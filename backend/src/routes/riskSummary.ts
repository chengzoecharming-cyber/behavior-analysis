import { Router, Request, Response } from "express";
import { pool } from "../db";
import { detectAnomalies } from "../services/anomalyDetection";
import { detectStops } from "../services/stopDetection";
import { planRoute } from "../services/routePlanning";
import { Visit, Stop, Route, Anomaly } from "../types";

const router = Router();

export interface RiskReason {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  count: number;
}

export interface EmployeeRiskSummary {
  user_id: string;
  user_name: string;
  department: string;
  risk_score: number;
  risk_level: "high" | "medium" | "low";
  anomaly_count: number;
  high_anomaly_count: number;
  medium_anomaly_count: number;
  low_anomaly_count: number;
  visit_count: number;
  total_stop_minutes: number;
  total_distance_km: number;
  risk_reasons: RiskReason[];
  summary_text: string;
}

// 计算风险分数
function calculateRiskScore(anomalies: Anomaly[]): { score: number; reasons: RiskReason[] } {
  const weights: Record<string, number> = {
    long_stop: 25,
    long_idle: 30,
    route_detour: 20,
  };

  const severityMultiplier: Record<string, number> = {
    high: 2,
    medium: 1,
    low: 0.5,
  };

  let score = 0;
  const grouped: Record<string, { severity: string; count: number; description: string }> = {};

  for (const a of anomalies) {
    const type = a.type || "unknown";
    if (!grouped[type]) {
      grouped[type] = { severity: a.severity, count: 0, description: a.description };
    }
    grouped[type].count += 1;
  }

  const reasons: RiskReason[] = [];
  for (const [type, info] of Object.entries(grouped)) {
    const weight = weights[type] || 15;
    const multiplier = severityMultiplier[info.severity] || 1;
    const typeScore = weight * info.count * multiplier;
    score += typeScore;
    reasons.push({
      type,
      description: info.description,
      severity: info.severity as "low" | "medium" | "high",
      count: info.count,
    });
  }

  // 基础分：无异常时给一个低分
  if (score === 0) {
    score = 5;
  }

  return { score: Math.min(Math.round(score), 100), reasons };
}

function getRiskLevel(score: number): "high" | "medium" | "low" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function generateSummaryText(
  userName: string,
  riskLevel: string,
  anomalyCount: number,
  highCount: number,
  visitCount: number,
  stopMinutes: number
): string {
  if (riskLevel === "high") {
    return `${userName} 今日存在 ${highCount} 项高风险异常，共 ${anomalyCount} 个异常事件，建议立即关注。`;
  }
  if (riskLevel === "medium") {
    return `${userName} 今日有 ${anomalyCount} 个异常事件，${stopMinutes > 120 ? "停留时间较长" : "路线存在偏差"}，需留意。`;
  }
  return `${userName} 今日完成 ${visitCount} 次拜访，行程正常，无显著风险。`;
}

// GET /analytics/risk-summary?date=YYYY-MM-DD
router.get("/risk-summary", async (req: Request, res: Response) => {
  const { date } = req.query;
  if (!date) {
    res.status(400).json({ error: "Missing date parameter" });
    return;
  }

  const start = `${date}T00:00:00+08:00`;
  const end = `${date}T23:59:59+08:00`;

  try {
    // 1. 获取当天所有有数据的员工
    const usersResult = await pool.query(
      `SELECT DISTINCT user_id, user_name, department
       FROM visits
       WHERE timestamp >= $1 AND timestamp <= $2
       ORDER BY department, user_name`,
      [start, end]
    );

    const users = usersResult.rows;
    const summaries: EmployeeRiskSummary[] = [];

    for (const user of users) {
      const userId = user.user_id;
      const userName = user.user_name;
      const department = user.department || "";

      // 2. 查询该员工当天的拜访记录
      const visitsResult = await pool.query(
        `SELECT * FROM visits
         WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         ORDER BY timestamp ASC`,
        [userId, start, end]
      );
      const visits: Visit[] = visitsResult.rows;

      // 3. 查询停留点
      const stopsResult = await pool.query(
        `SELECT * FROM stops
         WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3
         ORDER BY start_time ASC`,
        [userId, start, end]
      );
      const stops: Stop[] = stopsResult.rows;

      // 4. 查询路径（优先用已持久化的 routes，缺失的并行补算）
      const visitIds = visits.map((v) => v.id);
      const routesResult = await pool.query(
        `SELECT * FROM routes
         WHERE user_id = $1
           AND from_visit_id = ANY($2::int[])
           AND to_visit_id = ANY($2::int[])
         ORDER BY from_visit_id`,
        [userId, visitIds]
      );
      const existingRoutes: Route[] = routesResult.rows;
      const existingPairs = new Set(
        existingRoutes.map((r) => `${r.from_visit_id}-${r.to_visit_id}`)
      );

      const missingPairs: { from: Visit; to: Visit }[] = [];
      for (let i = 1; i < visits.length; i++) {
        const pairKey = `${visits[i - 1].id}-${visits[i].id}`;
        if (!existingPairs.has(pairKey)) {
          missingPairs.push({ from: visits[i - 1], to: visits[i] });
        }
      }

      const computedRoutes = await Promise.all(
        missingPairs.map(async (pair) => {
          try {
            const route = await planRoute(pair.from, pair.to, userId);
            // 持久化新计算的 route（避免重复）
            const existing = await pool.query(
              `SELECT id FROM routes
               WHERE user_id = $1 AND from_visit_id = $2 AND to_visit_id = $3`,
              [userId, route.from_visit_id, route.to_visit_id]
            );
            if (existing.rows.length === 0) {
              await pool.query(
                `INSERT INTO routes (user_id, from_visit_id, to_visit_id, distance_km, duration_min, polyline)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                  userId,
                  route.from_visit_id,
                  route.to_visit_id,
                  route.distance_km,
                  route.duration_min,
                  route.polyline,
                ]
              );
            }
            return route;
          } catch {
            return null;
          }
        })
      );

      const routes: Route[] = [
        ...existingRoutes,
        ...(computedRoutes.filter((r) => r !== null) as Route[]),
      ];

      // 5. 检测异常
      const anomalies = await detectAnomalies(visits, stops, routes);

      // 6. 计算风险分数
      const { score, reasons } = calculateRiskScore(anomalies);
      const riskLevel = getRiskLevel(score);

      const highAnomalies = anomalies.filter((a) => a.severity === "high");
      const mediumAnomalies = anomalies.filter((a) => a.severity === "medium");
      const lowAnomalies = anomalies.filter((a) => a.severity === "low");

      const totalStopMinutes = stops.reduce((sum, s) => sum + s.duration_minutes, 0);
      const totalDistance = routes.reduce((sum, r) => sum + r.distance_km, 0);

      const summary: EmployeeRiskSummary = {
        user_id: userId,
        user_name: userName,
        department,
        risk_score: score,
        risk_level: riskLevel,
        anomaly_count: anomalies.length,
        high_anomaly_count: highAnomalies.length,
        medium_anomaly_count: mediumAnomalies.length,
        low_anomaly_count: lowAnomalies.length,
        visit_count: visits.length,
        total_stop_minutes: totalStopMinutes,
        total_distance_km: parseFloat(totalDistance.toFixed(2)),
        risk_reasons: reasons,
        summary_text: generateSummaryText(
          userName,
          riskLevel,
          anomalies.length,
          highAnomalies.length,
          visits.length,
          totalStopMinutes
        ),
      };

      summaries.push(summary);
    }

    // 按风险分数降序排序
    summaries.sort((a, b) => b.risk_score - a.risk_score);

    res.json({
      date,
      total_employees: summaries.length,
      high_risk_count: summaries.filter((s) => s.risk_level === "high").length,
      medium_risk_count: summaries.filter((s) => s.risk_level === "medium").length,
      low_risk_count: summaries.filter((s) => s.risk_level === "low").length,
      employees: summaries,
    });
  } catch (err) {
    console.error("Failed to compute risk summary:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
