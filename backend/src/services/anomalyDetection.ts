import { Visit, Stop, Route, Anomaly } from "../types";
import { haversineDistance } from "./distance";
import { computeMileageSegments } from "./mileageAnalysis";
import { getEnabledAnomalyWeights, AnomalyWeight } from "./anomalyWeights";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import {
  getBeijingWeekday,
  parseDateTimeAsBeijing,
  toBeijingDayStart,
  toBeijingDayEnd,
  formatBeijingDate,
} from "../utils/timezone";

export interface AnomalyDetectionContext {
  userId: string;
  analysisDate: Date;
  visitsToday: Visit[];
  stopsToday: Stop[];
  routesToday: Route[];
  visitsPast5Workdays?: Visit[];
  visitsPast2Weeks?: Visit[];
}

function getThreshold(config: AnomalyWeight | undefined, defaultValue: number): number {
  if (!config) return defaultValue;
  return config.threshold_value ?? defaultValue;
}

function isWorkday(date: Date): boolean {
  const day = getBeijingWeekday(date);
  return day !== 0 && day !== 6;
}

function formatBeijingTime(date: Date | string): string {
  const d = typeof date === "string" ? parseDateTimeAsBeijing(date) : date;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// 计算包含 endDate 当天在内的最近 N 个工作日起始日期（按北京时间）
function getPastNWorkdaysStart(n: number, endDate: Date): Date {
  // 以北京日期的 00:00 作为起点，避免服务器本地时区影响
  let current = new Date(toBeijingDayStart(formatBeijingDate(endDate)));
  let count = 0;
  while (count < n) {
    if (isWorkday(current)) {
      count++;
    }
    if (count < n) {
      current = new Date(current.getTime() - 24 * 60 * 60 * 1000);
    }
  }
  return current;
}

export async function detectAnomalies(ctx: AnomalyDetectionContext): Promise<Anomaly[]> {
  const weights = await getEnabledAnomalyWeights();
  const anomalies: Anomaly[] = [];

  const { analysisDate, visitsToday, stopsToday, routesToday, visitsPast5Workdays, visitsPast2Weeks } = ctx;

  // 统一按北京时间计算 analysisDate 当天的起止时间
  const analysisDateStr = formatBeijingDate(analysisDate);
  const dayStart = new Date(toBeijingDayStart(analysisDateStr));
  const dayEnd = new Date(toBeijingDayEnd(analysisDateStr));

  // 1. 拜访量不足：过去5个工作日累计签到<阈值
  const lowVisitConfig = weights["low_visit_count"];
  if (lowVisitConfig && visitsPast5Workdays) {
    const threshold = getThreshold(lowVisitConfig, 15);
    // 只统计工作日签到（包含 analysisDate 当天）
    const startDate = getPastNWorkdaysStart(5, dayEnd);
    const workdayVisits = visitsPast5Workdays.filter((v) => {
      const d = new Date(v.timestamp);
      return d >= startDate && d <= dayEnd && isWorkday(d);
    });
    if (workdayVisits.length < threshold) {
      anomalies.push({
        id: 0,
        user_id: ctx.userId,
        type: "low_visit_count",
        description: `过去 5 个工作日累计签到 ${workdayVisits.length} 次，低于 ${threshold} 次阈值`,
        start_time: null,
        end_time: null,
        lat: null,
        lng: null,
        severity: workdayVisits.length < threshold * 0.6 ? "high" : "medium",
        related_visit_ids: workdayVisits.map((v) => v.id),
        metadata: {},
        created_at: new Date(),
      });
    }
  }

  // 2. 重复签到：过去两周同一地点重复签到>=阈值
  const duplicateConfig = weights["duplicate_location"];
  if (duplicateConfig && visitsPast2Weeks) {
    const threshold = getThreshold(duplicateConfig, 7);
    const startDate = new Date(dayStart);
    startDate.setTime(startDate.getTime() - 14 * 24 * 60 * 60 * 1000);

    const locationCounts: Record<string, { count: number; lat: number | null; lng: number | null; name: string; visitIds: number[] }> = {};
    for (const v of visitsPast2Weeks) {
      const d = new Date(v.timestamp);
      if (d < startDate || d > dayEnd) continue;
      // 用 location_name + 地址聚合；坐标缺失时不能作为 key
      const key = v.location_name?.trim() || v.address?.trim();
      if (!key) continue;
      if (!locationCounts[key]) {
        locationCounts[key] = { count: 0, lat: v.lat, lng: v.lng, name: v.location_name || v.address || "未知地点", visitIds: [] };
      }
      locationCounts[key].count++;
      locationCounts[key].visitIds.push(v.id);
    }

    for (const [_, info] of Object.entries(locationCounts)) {
      if (info.count >= threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "duplicate_location",
          description: `过去两周在「${info.name}」重复签到 ${info.count} 次，超过 ${threshold} 次阈值`,
          start_time: null,
          end_time: null,
          lat: info.lat,
          lng: info.lng,
          severity: info.count >= threshold + 3 ? "high" : "medium",
          related_visit_ids: info.visitIds,
          metadata: {},
          created_at: new Date(),
        });
      }
    }
  }

  // 3. 停留时间过长
  const longStopConfig = weights["long_stop"];
  if (longStopConfig) {
    const threshold = getThreshold(longStopConfig, 120);
    for (const stop of stopsToday) {
      if (stop.duration_minutes >= threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "long_stop",
          description: `在「${stop.location_name}」停留 ${stop.duration_minutes} 分钟，超过 ${threshold} 分钟阈值`,
          start_time: stop.start_time,
          end_time: stop.end_time,
          lat: stop.lat,
          lng: stop.lng,
          severity: stop.duration_minutes >= threshold * 2 ? "high" : "medium",
          related_visit_ids: stop.visit_ids,
          metadata: {},
          created_at: new Date(),
        });
      }
    }
  }

  // 4. 长时间未移动（相邻 visit 时间间隔过大）
  const longIdleConfig = weights["long_idle"];
  if (longIdleConfig) {
    const threshold = getThreshold(longIdleConfig, 180);
    const sorted = [...visitsToday].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gapMin =
        (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) /
        (1000 * 60);

      if (gapMin >= threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "long_idle",
          description: `${formatBeijingTime(prev.timestamp)} 至 ${formatBeijingTime(
          curr.timestamp
        )} 之间 ${Math.round(gapMin)} 分钟无移动记录`,
          start_time: prev.timestamp,
          end_time: curr.timestamp,
          lat: null,
          lng: null,
          severity: gapMin >= threshold * 2 ? "high" : "medium",
          related_visit_ids: [prev.id, curr.id],
          metadata: {},
          created_at: new Date(),
        });
      }
    }
  }

  // 5. 路径异常绕行
  const detourConfig = weights["route_detour"];
  if (detourConfig) {
    const threshold = getThreshold(detourConfig, 2.0);
    for (const route of routesToday) {
      const from = visitsToday.find((v) => v.id === route.from_visit_id);
      const to = visitsToday.find((v) => v.id === route.to_visit_id);
      if (!from || !to) continue;

      // 公共交通不生成 route，此处额外保险
      if (
        from.trip_type?.includes("公共交通") ||
        to.trip_type?.includes("公共交通")
      ) {
        continue;
      }

      if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
        continue;
      }
      const straightKm = haversineDistance(from.lat, from.lng, to.lat, to.lng);
      if (straightKm > 0.5 && route.distance_km > straightKm * threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "route_detour",
          description: `从「${from.location_name}」到「${to.location_name}」实际行驶 ${route.distance_km.toFixed(
            2
          )} km，直线距离 ${straightKm.toFixed(2)} km，疑似绕行`,
          start_time: null,
          end_time: null,
          lat: null,
          lng: null,
          severity: route.distance_km > straightKm * threshold * 1.5 ? "high" : "medium",
          related_visit_ids: [from.id, to.id],
          metadata: {
            from_location: from.location_name,
            to_location: to.location_name,
            actual_distance_km: route.distance_km,
            straight_distance_km: straightKm,
          },
          created_at: new Date(),
        });
      }
    }
  }

  // 6. 填报里程与高德推荐里程偏差过大
  const mileageConfig = weights["mileage_deviation"];
  if (mileageConfig) {
    const threshold = getThreshold(mileageConfig, 0.3);
    const mileageSegments = await computeMileageSegments(visitsToday);
    for (const seg of mileageSegments) {
      if (seg.deviation_rate > threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "mileage_deviation",
          description: `从「${seg.from_location}」到「${seg.to_location}」填报里程 ${seg.reported_distance_km} km，高德推荐 ${seg.gaode_distance_km} km，偏差 ${(seg.deviation_rate * 100).toFixed(1)}%`,
          start_time: null,
          end_time: null,
          lat: null,
          lng: null,
          severity: seg.deviation_rate > threshold * 1.5 ? "high" : "medium",
          related_visit_ids: [seg.from_visit_id, seg.to_visit_id],
          metadata: {
            from_location: seg.from_location,
            to_location: seg.to_location,
            reported_distance_km: seg.reported_distance_km,
            gaode_distance_km: seg.gaode_distance_km,
            deviation_rate: seg.deviation_rate,
          },
          created_at: new Date(),
        });
      }
    }
  }

  // 7. 异常出行方式：公共交通/特殊签到但有较长填报里程
  const invalidTripConfig = weights["invalid_trip_type"];
  if (invalidTripConfig) {
    const threshold = getThreshold(invalidTripConfig, 5);
    for (const visit of visitsToday) {
      const tripType = visit.trip_type || "";
      const isPublicOrSpecial =
        tripType.includes("公共交通") ||
        tripType.includes("特殊签到") ||
        tripType.includes("陪同拜访");
      if (isPublicOrSpecial && (visit.reported_distance_km ?? 0) > threshold) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "invalid_trip_type",
          description: `出行方式为「${tripType}」但填报累计里程 ${visit.reported_distance_km} km，疑似异常`,
          start_time: visit.timestamp,
          end_time: visit.timestamp,
          lat: visit.lat,
          lng: visit.lng,
          severity: "medium",
          related_visit_ids: [visit.id],
          metadata: {},
          created_at: new Date(),
        });
      }
    }
  }

  // 9. 里程读数异常（出发/终点读数缺失、非单调递增、超过上限）
  const mileageReadingConfig = weights["mileage_reading_invalid"];
  if (mileageReadingConfig) {
    anomalies.push(...detectMileageReadingInvalid(visitsToday));
  }

  // 8. 特殊签到未说明原因
  const missingReasonConfig = weights["missing_special_reason"];
  if (missingReasonConfig) {
    for (const visit of visitsToday) {
      const tripType = visit.trip_type || "";
      if (
        tripType.includes("特殊签到") &&
        (!visit.special_sign_reason || visit.special_sign_reason.trim() === "")
      ) {
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "missing_special_reason",
          description: `在「${visit.location_name}」进行特殊签到但未填写特殊签到原因`,
          start_time: visit.timestamp,
          end_time: visit.timestamp,
          lat: visit.lat,
          lng: visit.lng,
          severity: "low",
          related_visit_ids: [visit.id],
          metadata: {},
          created_at: new Date(),
        });
      }
    }
  }

  return anomalies;
}

interface MileageReadingIssue {
  sequence: number;
  location_name: string;
  issue_type: "missing_start" | "missing_end" | "end_before_start" | "exceeds_max" | "invalid_number";
  start_odometer?: number | null;
  end_odometer?: number | null;
  computed_diff?: number;
  description: string;
}

/**
 * 检测里程读数异常：
 * - 缺少出发读数
 * - 缺少终点读数（含中间读数）
 * - 终点读数 < 出发读数
 * - 终点与出发读数差值超过 MAX_MILEAGE_KM
 * - 读数不是有效数字
 *
 * 按审批单维度检测，一个审批单内多个问题合并为一个异常事件。
 */
export function detectMileageReadingInvalid(visits: Visit[]): Anomaly[] {
  const groups = new Map<string, Visit[]>();
  for (const v of visits) {
    if (!v.approval_id) continue;
    if (!groups.has(v.approval_id)) groups.set(v.approval_id, []);
    groups.get(v.approval_id)!.push(v);
  }

  const anomalies: Anomaly[] = [];

  for (const [approvalId, groupVisits] of groups) {
    // 只关心有里程读数相关字段的审批单
    const hasOdometer = groupVisits.some(
      (v) => v.start_odometer != null || v.end_odometer != null
    );
    if (!hasOdometer) continue;

    const sorted = [...groupVisits].sort(
      (a, b) => (a.sequence || 0) - (b.sequence || 0)
    );
    if (sorted.length === 0) continue;

    const firstVisit = sorted[0];
    const startOdometer = firstVisit.start_odometer;
    const issues: MileageReadingIssue[] = [];

    // 检查出发读数
    if (startOdometer == null || !Number.isFinite(startOdometer)) {
      issues.push({
        sequence: firstVisit.sequence || 1,
        location_name: firstVisit.location_name || "出发点",
        issue_type: "missing_start",
        start_odometer: startOdometer ?? null,
        end_odometer: null,
        description: `缺少出发里程读数`,
      });
    }

    // 检查每个后续签到点的终点读数
    for (let i = 1; i < sorted.length; i++) {
      const visit = sorted[i];
      const endOdometer = visit.end_odometer;
      const seq = visit.sequence || i + 1;
      const locationName = visit.location_name || `签到点${seq}`;

      if (endOdometer == null || !Number.isFinite(endOdometer)) {
        issues.push({
          sequence: seq,
          location_name: locationName,
          issue_type: "missing_end",
          start_odometer: startOdometer ?? null,
          end_odometer: endOdometer ?? null,
          description: `第 ${seq} 个签到点缺少终点里程读数`,
        });
        continue;
      }

      if (startOdometer != null && Number.isFinite(startOdometer)) {
        const diff = endOdometer - startOdometer;
        if (diff < 0) {
          issues.push({
            sequence: seq,
            location_name: locationName,
            issue_type: "end_before_start",
            start_odometer: startOdometer,
            end_odometer: endOdometer,
            computed_diff: diff,
            description: `终点里程读数（${endOdometer}）小于出发里程读数（${startOdometer}），差值 ${diff} km`,
          });
        } else if (diff > MAX_MILEAGE_KM) {
          issues.push({
            sequence: seq,
            location_name: locationName,
            issue_type: "exceeds_max",
            start_odometer: startOdometer,
            end_odometer: endOdometer,
            computed_diff: diff,
            description: `终点与出发读数差值（${diff} km）超过合理上限（${MAX_MILEAGE_KM} km）`,
          });
        }
      }
    }

    if (issues.length === 0) continue;

    const descriptionLines = issues.map((issue) => `• ${issue.description}`).join("；");
    anomalies.push({
      id: 0,
      user_id: sorted[0].user_id,
      type: "mileage_reading_invalid",
      description: `审批单 ${approvalId} 里程读数异常：${descriptionLines}`,
      start_time: null,
      end_time: null,
      lat: null,
      lng: null,
      severity: "low",
      related_visit_ids: sorted.map((v) => v.id),
      metadata: {
        approval_id: approvalId,
        issues,
      },
      created_at: new Date(),
    });
  }

  return anomalies;
}
