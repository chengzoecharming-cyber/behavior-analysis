import { pool } from "../db";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { formatBeijingDate } from "../utils/timezone";
import {
  computeMileageByApprovalForUsers,
  aggregateMileageByUserDate,
} from "./mileageAnalysis";

export interface DailyOverview {
  date: string;
  visit_count: number;
  stop_minutes: number;
  reported_distance_km: number;
  estimated_distance_km: number;
  anomaly_count: number;
  has_mileage_reading_invalid?: boolean;
}

export interface UserOverviewAnomaly {
  id: number;
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  anomaly_date: string;
  metadata: Record<string, any>;
}

export interface UserOverviewResult {
  user_id: string;
  start: string;
  end: string;
  totals: {
    visit_count: number;
    stop_minutes: number;
    reported_distance_km: number;
    estimated_distance_km: number;
    anomaly_count: number;
  };
  daily: DailyOverview[];
  anomalies: UserOverviewAnomaly[];
}

/**
 * 查询单个员工在指定日期范围内的每日聚合数据。
 */
export async function computeUserOverview(
  userId: string,
  startDate: string,
  endDate: string
): Promise<UserOverviewResult> {
  // 1. 每日拜访次数
  const visitResult = await pool.query(
    `SELECT business_date, COUNT(*) as visit_count
     FROM visits
     WHERE user_id = $1
       AND business_date >= $2::date
       AND business_date <= $3::date
     GROUP BY business_date
     ORDER BY business_date`,
    [userId, startDate, endDate]
  );

  // 2. 每日填报里程与估算里程：按审批单首次签到日期聚合（仅驾车段）
  const mileageResults = await computeMileageByApprovalForUsers(
    [userId],
    startDate,
    endDate
  );
  const byUserDate = aggregateMileageByUserDate(mileageResults);

  // 4. 每日停留时长
  const stopResult = await pool.query(
    `SELECT business_date, COALESCE(SUM(duration_minutes), 0) AS stop_minutes
     FROM stops
     WHERE user_id = $1
       AND business_date >= $2::date
       AND business_date <= $3::date
     GROUP BY business_date
     ORDER BY business_date`,
    [userId, startDate, endDate]
  );

  // 5. 每日异常数
  const anomalyCountResult = await pool.query(
    `SELECT anomaly_date, COUNT(*) AS anomaly_count
     FROM anomalies
     WHERE user_id = $1
       AND anomaly_date >= $2::date
       AND anomaly_date <= $3::date
     GROUP BY anomaly_date
     ORDER BY anomaly_date`,
    [userId, startDate, endDate]
  );

  // 6. 异常明细（时间线）
  const anomalyDetailResult = await pool.query(
    `SELECT id, type, description, severity, anomaly_date, metadata
     FROM anomalies
     WHERE user_id = $1
       AND anomaly_date >= $2::date
       AND anomaly_date <= $3::date
     ORDER BY anomaly_date DESC, created_at DESC`,
    [userId, startDate, endDate]
  );

  // 标记存在里程读数异常的日期
  const mileageInvalidDates = new Set<string>();
  for (const row of anomalyDetailResult.rows) {
    if (row.type === "mileage_reading_invalid") {
      mileageInvalidDates.add(formatDate(row.anomaly_date));
    }
  }

  // 合并数据
  const dateMap = new Map<string, DailyOverview>();

  const ensureDay = (date: string) => {
    if (!dateMap.has(date)) {
      dateMap.set(date, {
        date,
        visit_count: 0,
        stop_minutes: 0,
        reported_distance_km: 0,
        estimated_distance_km: 0,
        anomaly_count: 0,
      });
    }
    return dateMap.get(date)!;
  };

  for (const row of visitResult.rows) {
    const d = ensureDay(formatDate(row.business_date));
    d.visit_count = parseInt(row.visit_count, 10);
  }
  for (const [key, vals] of byUserDate) {
    const date = key.split("_").pop() || "";
    const d = ensureDay(date);
    d.reported_distance_km = vals.reportedKm;
    d.estimated_distance_km = vals.estimatedKm;
  }
  for (const row of stopResult.rows) {
    const d = ensureDay(formatDate(row.business_date));
    d.stop_minutes = parseInt(row.stop_minutes, 10) || 0;
  }
  for (const row of anomalyCountResult.rows) {
    const d = ensureDay(formatDate(row.anomaly_date));
    d.anomaly_count = parseInt(row.anomaly_count, 10) || 0;
  }

  for (const date of mileageInvalidDates) {
    const d = dateMap.get(date);
    if (d) {
      d.has_mileage_reading_invalid = true;
    }
  }

  const daily = Array.from(dateMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const totals = daily.reduce(
    (acc, cur) => ({
      visit_count: acc.visit_count + cur.visit_count,
      stop_minutes: acc.stop_minutes + cur.stop_minutes,
      reported_distance_km: acc.reported_distance_km + cur.reported_distance_km,
      estimated_distance_km:
        acc.estimated_distance_km + cur.estimated_distance_km,
      anomaly_count: acc.anomaly_count + cur.anomaly_count,
    }),
    {
      visit_count: 0,
      stop_minutes: 0,
      reported_distance_km: 0,
      estimated_distance_km: 0,
      anomaly_count: 0,
    }
  );

  return {
    user_id: userId,
    start: startDate,
    end: endDate,
    totals: {
      visit_count: totals.visit_count,
      stop_minutes: totals.stop_minutes,
      reported_distance_km: parseFloat(
        totals.reported_distance_km.toFixed(2)
      ),
      estimated_distance_km: parseFloat(
        totals.estimated_distance_km.toFixed(2)
      ),
      anomaly_count: totals.anomaly_count,
    },
    daily,
    anomalies: anomalyDetailResult.rows.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      severity: r.severity,
      anomaly_date: formatDate(r.anomaly_date),
      metadata: r.metadata || {},
    })),
  };
}

function formatDate(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return formatBeijingDate(value);
  return String(value);
}
