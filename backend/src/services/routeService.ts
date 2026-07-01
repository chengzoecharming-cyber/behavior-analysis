import { pool } from "../db";
import { Visit, Route } from "../types";
import { planRoute } from "./routePlanning";

export async function computeAndPersistRoutes(
  userId: string,
  start: string,
  end: string
): Promise<Route[]> {
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
     ORDER BY timestamp ASC`,
    [userId, start, end]
  );

  const visits: Visit[] = visitsResult.rows;
  const routePlans: Route[] = [];

  for (let i = 1; i < visits.length; i++) {
    const route = await planRoute(visits[i - 1], visits[i], userId);
    routePlans.push(route);
  }

  await pool.query(
    `DELETE FROM routes WHERE user_id = $1 AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
    [userId, start, end]
  );

  const visitMap = new Map(visits.map((v) => [v.id, v]));
  const persisted: Route[] = [];
  for (const route of routePlans) {
    const fromVisit = visitMap.get(route.from_visit_id);
    const businessDate = fromVisit?.business_date;
    const r = await pool.query(
      `INSERT INTO routes
       (user_id, from_visit_id, to_visit_id, distance_km, duration_min, polyline, business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        route.user_id,
        route.from_visit_id,
        route.to_visit_id,
        route.distance_km,
        route.duration_min,
        route.polyline,
        businessDate,
      ]
    );
    persisted.push(r.rows[0]);
  }

  return persisted;
}
