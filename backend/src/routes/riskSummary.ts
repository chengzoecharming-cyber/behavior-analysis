import { Router, Request, Response } from "express";
import { pool } from "../db";
import { detectAnomalies } from "../services/anomalyDetection";
import { detectStops } from "../services/stopDetection";
import { planRoute } from "../services/routePlanning";
import { calculateRiskScore, getRiskLevel, RiskReason } from "../services/riskScoring";
import { Visit, Stop, Route } from "../types";

const router = Router();

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

// 计算包含 endDate 当天在内的最近 N 个工作日范围
function getPastWorkdaysRange(n: number, endDateStr: string): { start: string; end: string } {
  const end = new Date(`${endDateStr}T23:59:59+08:00`);
  let count = 0;
  const start = new Date(end);
  while (count < n) {
    const day = start.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
    if (count < n) {
      start.setDate(start.getDate() - 1);
    }
  }
  start.setHours(0, 0, 0, 0);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function getPastDaysRange(n: number, endDateStr: string): { start: string; end: string } {
  const end = new Date(`${endDateStr}T23:59:59+08:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - n);
  start.setHours(0, 0, 0, 0);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
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
  const dateStr = date as string;

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

    // 2. 跨天数据范围
    const past5Workdays = getPastWorkdaysRange(5, dateStr);
    const past2Weeks = getPastDaysRange(14, dateStr);

    for (const user of users) {
      const userId = user.user_id;
      const userName = user.user_name;
      const department = user.department || "";

      // 3. 查询该员工当天的拜访记录
      const visitsResult = await pool.query(
        `SELECT * FROM visits
         WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         ORDER BY timestamp ASC`,
        [userId, start, end]
      );
      const visitsToday: Visit[] = visitsResult.rows;

      // 4. 过去5个工作日拜访记录
      const past5WorkdaysResult = await pool.query(
        `SELECT * FROM visits
         WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         ORDER BY timestamp ASC`,
        [userId, past5Workdays.start, past5Workdays.end]
      );
      const visitsPast5Workdays: Visit[] = past5WorkdaysResult.rows;

      // 5. 过去两周拜访记录
      const past2WeeksResult = await pool.query(
        `SELECT * FROM visits
         WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
         ORDER BY timestamp ASC`,
        [userId, past2Weeks.start, past2Weeks.end]
      );
      const visitsPast2Weeks: Visit[] = past2WeeksResult.rows;

      // 6. 查询停留点
      const stopsResult = await pool.query(
        `SELECT * FROM stops
         WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3
         ORDER BY start_time ASC`,
        [userId, start, end]
      );
      const stops: Stop[] = stopsResult.rows;

      // 7. 查询路径（优先用已持久化的 routes，缺失的并行补算）
      const visitIds = visitsToday.map((v) => v.id);
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
      for (let i = 1; i < visitsToday.length; i++) {
        const pairKey = `${visitsToday[i - 1].id}-${visitsToday[i].id}`;
        if (!existingPairs.has(pairKey)) {
          missingPairs.push({ from: visitsToday[i - 1], to: visitsToday[i] });
        }
      }

      const computedRoutes = await Promise.all(
        missingPairs.map(async (pair) => {
          try {
            const route = await planRoute(pair.from, pair.to, userId);
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

      // 8. 检测异常
      const anomalies = await detectAnomalies({
        userId,
        analysisDate: new Date(dateStr),
        visitsToday,
        stopsToday: stops,
        routesToday: routes,
        visitsPast5Workdays,
        visitsPast2Weeks,
      });

      // 9. 计算风险分数
      const { score, reasons } = await calculateRiskScore(anomalies);
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
        visit_count: visitsToday.length,
        total_stop_minutes: totalStopMinutes,
        total_distance_km: parseFloat(totalDistance.toFixed(2)),
        risk_reasons: reasons,
        summary_text: generateSummaryText(
          userName,
          riskLevel,
          anomalies.length,
          highAnomalies.length,
          visitsToday.length,
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
