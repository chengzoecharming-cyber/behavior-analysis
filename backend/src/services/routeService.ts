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
     WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
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
    `DELETE FROM routes WHERE user_id = $1 AND from_visit_id IN (
      SELECT id FROM visits WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
    )`,
    [userId, start, end]
  );

  const persisted: Route[] = [];
  for (const route of routePlans) {
    const r = await pool.query(
      `INSERT INTO routes
       (user_id, from_visit_id, to_visit_id, distance_km, duration_min, polyline)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        route.user_id,
        route.from_visit_id,
        route.to_visit_id,
        route.distance_km,
        route.duration_min,
        route.polyline,
      ]
    );
    persisted.push(r.rows[0]);
  }

  return persisted;
}
