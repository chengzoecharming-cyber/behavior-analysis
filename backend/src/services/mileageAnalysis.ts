import { Visit, Route } from "../types";
import { pool } from "../db";
import { planRoute } from "./routePlanning";
import { MAX_MILEAGE_KM } from "./mileageConfig";

export interface MileageSegment {
  user_id: string;
  approval_id: string;
  from_visit_id: number;
  to_visit_id: number;
  from_location: string;
  to_location: string;
  reported_distance_km: number;
  gaode_distance_km: number;
  deviation_rate: number; // |reported - gaode| / gaode
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
export async function computeMileageSegments(
  visits: Visit[]
): Promise<MileageSegment[]> {
  // 按 approval_id + sequence 排序
  const sorted = [...visits].sort((a, b) => {
    if (a.approval_id !== b.approval_id) {
      return (a.approval_id || "").localeCompare(b.approval_id || "");
    }
    return (a.sequence || 0) - (b.sequence || 0);
  });

  const segments: MileageSegment[] = [];

  // 收集同一审批单内的相邻 visit 对，用于查询已算好的 route
  const pairs: { prev: Visit; curr: Visit }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev.approval_id || prev.approval_id !== curr.approval_id) continue;
    // 公共交通不参与里程偏差计算
    if (
      prev.trip_type?.includes("公共交通") ||
      curr.trip_type?.includes("公共交通")
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
      ? Math.abs(reportedSegmentKm - gaodeKm) / gaodeKm
      : reportedSegmentKm > 0 ? 1 : 0;

    segments.push({
      user_id: prev.user_id,
      approval_id: prev.approval_id || "",
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
