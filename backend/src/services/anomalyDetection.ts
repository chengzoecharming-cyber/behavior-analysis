import { Visit, Stop, Route, Anomaly } from "../types";
import { computeMileageSegments } from "./mileageAnalysis";
import { getEnabledAnomalyWeights, AnomalyWeight } from "./anomalyWeights";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import {
  loadUserHomeAddresses,
  isHomeAddress,
} from "./addressWhitelistService";
import {
  parseDateTimeAsBeijing,
  formatBeijingDate,
} from "../utils/timezone";
import {
  getBusinessWeekSoFarRange,
  getCurrentBusinessWeekRange,
  getPreviousBusinessWeekRange,
  isBusinessWeekEnd,
  formatBusinessPeriod,
} from "../utils/businessPeriod";

export interface AnomalyDetectionContext {
  userId: string;
  analysisDate: Date;
  visitsToday: Visit[];
  stopsToday: Stop[];
  routesToday: Route[];
  currentWeekVisits?: Visit[]; // 当前业务周（周一到周日）
  previousWeekVisits?: Visit[]; // 上一完整业务周
}

function getThreshold(config: AnomalyWeight | undefined, defaultValue: number): number {
  if (!config) return defaultValue;
  return config.threshold_value ?? defaultValue;
}

function getRuleLayer(type: string): "fact" | "analyze" | "judge" | null {
  const map: Record<string, "fact" | "analyze" | "judge"> = {
    low_visit_count: "judge",
    duplicate_location: "judge",
    mileage_deviation: "judge",
    long_stop: "analyze",
    long_idle: "analyze",
    route_detour: "analyze",
    invalid_trip_type: "fact",
    missing_special_reason: "fact",
    mileage_reading_invalid: "fact",
  };
  return map[type] || null;
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

// 全局排除地址（办公室、公司地址等）
const GLOBAL_EXCLUDED_ADDRESSES = [
  "广东省深圳市宝安区创维数字大厦",
];

function normalizeAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[,.，。]/g, "");
}

async function isGlobalExcludedAddress(visit: Visit): Promise<boolean> {
  const textToCheck = [visit.address, visit.location_name].filter(Boolean) as string[];
  const visitAddress = textToCheck.join("");
  const normalizedVisit = normalizeAddress(visitAddress);

  for (const excluded of GLOBAL_EXCLUDED_ADDRESSES) {
    const normalizedExcluded = normalizeAddress(excluded);
    if (
      normalizedVisit.includes(normalizedExcluded) ||
      normalizedExcluded.includes(normalizedVisit)
    ) {
      return true;
    }
  }
  return false;
}

async function filterExcludedVisits(visits: Visit[], userId: string): Promise<Set<number>> {
  const excludedIds = new Set<number>();

  // 员工住址排除
  const homeAddressMap = await loadUserHomeAddresses([userId]);
  const homeAddress = homeAddressMap.get(userId);

  await Promise.all(
    visits.map(async (v) => {
      if (homeAddress && (await isHomeAddress(v, homeAddress))) {
        excludedIds.add(v.id);
        return;
      }
      if (await isGlobalExcludedAddress(v)) {
        excludedIds.add(v.id);
      }
    })
  );

  return excludedIds;
}

export async function detectAnomalies(ctx: AnomalyDetectionContext): Promise<Anomaly[]> {
  const weights = await getEnabledAnomalyWeights();
  const anomalies: Anomaly[] = [];

  const { analysisDate, visitsToday, stopsToday, routesToday, currentWeekVisits, previousWeekVisits } = ctx;

  // 1. 拜访量不足：当前完整业务周拜访量 < 阈值（仅在业务周周日展示）
  const lowVisitConfig = weights["low_visit_count"];
  if (lowVisitConfig && currentWeekVisits && isBusinessWeekEnd(analysisDate)) {
    const threshold = getThreshold(lowVisitConfig, 10);
    const periodRange = getCurrentBusinessWeekRange(analysisDate);
    const weeklyVisits = currentWeekVisits.filter((v) => {
      const d = new Date(v.timestamp);
      return d >= periodRange.start && d <= periodRange.end;
    });

    if (weeklyVisits.length < threshold) {
      anomalies.push({
        id: 0,
        user_id: ctx.userId,
        type: "low_visit_count",
        description: `${formatBusinessPeriod(periodRange.start, periodRange.end)} 拜访量 ${weeklyVisits.length} 次，低于 ${threshold} 次阈值`,
        start_time: null,
        end_time: null,
        lat: null,
        lng: null,
        severity: weeklyVisits.length < threshold * 0.6 ? "high" : "medium",
        related_visit_ids: weeklyVisits.map((v) => v.id),
        metadata: {
          period_start: formatBeijingDate(periodRange.start),
          period_end: formatBeijingDate(periodRange.end),
          visit_count: weeklyVisits.length,
          threshold,
        },
        created_at: new Date(),
      });
    }
  }

  // 2. 重复签到：当前业务周（周一到当前日）同一地点重复签到 >= 阈值
  const duplicateConfig = weights["duplicate_location"];
  if (duplicateConfig && currentWeekVisits) {
    const threshold = getThreshold(duplicateConfig, 3);
    const periodRange = getBusinessWeekSoFarRange(analysisDate);
    const excludedVisitIds = await filterExcludedVisits(currentWeekVisits, ctx.userId);

    const locationCounts: Record<string, {
      count: number;
      lat: number | null;
      lng: number | null;
      name: string;
      address: string;
      sequence: number;
      visitIds: number[];
    }> = {};

    for (const v of currentWeekVisits) {
      const d = new Date(v.timestamp);
      if (d < periodRange.start || d > periodRange.end) continue;
      if (excludedVisitIds.has(v.id)) continue;
      const key = v.address?.trim() || v.location_name?.trim();
      if (!key) continue;
      if (!locationCounts[key]) {
        locationCounts[key] = {
          count: 0,
          lat: v.lat,
          lng: v.lng,
          name: v.location_name || v.address || "未知地点",
          address: v.address || v.location_name || "未知地点",
          sequence: v.sequence ?? 0,
          visitIds: [],
        };
      }
      locationCounts[key].count++;
      locationCounts[key].visitIds.push(v.id);
    }

    for (const [_, info] of Object.entries(locationCounts)) {
      if (info.count >= threshold) {
        const sequenceLabel = info.sequence > 0 ? `途${info.sequence}` : "途";
        anomalies.push({
          id: 0,
          user_id: ctx.userId,
          type: "duplicate_location",
          description: `${formatBusinessPeriod(periodRange.start, periodRange.end)} 同一地点重复签到 ${info.count} 次，超过 ${threshold - 1} 次阈值`,
          start_time: null,
          end_time: null,
          lat: info.lat,
          lng: info.lng,
          severity: info.count >= threshold + 2 ? "high" : "medium",
          related_visit_ids: info.visitIds,
          metadata: {
            excluded_home_visits: 0,
            location_name: info.name,
            address: info.address,
            sequence: info.sequence,
            sequence_label: sequenceLabel,
            period_start: formatBeijingDate(periodRange.start),
            period_end: formatBeijingDate(periodRange.end),
          },
          created_at: new Date(),
        });
      }
    }
  }

  // 3. 停留时间过长（已禁用，但保留代码以便配置开启）
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

  // 4. 长时间未移动（已禁用）
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

  // 5. 填报里程超过高德推荐里程 30%
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
          description: `从「${seg.from_location}」到「${seg.to_location}」填报里程 ${seg.reported_distance_km} km，估算 ${seg.gaode_distance_km} km，超出 ${(seg.deviation_rate * 100).toFixed(1)}%`,
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
            approval_id: seg.approval_id,
          },
          created_at: new Date(),
        });
      }
    }
  }

  // 6. 异常出行方式（已禁用）
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

  // 7. 里程读数异常：始终检测用于展示，但不参与风险评分
  anomalies.push(...detectMileageReadingInvalid(visitsToday));

  // 8. 特殊签到未说明原因（已禁用）
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

  // 为所有异常事件统一打上层级标签
  for (const anomaly of anomalies) {
    anomaly.layer = getRuleLayer(anomaly.type);
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
