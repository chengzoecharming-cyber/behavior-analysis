import { Visit, Route } from "../types";
import { pool } from "../db";
import { planRoute } from "./routePlanning";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { isMileageRequiredTrip } from "./tripType";
import { formatBeijingDate, parseDateTimeAsBeijing } from "../utils/timezone";

function toDateString(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : formatBeijingDate(parseDateTimeAsBeijing(value));
  }
  return formatBeijingDate(value);
}


export interface MileageSegment {
  user_id: string;
  approval_id: string;
  from_visit_id: number;
  to_visit_id: number;
  from_location: string;
  to_location: string;
  reported_distance_km: number;
  gaode_distance_km: number;
  deviation_rate: number; // (reported - gaode) / gaode，仅正值触发异常
}

export interface MileageDistributionStats {
  count: number;
  mean: number;
  median: number;
  std: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
  min: number;
}

/**
 * 按 approval_id 分组，计算相邻签到点之间的填报里程 vs 高德推荐里程。
 */
function approvalGroupKey(v: Visit): string {
  return v.approval_id || `${v.user_id}_${v.business_date || ""}`;
}

export async function computeMileageSegments(
  visits: Visit[]
): Promise<MileageSegment[]> {
  // 按审批单分组（无 approval_id 的按 user_id + 业务日期兜底）
  const sorted = [...visits].sort((a, b) => {
    const keyA = approvalGroupKey(a);
    const keyB = approvalGroupKey(b);
    if (keyA !== keyB) return keyA.localeCompare(keyB);
    return (a.sequence || 0) - (b.sequence || 0);
  });

  const segments: MileageSegment[] = [];

  // 收集同一审批单内的相邻 visit 对，用于查询已算好的 route
  const pairs: { prev: Visit; curr: Visit }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (approvalGroupKey(prev) !== approvalGroupKey(curr)) continue;
    // 只有驾车行程（含两端）才参与里程偏差计算
    if (
      !isMileageRequiredTrip(prev.trip_type) ||
      !isMileageRequiredTrip(curr.trip_type)
    ) {
      continue;
    }
    pairs.push({ prev, curr });
  }

  // 批量查询 routes 表，避免重复请求高德 API
  const routeMap = new Map<string, Route>();
  if (pairs.length > 0) {
    const visitIds = Array.from(
      new Set(pairs.flatMap((p) => [p.prev.id, p.curr.id]))
    );
    // 两个 IN 子句的占位符必须全局唯一，不能复用 $1,$2,$3
    const placeholders1 = visitIds.map((_, i) => `$${i + 1}`).join(",");
    const placeholders2 = visitIds
      .map((_, i) => `$${i + 1 + visitIds.length}`)
      .join(",");
    const routeResult = await pool.query(
      `SELECT * FROM routes
       WHERE from_visit_id IN (${placeholders1})
         AND to_visit_id IN (${placeholders2})`,
      [...visitIds, ...visitIds]
    );
    for (const row of routeResult.rows) {
      routeMap.set(`${row.from_visit_id},${row.to_visit_id}`, row as Route);
    }
  }

  for (const { prev, curr } of pairs) {
    // 优先使用里程表读数差计算分段里程；缺失时回退到累计值差。
    const prevEndOdometer = prev.end_odometer ?? prev.start_odometer;
    let reportedSegmentKm: number | null = null;
    if (curr.end_odometer != null && prevEndOdometer != null) {
      reportedSegmentKm = curr.end_odometer - prevEndOdometer;
    } else if (
      prev.reported_distance_km != null &&
      curr.reported_distance_km != null
    ) {
      reportedSegmentKm = curr.reported_distance_km - prev.reported_distance_km;
    }

    // 忽略里程读数异常（负数、或超过合理上限的离谱值）
    if (
      reportedSegmentKm == null ||
      reportedSegmentKm < 0 ||
      reportedSegmentKm > MAX_MILEAGE_KM
    ) {
      continue;
    }

    const cachedRoute = routeMap.get(`${prev.id},${curr.id}`);
    const route = cachedRoute ?? (await planRoute(prev, curr, prev.user_id));
    if (!route) {
      // 高德路径规划失败，跳过该段，避免用直线距离兜底
      continue;
    }
    const gaodeKm = route.distance_km;

    const deviationRate = gaodeKm > 0
      ? (reportedSegmentKm - gaodeKm) / gaodeKm
      : reportedSegmentKm > 0 ? 1 : 0;

    segments.push({
      user_id: prev.user_id,
      approval_id: approvalGroupKey(prev),
      from_visit_id: prev.id,
      to_visit_id: curr.id,
      from_location: prev.location_name,
      to_location: curr.location_name,
      reported_distance_km: parseFloat(reportedSegmentKm.toFixed(2)),
      gaode_distance_km: parseFloat(gaodeKm.toFixed(2)),
      deviation_rate: parseFloat(deviationRate.toFixed(4)),
    });
  }

  return segments;
}

export function computeMileageStats(
  segments: MileageSegment[]
): MileageDistributionStats | null {
  if (segments.length === 0) return null;

  const rates = segments.map((s) => s.deviation_rate).sort((a, b) => a - b);
  const sum = rates.reduce((a, b) => a + b, 0);
  const mean = sum / rates.length;
  const variance =
    rates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rates.length;
  const std = Math.sqrt(variance);

  return {
    count: rates.length,
    mean: parseFloat(mean.toFixed(4)),
    median: parseFloat(percentile(rates, 0.5).toFixed(4)),
    std: parseFloat(std.toFixed(4)),
    p50: parseFloat(percentile(rates, 0.5).toFixed(4)),
    p75: parseFloat(percentile(rates, 0.75).toFixed(4)),
    p90: parseFloat(percentile(rates, 0.9).toFixed(4)),
    p95: parseFloat(percentile(rates, 0.95).toFixed(4)),
    max: parseFloat(rates[rates.length - 1].toFixed(4)),
    min: parseFloat(rates[0].toFixed(4)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export interface ApprovalMileageResult {
  approvalId: string;
  userId: string;
  firstStopBusinessDate: string;
  reportedKm: number;
  estimatedKm: number;
  visitCount: number;
}

function computeSegmentReported(prev: Visit, curr: Visit): number | null {
  const prevEndOdometer = prev.end_odometer ?? prev.start_odometer;
  if (curr.end_odometer != null && prevEndOdometer != null) {
    return curr.end_odometer - prevEndOdometer;
  }
  if (
    prev.reported_distance_km != null &&
    curr.reported_distance_km != null
  ) {
    return curr.reported_distance_km - prev.reported_distance_km;
  }
  return null;
}

/**
 * 按审批单聚合计算真实填报里程与估算里程。
 *
 * 口径：
 * 1. 日期归属到该审批单第一次签到的 business_date。
 * 2. 填报里程 = 审批单内相邻驾车签到点的里程差值之和。
 * 3. 估算里程 = 审批单内驾车相邻段的 routes 距离之和。
 * 4. 非驾车（公共交通、陪同拜访、特殊签到、虚拟客户）不计入。
 * 5. 无 approval_id 的（Excel 导入等）按 user_id + business_date 兜底分组。
 */
export async function computeMileageByApprovalForUsers(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<ApprovalMileageResult[]> {
  if (userIds.length === 0) return [];

  // 1. 找出首次签到在日期范围内的审批单
  const approvalResult = await pool.query(
    `WITH approval_first_stop AS (
       SELECT approval_id,
              MIN(timestamp) as first_timestamp,
              MIN(business_date) as first_business_date
       FROM visits
       WHERE user_id = ANY($1)
         AND approval_id IS NOT NULL
       GROUP BY approval_id
     )
     SELECT approval_id, first_business_date
     FROM approval_first_stop
     WHERE first_business_date >= $2::date
       AND first_business_date <= $3::date`,
    [userIds, startDate, endDate]
  );

  const approvalIds = approvalResult.rows
    .map((r) => r.approval_id)
    .filter((id): id is string => Boolean(id));

  // 2. 拉取这些审批单的完整 visits，以及无审批单且业务日期在范围内的 visits
  const visitsResult = await pool.query(
    `SELECT *
     FROM visits
     WHERE user_id = ANY($1)
       AND (
         approval_id = ANY($2)
         OR (
           approval_id IS NULL
           AND business_date >= $3::date
           AND business_date <= $4::date
         )
       )
     ORDER BY user_id, approval_id, sequence, timestamp`,
    [userIds, approvalIds, startDate, endDate]
  );
  const visits: Visit[] = visitsResult.rows;

  // 3. 批量查询这些 visits 之间的 routes（避免重复调用高德 API）
  const visitIds = visits.map((v) => v.id);
  const routeMap = new Map<string, Route>();
  if (visitIds.length > 0) {
    const routeResult = await pool.query(
      `SELECT *
       FROM routes
       WHERE from_visit_id = ANY($1)
         AND to_visit_id = ANY($1)`,
      [visitIds]
    );
    for (const row of routeResult.rows) {
      routeMap.set(`${row.from_visit_id},${row.to_visit_id}`, row as Route);
    }
  }

  // 4. 按审批单/兜底分组并计算
  const groups = new Map<string, Visit[]>();
  for (const v of visits) {
    const key = approvalGroupKey(v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
  }

  const results: ApprovalMileageResult[] = [];

  for (const [key, groupVisits] of groups) {
    const sorted = [...groupVisits].sort((a, b) => {
      const seqDiff = (a.sequence || 0) - (b.sequence || 0);
      if (seqDiff !== 0) return seqDiff;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    const firstStop = sorted[0];
    const firstStopDate = toDateString(firstStop.business_date);

    // 审批单首次签到日期必须落在查询范围内（兜底分组 already 在 SQL 中限定）
    if (firstStopDate < startDate || firstStopDate > endDate) continue;

    let reportedKm = 0;
    let estimatedKm = 0;
    let segmentCount = 0;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (
        !isMileageRequiredTrip(prev.trip_type) ||
        !isMileageRequiredTrip(curr.trip_type)
      ) {
        continue;
      }

      const segmentReported = computeSegmentReported(prev, curr);
      if (
        segmentReported != null &&
        segmentReported >= 0 &&
        segmentReported <= MAX_MILEAGE_KM
      ) {
        reportedKm += segmentReported;
      }

      const route = routeMap.get(`${prev.id},${curr.id}`);
      if (route) {
        estimatedKm += route.distance_km;
        segmentCount++;
      }
    }

    results.push({
      approvalId: firstStop.approval_id || key,
      userId: firstStop.user_id,
      firstStopBusinessDate: firstStopDate,
      reportedKm: parseFloat(reportedKm.toFixed(2)),
      estimatedKm: parseFloat(estimatedKm.toFixed(2)),
      visitCount: sorted.length,
    });
  }

  return results;
}

/**
 * 按用户聚合里程结果。
 */
export function aggregateMileageByUser(
  results: ApprovalMileageResult[]
): Map<string, { reportedKm: number; estimatedKm: number; approvalCount: number }> {
  const map = new Map<
    string,
    { reportedKm: number; estimatedKm: number; approvalCount: number }
  >();
  for (const r of results) {
    const existing = map.get(r.userId) || {
      reportedKm: 0,
      estimatedKm: 0,
      approvalCount: 0,
    };
    existing.reportedKm += r.reportedKm;
    existing.estimatedKm += r.estimatedKm;
    existing.approvalCount += 1;
    map.set(r.userId, existing);
  }
  return map;
}

/**
 * 按业务日期聚合里程结果。
 */
export function aggregateMileageByDate(
  results: ApprovalMileageResult[]
): Map<string, { reportedKm: number; estimatedKm: number }> {
  const map = new Map<string, { reportedKm: number; estimatedKm: number }>();
  for (const r of results) {
    const existing = map.get(r.firstStopBusinessDate) || {
      reportedKm: 0,
      estimatedKm: 0,
    };
    existing.reportedKm += r.reportedKm;
    existing.estimatedKm += r.estimatedKm;
    map.set(r.firstStopBusinessDate, existing);
  }
  return map;
}

/**
 * 按用户 + 业务日期聚合里程结果。
 */
export function aggregateMileageByUserDate(
  results: ApprovalMileageResult[]
): Map<string, { reportedKm: number; estimatedKm: number; approvalCount: number }> {
  const map = new Map<
    string,
    { reportedKm: number; estimatedKm: number; approvalCount: number }
  >();
  for (const r of results) {
    const key = `${r.userId}_${r.firstStopBusinessDate}`;
    const existing = map.get(key) || {
      reportedKm: 0,
      estimatedKm: 0,
      approvalCount: 0,
    };
    existing.reportedKm += r.reportedKm;
    existing.estimatedKm += r.estimatedKm;
    existing.approvalCount += 1;
    map.set(key, existing);
  }
  return map;
}
