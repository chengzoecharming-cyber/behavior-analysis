import { pool } from "../db";
import { detectAnomalies } from "./anomalyDetection";
import { detectStops } from "./stopDetection";
import { planRoute } from "./routePlanning";
import { calculateRiskScore, getRiskLevel, RiskReason } from "./riskScoring";
import { Visit, Stop, Route } from "../types";

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

export interface RiskSummaryResult {
  date: string;
  start_date?: string;
  end_date?: string;
  total_employees: number;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  employees: EmployeeRiskSummary[];
  from_cache: boolean;
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

export async function computeEmployeeRiskSummary(
  userId: string,
  userName: string,
  department: string,
  dateStr: string
): Promise<EmployeeRiskSummary> {
  const start = `${dateStr}T00:00:00+08:00`;
  const end = `${dateStr}T23:59:59+08:00`;

  // 当天拜访记录
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
    [userId, start, end]
  );
  const visitsToday: Visit[] = visitsResult.rows;

  // 跨天数据范围
  const past5Workdays = getPastWorkdaysRange(5, dateStr);
  const past2Weeks = getPastDaysRange(14, dateStr);

  const past5WorkdaysResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
    [userId, past5Workdays.start, past5Workdays.end]
  );
  const visitsPast5Workdays: Visit[] = past5WorkdaysResult.rows;

  const past2WeeksResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
    [userId, past2Weeks.start, past2Weeks.end]
  );
  const visitsPast2Weeks: Visit[] = past2WeeksResult.rows;

  // 停留点
  const stopsResult = await pool.query(
    `SELECT * FROM stops
     WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3
     ORDER BY start_time ASC`,
    [userId, start, end]
  );
  const stops: Stop[] = stopsResult.rows;

  // 路径（优先用已持久化的 routes，缺失的并行补算）
  // 仅查询相邻 visit 之间的 route，避免返回非相邻历史 route
  const adjacentPairs = [] as [number, number][];
  for (let i = 1; i < visitsToday.length; i++) {
    adjacentPairs.push([visitsToday[i - 1].id, visitsToday[i].id]);
  }

  let existingRoutes: Route[] = [];
  if (adjacentPairs.length > 0) {
    const fromIds = adjacentPairs.map(([a]) => a);
    const toIds = adjacentPairs.map(([, b]) => b);
    const routesResult = await pool.query(
      `SELECT * FROM routes
       WHERE user_id = $1
         AND (from_visit_id, to_visit_id) IN (
           SELECT * FROM unnest($2::int[], $3::int[]) AS t(from_id, to_id)
         )
       ORDER BY from_visit_id`,
      [userId, fromIds, toIds]
    );
    existingRoutes = routesResult.rows;
  }
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

  // 检测异常
  const anomalies = await detectAnomalies({
    userId,
    analysisDate: new Date(dateStr),
    visitsToday,
    stopsToday: stops,
    routesToday: routes,
    visitsPast5Workdays,
    visitsPast2Weeks,
  });

  // 计算风险分数
  const { score, reasons } = await calculateRiskScore(anomalies);
  const riskLevel = getRiskLevel(score);

  const highAnomalies = anomalies.filter((a) => a.severity === "high");
  const mediumAnomalies = anomalies.filter((a) => a.severity === "medium");
  const lowAnomalies = anomalies.filter((a) => a.severity === "low");

  const totalStopMinutes = stops.reduce((sum, s) => sum + s.duration_minutes, 0);
  const totalDistance = routes.reduce((sum, r) => sum + r.distance_km, 0);

  return {
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
}

export async function computeRiskSummaryForDate(dateStr: string): Promise<RiskSummaryResult> {
  const start = `${dateStr}T00:00:00+08:00`;
  const end = `${dateStr}T23:59:59+08:00`;

  const usersResult = await pool.query(
    `SELECT DISTINCT user_id, user_name, department
     FROM visits
     WHERE timestamp >= $1 AND timestamp <= $2
     ORDER BY department, user_name`,
    [start, end]
  );

  // 并行计算所有员工的风险摘要
  const summaryPromises = usersResult.rows.map((user) =>
    computeEmployeeRiskSummary(user.user_id, user.user_name, user.department || "", dateStr)
  );
  const summaries = await Promise.all(summaryPromises);

  summaries.sort((a, b) => b.risk_score - a.risk_score);

  return {
    date: dateStr,
    total_employees: summaries.length,
    high_risk_count: summaries.filter((s) => s.risk_level === "high").length,
    medium_risk_count: summaries.filter((s) => s.risk_level === "medium").length,
    low_risk_count: summaries.filter((s) => s.risk_level === "low").length,
    employees: summaries,
    from_cache: false,
  };
}

export async function getRiskSummaryCache(dateStr: string): Promise<RiskSummaryResult | null> {
  const result = await pool.query(
    `SELECT * FROM risk_summary_cache WHERE date = $1 ORDER BY risk_score DESC`,
    [dateStr]
  );

  if (result.rows.length === 0) return null;

  const employees: EmployeeRiskSummary[] = result.rows.map((row) => ({
    user_id: row.user_id,
    user_name: row.user_name || row.user_id,
    department: row.department || "",
    risk_score: row.risk_score,
    risk_level: row.risk_level,
    anomaly_count: row.anomaly_count,
    high_anomaly_count: row.high_anomaly_count,
    medium_anomaly_count: row.medium_anomaly_count,
    low_anomaly_count: row.low_anomaly_count,
    visit_count: row.visit_count,
    total_stop_minutes: row.total_stop_minutes,
    total_distance_km: row.total_distance_km,
    risk_reasons: row.reasons || [],
    summary_text: "",
  }));

  return {
    date: dateStr,
    total_employees: employees.length,
    high_risk_count: employees.filter((s) => s.risk_level === "high").length,
    medium_risk_count: employees.filter((s) => s.risk_level === "medium").length,
    low_risk_count: employees.filter((s) => s.risk_level === "low").length,
    employees,
    from_cache: true,
  };
}

export async function persistRiskSummaryCache(dateStr: string): Promise<void> {
  const result = await computeRiskSummaryForDate(dateStr);

  await pool.query(`DELETE FROM risk_summary_cache WHERE date = $1`, [dateStr]);

  for (const emp of result.employees) {
    await pool.query(
      `INSERT INTO risk_summary_cache
       (user_id, user_name, department, date, risk_score, risk_level, anomaly_count, high_anomaly_count,
        medium_anomaly_count, low_anomaly_count, visit_count, total_stop_minutes,
        total_distance_km, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        emp.user_id,
        emp.user_name,
        emp.department,
        dateStr,
        emp.risk_score,
        emp.risk_level,
        emp.anomaly_count,
        emp.high_anomaly_count,
        emp.medium_anomaly_count,
        emp.low_anomaly_count,
        emp.visit_count,
        emp.total_stop_minutes,
        emp.total_distance_km,
        JSON.stringify(emp.risk_reasons),
      ]
    );
  }
}

export async function getRiskSummary(dateStr: string): Promise<RiskSummaryResult> {
  const today = new Date().toISOString().split("T")[0];

  // 今天及以后的日期实时计算
  if (dateStr >= today) {
    return computeRiskSummaryForDate(dateStr);
  }

  // 历史日期优先读缓存
  const cached = await getRiskSummaryCache(dateStr);
  if (cached) return cached;

  // 缓存未命中则实时计算并写入缓存
  const result = await computeRiskSummaryForDate(dateStr);
  await persistRiskSummaryCache(dateStr);
  return { ...result, from_cache: false };
}

// 生成 [startStr, endStr] 之间（含）的所有日期字符串（YYYY-MM-DD），按本地日期处理
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

function mergeRiskReasons(reasonsList: RiskReason[][]): RiskReason[] {
  const map = new Map<string, RiskReason>();
  for (const reasons of reasonsList) {
    for (const r of reasons) {
      const key = `${r.type}|${r.severity}`;
      const existing = map.get(key);
      if (existing) {
        existing.count = (existing.count || 1) + (r.count || 1);
      } else {
        map.set(key, { ...r, count: r.count || 1 });
      }
    }
  }
  return Array.from(map.values());
}

export async function getRiskSummaryRange(
  startStr: string,
  endStr: string
): Promise<RiskSummaryResult> {
  const dates = eachDate(startStr, endStr);

  // 逐日获取风险摘要（优先缓存，缺失则实时计算）
  const dailyResults = await Promise.all(
    dates.map((date) => getRiskSummary(date))
  );

  // 按员工聚合（使用 visit_count 加权的平均分）
  type AccEmp = EmployeeRiskSummary & { _scoreSum: number; _visitWeight: number };
  const employeeMap = new Map<string, AccEmp>();

  for (const daily of dailyResults) {
    for (const emp of daily.employees) {
      const existing = employeeMap.get(emp.user_id);
      if (!existing) {
        employeeMap.set(emp.user_id, {
          ...emp,
          _scoreSum: emp.risk_score * emp.visit_count,
          _visitWeight: emp.visit_count,
        });
        continue;
      }

      existing._scoreSum += emp.risk_score * emp.visit_count;
      existing._visitWeight += emp.visit_count;
      const avgScore =
        existing._visitWeight > 0
          ? Math.ceil(existing._scoreSum / existing._visitWeight)
          : 0;

      const levelRank = { low: 1, medium: 2, high: 3 };
      const highestLevel: "high" | "medium" | "low" =
        levelRank[existing.risk_level] >= levelRank[emp.risk_level]
          ? existing.risk_level
          : emp.risk_level;

      existing.risk_score = avgScore;
      existing.risk_level = highestLevel;
      existing.anomaly_count += emp.anomaly_count;
      existing.high_anomaly_count += emp.high_anomaly_count;
      existing.medium_anomaly_count += emp.medium_anomaly_count;
      existing.low_anomaly_count += emp.low_anomaly_count;
      existing.visit_count += emp.visit_count;
      existing.total_stop_minutes += emp.total_stop_minutes;
      existing.total_distance_km = parseFloat(
        (existing.total_distance_km + emp.total_distance_km).toFixed(2)
      );
      existing.risk_reasons = mergeRiskReasons([
        existing.risk_reasons,
        emp.risk_reasons,
      ]);
      existing.summary_text = generateSummaryText(
        existing.user_name,
        highestLevel,
        existing.anomaly_count,
        existing.high_anomaly_count,
        existing.visit_count,
        existing.total_stop_minutes
      );
    }
  }

  const employees = Array.from(employeeMap.values())
    .map((emp) => {
      const { _scoreSum, _visitWeight, ...rest } = emp;
      return rest;
    })
    .sort((a, b) => b.risk_score - a.risk_score);

  return {
    date: `${startStr} ~ ${endStr}`,
    start_date: startStr,
    end_date: endStr,
    total_employees: employees.length,
    high_risk_count: employees.filter((s) => s.risk_level === "high").length,
    medium_risk_count: employees.filter((s) => s.risk_level === "medium").length,
    low_risk_count: employees.filter((s) => s.risk_level === "low").length,
    employees,
    from_cache: dailyResults.every((d) => d.from_cache),
  };
}
