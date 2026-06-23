import { Visit, Stop, Route, Anomaly } from "../types";
import { haversineDistance } from "./distance";

const LONG_STOP_MINUTES = 120;
const LONG_IDLE_MINUTES = 180;
const DETOUR_RATIO = 2.0;

export function detectAnomalies(
  visits: Visit[],
  stops: Stop[],
  routes: Route[]
): Anomaly[] {
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

  return anomalies;
}
