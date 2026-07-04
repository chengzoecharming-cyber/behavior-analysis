import { pool } from "../db";
import { detectAnomalies } from "./anomalyDetection";
import { detectStops } from "./stopDetection";
import { computeAndPersistRoutes } from "./routeService";
import { calculateRiskScore, getRiskLevel, RiskReason } from "./riskScoring";
import { Visit, Stop, Route } from "../types";
import {
  toBeijingDayStart,
  toBeijingDayEnd,
  formatBeijingDate,
  getBeijingWeekday,
  parseDateTimeAsBeijing,
} from "../utils/timezone";

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

export interface RiskSummaryComputeOptions {
  useExistingRoutes?: boolean;
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

// 计算包含 endDate 当天在内的最近 N 个工作日范围（按北京时间）
function getPastWorkdaysRange(n: number, endDateStr: string): { start: string; end: string } {
  const end = new Date(toBeijingDayEnd(endDateStr));
  let count = 0;
  const start = new Date(end);
  while (count < n) {
    const day = getBeijingWeekday(start);
    if (day !== 0 && day !== 6) {
      count++;
    }
    if (count < n) {
      start.setTime(start.getTime() - 24 * 60 * 60 * 1000);
    }
  }
  // start 已经对齐到北京时间 00:00，无需再调 setHours
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function getPastDaysRange(n: number, endDateStr: string): { start: string; end: string } {
  const end = new Date(toBeijingDayEnd(endDateStr));
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
  dateStr: string,
  options: RiskSummaryComputeOptions = {}
): Promise<EmployeeRiskSummary> {
  // 当天拜访记录
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND business_date = $2::date
     ORDER BY timestamp ASC`,
    [userId, dateStr]
  );
  const visitsToday: Visit[] = visitsResult.rows;

  // 跨天数据范围
  const past5Workdays = getPastWorkdaysRange(5, dateStr);
  const past2Weeks = getPastDaysRange(14, dateStr);

  const past5WorkdaysResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1
       AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
     ORDER BY timestamp ASC`,
    [userId, past5Workdays.start, past5Workdays.end]
  );
  const visitsPast5Workdays: Visit[] = past5WorkdaysResult.rows;

  const past2WeeksResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1
       AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
     ORDER BY timestamp ASC`,
    [userId, past2Weeks.start, past2Weeks.end]
  );
  const visitsPast2Weeks: Visit[] = past2WeeksResult.rows;

  // 停留点
  const stopsResult = await pool.query(
    `SELECT * FROM stops
     WHERE user_id = $1 AND business_date = $2::date
     ORDER BY start_time ASC`,
    [userId, dateStr]
  );
  const stops: Stop[] = stopsResult.rows;

  // 路径：按 approval_id 分组计算并持久化，避免跨审批串点
  const dayStart = toBeijingDayStart(dateStr);
  const dayEnd = toBeijingDayEnd(dateStr);
  const routes: Route[] = options.useExistingRoutes
    ? (
        await pool.query(
          `SELECT * FROM routes
           WHERE user_id = $1 AND business_date = $2::date
           ORDER BY id ASC`,
          [userId, dateStr]
        )
      ).rows
    : await computeAndPersistRoutes(userId, dayStart, dayEnd);

  // 检测异常
  const anomalies = await detectAnomalies({
    userId,
    analysisDate: parseDateTimeAsBeijing(dateStr),
    visitsToday,
    stopsToday: stops,
    routesToday: routes,
    visitsPast5Workdays,
    visitsPast2Weeks,
  });

  // 排除已批准的申诉豁免区间
  const exceptionsResult = await pool.query(
    `SELECT 1 FROM anomaly_exceptions
     WHERE user_id = $1 AND start_date <= $2::date AND end_date >= $2::date`,
    [userId, dateStr]
  );
  const isExempt = exceptionsResult.rows.length > 0;
  const effectiveAnomalies = isExempt ? [] : anomalies;

  // 计算风险分数
  const { score, reasons } = await calculateRiskScore(effectiveAnomalies);
  const riskLevel = getRiskLevel(score);

  const highAnomalies = effectiveAnomalies.filter((a) => a.severity === "high");
  const mediumAnomalies = effectiveAnomalies.filter((a) => a.severity === "medium");
  const lowAnomalies = effectiveAnomalies.filter((a) => a.severity === "low");

  // 持久化异常事件（按用户 + 业务日期），供范围查询使用
  await pool.query(
    `DELETE FROM anomalies WHERE user_id = $1 AND anomaly_date = $2::date`,
    [userId, dateStr]
  );
  for (const a of effectiveAnomalies) {
    await pool.query(
      `INSERT INTO anomalies
       (user_id, type, description, start_time, end_time, lat, lng, severity, related_visit_ids, metadata, anomaly_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      ]
    );
  }

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

export async function computeRiskSummaryForDate(
  dateStr: string,
  options: RiskSummaryComputeOptions = {}
): Promise<RiskSummaryResult> {
  const usersResult = await pool.query(
    `SELECT DISTINCT user_id, user_name, department
     FROM visits
     WHERE business_date = $1::date
     ORDER BY department, user_name`,
    [dateStr]
  );

  // 并行计算所有员工的风险摘要
  const summaryPromises = usersResult.rows.map((user) =>
    computeEmployeeRiskSummary(
      user.user_id,
      user.user_name,
      user.department || "",
      dateStr,
      options
    )
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

export async function persistRiskSummaryCache(
  dateStr: string,
  options: RiskSummaryComputeOptions = {}
): Promise<void> {
  const result = await computeRiskSummaryForDate(dateStr, options);

  await pool.query(`DELETE FROM risk_summary_cache WHERE date = $1`, [dateStr]);

  for (const emp of result.employees) {
    await pool.query(
      `INSERT INTO risk_summary_cache
       (user_id, user_name, department, date, risk_score, risk_level, anomaly_count, high_anomaly_count,
        medium_anomaly_count, low_anomaly_count, visit_count, total_stop_minutes,
        total_distance_km, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_id, date)
       DO UPDATE SET
         user_name = EXCLUDED.user_name,
         department = EXCLUDED.department,
         risk_score = EXCLUDED.risk_score,
         risk_level = EXCLUDED.risk_level,
         anomaly_count = EXCLUDED.anomaly_count,
         high_anomaly_count = EXCLUDED.high_anomaly_count,
         medium_anomaly_count = EXCLUDED.medium_anomaly_count,
         low_anomaly_count = EXCLUDED.low_anomaly_count,
         visit_count = EXCLUDED.visit_count,
         total_stop_minutes = EXCLUDED.total_stop_minutes,
         total_distance_km = EXCLUDED.total_distance_km,
         reasons = EXCLUDED.reasons`,
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
  const today = formatBeijingDate(new Date());

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

// 生成 [startStr, endStr] 之间（含）的所有北京日期字符串（YYYY-MM-DD）
function eachDate(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const parse = (s: string) => {
    const datePart = s.slice(0, 10);
    return new Date(`${datePart}T00:00:00+08:00`);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    dates.push(formatBeijingDate(current));
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
