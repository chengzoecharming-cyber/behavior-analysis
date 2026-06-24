import { Visit, Stop, Route, Anomaly } from "../types";
import { haversineDistance } from "./distance";
import { computeMileageSegments } from "./mileageAnalysis";

const LONG_STOP_MINUTES = 120;
const LONG_IDLE_MINUTES = 180;
const DETOUR_RATIO = 2.0;

// 从环境变量读取阈值，给训练阶段留出调整空间
const MILEAGE_DEVIATION_THRESHOLD = parseFloat(
  process.env.MILEAGE_DEVIATION_THRESHOLD || "0.5"
);
const INVALID_TRIP_DISTANCE_THRESHOLD = parseFloat(
  process.env.INVALID_TRIP_DISTANCE_THRESHOLD || "5"
);

export async function detectAnomalies(
  visits: Visit[],
  stops: Stop[],
  routes: Route[]
): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // 1. 停留时间过长
  for (const stop of stops) {
    if (stop.duration_minutes >= LONG_STOP_MINUTES) {
      anomalies.push({
        id: 0,
        user_id: stop.user_id,
        type: "long_stop",
        description: `在「${stop.location_name}」停留 ${stop.duration_minutes} 分钟，超过 ${LONG_STOP_MINUTES} 分钟阈值`,
        start_time: stop.start_time,
        end_time: stop.end_time,
        lat: stop.lat,
        lng: stop.lng,
        severity: stop.duration_minutes >= 240 ? "high" : "medium",
        related_visit_ids: stop.visit_ids,
        created_at: new Date(),
      });
    }
  }

  // 2. 长时间未移动（相邻 visit 时间间隔过大）
  const sorted = [...visits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gapMin =
      (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) /
      (1000 * 60);

    if (gapMin >= LONG_IDLE_MINUTES) {
      anomalies.push({
        id: 0,
        user_id: prev.user_id,
        type: "long_idle",
        description: `${prev.timestamp.toISOString()} 至 ${curr.timestamp.toISOString()} 之间 ${Math.round(
          gapMin
        )} 分钟无移动记录`,
        start_time: prev.timestamp,
        end_time: curr.timestamp,
        lat: null,
        lng: null,
        severity: gapMin >= 360 ? "high" : "medium",
        related_visit_ids: [prev.id, curr.id],
        created_at: new Date(),
      });
    }
  }

  // 3. 路径异常绕行
  for (const route of routes) {
    const from = visits.find((v) => v.id === route.from_visit_id);
    const to = visits.find((v) => v.id === route.to_visit_id);
    if (!from || !to) continue;

    const straightKm = haversineDistance(from.lat, from.lng, to.lat, to.lng);
    if (straightKm > 0.5 && route.distance_km > straightKm * DETOUR_RATIO) {
      anomalies.push({
        id: 0,
        user_id: route.user_id,
        type: "route_detour",
        description: `从「${from.location_name}」到「${to.location_name}」实际行驶 ${route.distance_km.toFixed(
          2
        )} km，直线距离 ${straightKm.toFixed(2)} km，疑似绕行`,
        start_time: null,
        end_time: null,
        lat: null,
        lng: null,
        severity: route.distance_km > straightKm * 3 ? "high" : "medium",
        related_visit_ids: [from.id, to.id],
        created_at: new Date(),
      });
    }
  }

  // 4. 填报里程与高德推荐里程偏差过大
  const mileageSegments = await computeMileageSegments(visits);
  for (const seg of mileageSegments) {
    if (seg.deviation_rate > MILEAGE_DEVIATION_THRESHOLD) {
      anomalies.push({
        id: 0,
        user_id: seg.user_id,
        type: "mileage_deviation",
        description: `从「${seg.from_location}」到「${seg.to_location}」填报里程 ${seg.reported_distance_km} km，高德推荐 ${seg.gaode_distance_km} km，偏差 ${(seg.deviation_rate * 100).toFixed(1)}%`,
        start_time: null,
        end_time: null,
        lat: null,
        lng: null,
        severity: seg.deviation_rate > MILEAGE_DEVIATION_THRESHOLD * 1.5 ? "high" : "medium",
        related_visit_ids: [seg.from_visit_id, seg.to_visit_id],
        created_at: new Date(),
      });
    }
  }

  // 5. 异常出行方式：公共交通/特殊签到但有较长填报里程
  for (const visit of visits) {
    const tripType = visit.trip_type || "";
    const isPublicOrSpecial =
      tripType.includes("公共交通") ||
      tripType.includes("特殊签到") ||
      tripType.includes("陪同拜访");
    if (
      isPublicOrSpecial &&
      (visit.reported_distance_km ?? 0) > INVALID_TRIP_DISTANCE_THRESHOLD
    ) {
      anomalies.push({
        id: 0,
        user_id: visit.user_id,
        type: "invalid_trip_type",
        description: `出行方式为「${tripType}」但填报累计里程 ${visit.reported_distance_km} km，疑似异常`,
        start_time: visit.timestamp,
        end_time: visit.timestamp,
        lat: visit.lat,
        lng: visit.lng,
        severity: "medium",
        related_visit_ids: [visit.id],
        created_at: new Date(),
      });
    }
  }

  // 6. 特殊签到未说明原因
  for (const visit of visits) {
    const tripType = visit.trip_type || "";
    if (
      tripType.includes("特殊签到") &&
      (!visit.special_sign_reason || visit.special_sign_reason.trim() === "")
    ) {
      anomalies.push({
        id: 0,
        user_id: visit.user_id,
        type: "missing_special_reason",
        description: `在「${visit.location_name}」进行特殊签到但未填写特殊签到原因`,
        start_time: visit.timestamp,
        end_time: visit.timestamp,
        lat: visit.lat,
        lng: visit.lng,
        severity: "low",
        related_visit_ids: [visit.id],
        created_at: new Date(),
      });
    }
  }

  return anomalies;
}

