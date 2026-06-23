import { Visit, Route } from "../types";
import { haversineDistance } from "./distance";

const AMAP_KEY = process.env.AMAP_KEY || "";

export async function planRoute(
  from: Visit,
  to: Visit,
  userId: string
): Promise<Route> {
  const distanceKm = haversineDistance(from.lat, from.lng, to.lat, to.lng);

  if (!AMAP_KEY || AMAP_KEY === "YOUR_AMAP_KEY") {
    return fallbackRoute(from, to, userId, distanceKm);
  }

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
  } catch (err) {
    console.warn("AMap route planning failed:", err);
  }

  return fallbackRoute(from, to, userId, distanceKm);
}

function fallbackRoute(
  from: Visit,
  to: Visit,
  userId: string,
  distanceKm: number
): Route {
  return {
    id: 0,
    user_id: userId,
    from_visit_id: from.id,
    to_visit_id: to.id,
    distance_km: distanceKm,
    duration_min: Math.round((distanceKm / 30) * 60),
    polyline: `${from.lng},${from.lat};${to.lng},${to.lat}`,
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
