import { Visit, Route } from "../types";
import { haversineDistance } from "./distance";

const AMAP_KEY = process.env.AMAP_KEY || "";

export async function planRoute(
  from: Visit,
  to: Visit,
  userId: string
): Promise<Route> {
  const fromLat = from.lat ?? null;
  const fromLng = from.lng ?? null;
  const toLat = to.lat ?? null;
  const toLng = to.lng ?? null;
  const fromValid = fromLat != null && fromLng != null;
  const toValid = toLat != null && toLng != null;
  const distanceKm =
    fromValid && toValid
      ? haversineDistance(fromLat, fromLng, toLat, toLng)
      : 0;

  if (!AMAP_KEY || AMAP_KEY === "YOUR_AMAP_KEY") {
    return fallbackRoute(from, to, userId, distanceKm);
  }

  if (!fromValid || !toValid) {
    return fallbackRoute(from, to, userId, 0);
  }

  // 重试机制：高德路径规划 API 偶尔失败，失败时重试最多 3 次
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url =
        `https://restapi.amap.com/v3/direction/driving?` +
        `origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&extensions=all&key=${AMAP_KEY}`;

      const response = await fetch(url);
      const data = (await response.json()) as any;

      if (data.status === "1" && data.route?.paths?.[0]) {
        const path = data.route.paths[0];
        const polyline = decodePolyline(path.steps);
        return {
          id: 0,
          user_id: userId,
          from_visit_id: from.id,
          to_visit_id: to.id,
          distance_km: parseFloat(path.distance) / 1000 || distanceKm,
          duration_min: Math.round(parseFloat(path.duration) / 60) || 0,
          polyline,
          created_at: new Date(),
        };
      }

      // 记录非成功响应，用于重试
      lastError = new Error(`AMap status=${data.status}, info=${data.info}`);
    } catch (err) {
      lastError = err;
      console.warn(`AMap route planning attempt ${attempt + 1} failed:`, err);
    }

    // 重试前等待 200ms
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.warn(
    `AMap route planning failed after 3 attempts, falling back to straight line for ${userId}`
  );
  return fallbackRoute(from, to, userId, distanceKm);
}

function fallbackRoute(
  from: Visit,
  to: Visit,
  userId: string,
  distanceKm: number
): Route {
  const fromValid = from.lat != null && from.lng != null;
  const toValid = to.lat != null && to.lng != null;
  const polyline =
    fromValid && toValid
      ? `${from.lng},${from.lat};${to.lng},${to.lat}`
      : "";
  return {
    id: 0,
    user_id: userId,
    from_visit_id: from.id,
    to_visit_id: to.id,
    distance_km: distanceKm,
    duration_min: distanceKm > 0 ? Math.round((distanceKm / 30) * 60) : 0,
    polyline,
    created_at: new Date(),
  };
}

function decodePolyline(steps: any[]): string {
  const points: string[] = [];
  for (const step of steps) {
    const pts = step.polyline.split(";");
    for (const pt of pts) {
      if (pt) points.push(pt);
    }
  }
  return points.join(";");
}
