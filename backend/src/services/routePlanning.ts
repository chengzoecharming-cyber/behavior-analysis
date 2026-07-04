import { Visit, Route } from "../types";
import { fetchJson } from "./httpClient";

const AMAP_KEY = process.env.AMAP_KEY || "";
const ROUTE_TIMEOUT_MS = Number(process.env.AMAP_ROUTE_TIMEOUT_MS || 15000);
const ROUTE_RETRY_COUNT = Number(process.env.AMAP_ROUTE_RETRY_COUNT || 5);

export async function planRoute(
  from: Visit,
  to: Visit,
  userId: string
): Promise<Route | null> {
  const fromValid = from.lat != null && from.lng != null;
  const toValid = to.lat != null && to.lng != null;

  if (!AMAP_KEY || AMAP_KEY === "YOUR_AMAP_KEY") {
    console.warn(`AMap key not configured, skip route planning for ${userId}`);
    return null;
  }

  if (!fromValid || !toValid) {
    console.warn(`Invalid coordinates, skip route planning for ${userId}`);
    return null;
  }

  // 重试机制：高德路径规划 API 偶尔失败，失败时重试
  let lastError: any = null;
  const delays = [500, 1500, 3000, 5000]; // 重试间隔（指数退避）

  for (let attempt = 0; attempt < ROUTE_RETRY_COUNT; attempt++) {
    try {
      const url =
        `https://restapi.amap.com/v3/direction/driving?` +
        `origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&extensions=all&key=${AMAP_KEY}`;

      const data = await fetchJson<any>(url, ROUTE_TIMEOUT_MS);

      if (data.status === "1" && data.route?.paths?.[0]) {
        const path = data.route.paths[0];
        const polyline = decodePolyline(path.steps);
        return {
          id: 0,
          user_id: userId,
          from_visit_id: from.id,
          to_visit_id: to.id,
          distance_km: parseFloat(path.distance) / 1000 || 0,
          duration_min: Math.round(parseFloat(path.duration) / 60) || 0,
          polyline,
          created_at: new Date(),
        };
      }

      // 记录非成功响应，用于重试
      lastError = new Error(`AMap status=${data.status}, info=${data.info}`);
    } catch (err: any) {
      lastError = err;
      console.warn(
        `AMap route planning attempt ${attempt + 1} failed:`,
        err.message || err
      );
    }

    // 重试前等待
    if (attempt < ROUTE_RETRY_COUNT - 1) {
      const delayMs = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.warn(
    `AMap route planning failed after ${ROUTE_RETRY_COUNT} attempts, skip route for ${userId}:`,
    lastError?.message || lastError
  );
  return null;
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
