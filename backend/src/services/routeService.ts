import { pool } from "../db";
import { Visit, Route } from "../types";
import { planRoute } from "./routePlanning";
import { formatBeijingDate, parseDateTimeAsBeijing, toBeijingDayStart, toBeijingDayEnd } from "../utils/timezone";

function formatBusinessDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") {
    // 已经是 YYYY-MM-DD 则直接返回，否则按北京时间解析
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return formatBeijingDate(parseDateTimeAsBeijing(value));
  }
  return formatBeijingDate(value);
}

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
 * 找出 routes 可能滞后的 (user_id, business_date) 组合：
 * 存在「同组 ≥2 条 visit」（可能产生路线段）且最新 visit 入库时间
 * 晚于 routes 最后计算时间（或 routes 完全缺失）。
 * 单签到审批单（每组仅 1 条，不可能产生路线段）不算脏，避免每次报告空跑。
 * 用于报告生成前补齐路线——报告里程直接读 routes 表，
 * 若 routes 由同步/风险任务异步维护而未更新，报告就会与线上数字漂移。
 */
export async function findStaleRoutePairs(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<{ user_id: string; business_date: string }[]> {
  if (userIds.length === 0) return [];
  const result = await pool.query(
    `WITH per_group AS (
       SELECT user_id, business_date,
              COALESCE(approval_id, user_id || '_' || business_date::text) AS grp,
              COUNT(*) AS cnt,
              MAX(created_at) AS latest
       FROM visits
       WHERE user_id = ANY($1)
         AND business_date >= $2::date
         AND business_date <= $3::date
       GROUP BY 1, 2, 3
     ),
     per_day AS (
       SELECT user_id, business_date,
              MAX(cnt) AS max_grp,
              MAX(latest) AS latest_visit
       FROM per_group
       GROUP BY 1, 2
     )
     SELECT d.user_id, d.business_date::text AS business_date
     FROM per_day d
     WHERE d.max_grp >= 2
       AND d.latest_visit > COALESCE((
         SELECT MAX(r.created_at) FROM routes r
         WHERE r.user_id = d.user_id AND r.business_date = d.business_date
       ), '1970-01-01'::timestamptz)`,
    [userIds, startDate, endDate]
  );
  return result.rows;
}

/**
 * 只对 routes 滞后的 user+date 重算路线（其余组合不调高德，控制 API 开销）。
 * 单个组合失败只告警，不阻断调用方。
 */
export async function ensureFreshRoutes(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<void> {
  const stalePairs = await findStaleRoutePairs(userIds, startDate, endDate);
  if (stalePairs.length === 0) return;
  console.log(
    `[RouteService] ${stalePairs.length} 个 user+date 的 routes 滞后，补算中...`
  );
  for (const { user_id, business_date } of stalePairs) {
    try {
      await computeAndPersistRoutes(
        user_id,
        toBeijingDayStart(business_date),
        toBeijingDayEnd(business_date)
      );
    } catch (err) {
      console.warn(
        `[RouteService] 补算路线失败: ${user_id} @ ${business_date}`,
        err
      );
    }
  }
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
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);

  // 拉取首次签到在日期范围内的审批单完整 visits，以及无审批单（Excel）的 visits。
  // 这样可以保证跨天审批单的路由按首次签到日期聚合，不会按 visit 日期拆分。
  const visitsResult = await pool.query(
    `WITH approval_first_stop AS (
       SELECT approval_id, MIN(timestamp) as first_timestamp
       FROM visits
       WHERE user_id = $1 AND approval_id IS NOT NULL
       GROUP BY approval_id
     ),
     in_range_approvals AS (
       SELECT a.approval_id
       FROM approval_first_stop a
       JOIN visits v ON v.approval_id = a.approval_id AND v.timestamp = a.first_timestamp
       WHERE v.business_date >= $2::date AND v.business_date <= $3::date
     )
     SELECT v.*
     FROM visits v
     WHERE v.user_id = $1
       AND (
         v.approval_id IN (SELECT approval_id FROM in_range_approvals)
         OR (
           v.approval_id IS NULL
           AND v.business_date >= $2::date
           AND v.business_date <= $3::date
         )
       )
     ORDER BY v.timestamp ASC`,
    [userId, startDate, endDate]
  );

  const visits: Visit[] = visitsResult.rows;
  const routePlans = await computeRoutesForVisits(visits, userId);

  await pool.query(
    `DELETE FROM routes
     WHERE user_id = $1
       AND business_date >= $2::date
       AND business_date <= $3::date`,
    [userId, startDate, endDate]
  );

  const visitToFirstStopDate = new Map<number, string>();
  const groups = groupVisitsByApproval(visits);
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const firstStop = group[0];
    const firstStopDate = formatBusinessDate(firstStop.business_date);
    for (const v of group) {
      visitToFirstStopDate.set(v.id, firstStopDate);
    }
  }

  const visitMap = new Map(visits.map((v) => [v.id, v]));
  const persisted: Route[] = [];
  for (const route of routePlans) {
    const fromVisit = visitMap.get(route.from_visit_id);
    const businessDate =
      visitToFirstStopDate.get(route.from_visit_id) ||
      formatBusinessDate(fromVisit?.business_date);
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
