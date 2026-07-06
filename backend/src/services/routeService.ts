import { pool } from "../db";
import { Visit, Route } from "../types";
import { planRoute } from "./routePlanning";

/**
 * 将 visits 按审批单分组。无 approval_id 的（如 Excel 导入）按 user_id + business_date 兜底。
 */
function groupVisitsByApproval(visits: Visit[]): Map<string, Visit[]> {
  const groups = new Map<string, Visit[]>();
  for (const visit of visits) {
    const key =
      visit.approval_id || `${visit.user_id}_${visit.business_date || ""}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(visit);
  }
  return groups;
}

/**
 * 为一组 visit 计算 route，组内按时序相邻点连线。
 * 不同 approval_id 之间不会生成 route。
 */
export async function computeRoutesForVisits(
  visits: Visit[],
  userId: string
): Promise<Route[]> {
  const groups = groupVisitsByApproval(visits);
  const routes: Route[] = [];

  for (const groupVisits of groups.values()) {
    // 组内按时间排序
    groupVisits.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    for (let i = 1; i < groupVisits.length; i++) {
      const prev = groupVisits[i - 1];
      const curr = groupVisits[i];
      // 公共交通不参与驾车路线规划，避免路线失真
      if (
        prev.trip_type?.includes("公共交通") ||
        curr.trip_type?.includes("公共交通")
      ) {
        continue;
      }
      const route = await planRoute(prev, curr, userId);
      if (route) routes.push(route);
    }
  }

  return routes;
}

export async function computeAndPersistRoutes(
  userId: string,
  start: string,
  end: string
): Promise<Route[]> {
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1
       AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
     ORDER BY timestamp ASC`,
    [userId, start, end]
  );

  const visits: Visit[] = visitsResult.rows;
  const routePlans = await computeRoutesForVisits(visits, userId);

  await pool.query(
    `DELETE FROM routes
     WHERE user_id = $1
       AND business_date >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       AND business_date <= ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
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
