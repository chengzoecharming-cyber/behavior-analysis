import crypto from "crypto";
import { pool } from "../db";
import { splitRealCustomerNames } from "./normalization";
import { getVisibleUserIds } from "./permission";
import { User } from "../types";

/**
 * 「盛夏战报」特别推送：为每位在职员工签发免登录 token，
 * 凭 token 可查看个人（及管理者团队）在指定周期内的拜访战报。
 */

export interface SpecialReportTokenInfo {
  user_id: string;
  user_name: string;
  role: User["role"];
  department: string | null;
  period_start: string;
  period_end: string;
}

interface TopCustomer {
  name: string;
  count: number;
}

interface SpecialReportPersonal {
  visit_count: number;
  customer_count: number;
  distance_km: number;
  active_days: number;
  busiest_day: { date: string; visit_count: number } | null;
  earliest_visit: { date: string; time: string } | null;
  top_customers: TopCustomer[];
  cities: string[];
  city_count: number;
  anomaly_count: number;
  points: { lat: number; lng: number }[];
}

interface SpecialReportTeam {
  member_count: number;
  total_visits: number;
  total_distance_km: number;
  top_members: { user_name: string; visit_count: number; distance_km: number }[];
}

export interface SpecialReport {
  scope: "staff" | "manager" | "admin";
  user: { user_id: string; user_name: string; department: string | null };
  period: { start: string; end: string };
  personal: SpecialReportPersonal;
  team?: SpecialReportTeam;
}

/** 足迹散点上限：超出后均匀抽稀 */
const MAX_POINTS = 200;

/** 为全体在职有效用户签发战报 token（30 天有效），返回签发清单 */
export async function issueSpecialReportTokens(
  periodStart: string,
  periodEnd: string
): Promise<{ user_id: string; user_name: string; role: string; token: string }[]> {
  const users = await pool.query<{
    user_id: string;
    user_name: string;
    role: string;
  }>(
    `SELECT user_id, user_name, role FROM users
     WHERE NOT is_resigned AND NOT is_invalid
     ORDER BY user_id`
  );

  const issued: { user_id: string; user_name: string; role: string; token: string }[] = [];
  for (const u of users.rows) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO special_report_tokens (token, user_id, period_start, period_end, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
      [token, u.user_id, periodStart, periodEnd]
    );
    issued.push({ user_id: u.user_id, user_name: u.user_name, role: u.role, token });
  }
  return issued;
}

/** 校验 token：存在且未过期则返回用户信息，无效返回 null */
export async function resolveSpecialReportToken(
  token: string
): Promise<SpecialReportTokenInfo | null> {
  const res = await pool.query<{
    user_id: string;
    user_name: string;
    role: User["role"];
    department: string | null;
    period_start: string;
    period_end: string;
  }>(
    `SELECT t.user_id, u.user_name, u.role, u.department,
            t.period_start::text AS period_start, t.period_end::text AS period_end
     FROM special_report_tokens t
     JOIN users u ON u.user_id = t.user_id
     WHERE t.token = $1 AND t.expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

/** 查询 token 状态：不存在 / 已过期，用于路由区分 404 与 410 */
export async function getSpecialReportTokenStatus(
  token: string
): Promise<"not_found" | "expired" | "valid"> {
  const res = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM special_report_tokens WHERE token = $1`,
    [token]
  );
  if (res.rows.length === 0) return "not_found";
  return res.rows[0].expires_at.getTime() > Date.now() ? "valid" : "expired";
}

/** 从 visits 的 customer_name 聚合客户拜访次数（JS 侧拆分去重口径） */
async function aggregateCustomers(
  userId: string,
  start: string,
  end: string
): Promise<{ customerCount: number; topCustomers: TopCustomer[] }> {
  const res = await pool.query<{ customer_name: string | null }>(
    `SELECT customer_name FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND NOT exclude_from_visit_count`,
    [userId, start, end]
  );
  const counter = new Map<string, number>();
  for (const row of res.rows) {
    // 只计真实客户（过滤「虚拟客户/签到用/住址」类占位名，与拜访计数口径一致）
    for (const name of splitRealCustomerNames(row.customer_name)) {
      counter.set(name, (counter.get(name) || 0) + 1);
    }
  }
  const sorted = Array.from(counter.entries()).sort((a, b) => b[1] - a[1]);
  return {
    customerCount: counter.size,
    topCustomers: sorted.slice(0, 5).map(([name, count]) => ({ name, count })),
  };
}

/** 计算单人的战报数据（staff 无 team 字段；manager/admin 附带团队聚合） */
export async function computeSpecialReport(
  userId: string,
  role: User["role"],
  department: string | null,
  start: string,
  end: string
): Promise<SpecialReport> {
  // 个人聚合：拜访次数（SUM(customer_count)，排除住址/公司打卡）、活跃天数
  const statsRes = await pool.query<{ visit_count: string; active_days: string }>(
    `SELECT COALESCE(SUM(customer_count), 0)::int AS visit_count,
            COUNT(DISTINCT business_date)::int AS active_days
     FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND NOT exclude_from_visit_count`,
    [userId, start, end]
  );

  // 最忙的一天
  const busiestRes = await pool.query<{ date: string; visit_count: string }>(
    `SELECT business_date::text AS date, SUM(customer_count)::int AS visit_count
     FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND NOT exclude_from_visit_count
     GROUP BY business_date
     ORDER BY visit_count DESC, business_date ASC
     LIMIT 1`,
    [userId, start, end]
  );

  // 最早一次签到（按实际签到时间，不做拜访计数过滤）
  const earliestRes = await pool.query<{ date: string; time: string }>(
    `SELECT business_date::text AS date,
            to_char(timestamp AT TIME ZONE 'Asia/Shanghai', 'HH24:MI') AS time
     FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
     ORDER BY timestamp ASC
     LIMIT 1`,
    [userId, start, end]
  );

  // 里程：routes 表高德里程求和（单位 km）
  const distanceRes = await pool.query<{ distance_km: string }>(
    `SELECT COALESCE(SUM(distance_km), 0)::float AS distance_km
     FROM routes
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3`,
    [userId, start, end]
  );

  // 异常数
  const anomalyRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM anomalies
     WHERE user_id = $1 AND anomaly_date BETWEEN $2 AND $3`,
    [userId, start, end]
  );

  // 足迹散点（去重；过多时均匀抽稀到 MAX_POINTS 个）
  const pointsRes = await pool.query<{ lat: number; lng: number }>(
    `SELECT DISTINCT lat, lng FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND lat IS NOT NULL AND lng IS NOT NULL`,
    [userId, start, end]
  );
  let points = pointsRes.rows.map((r) => ({ lat: r.lat, lng: r.lng }));
  if (points.length > MAX_POINTS) {
    const step = points.length / MAX_POINTS;
    const thinned: { lat: number; lng: number }[] = [];
    for (let i = 0; i < MAX_POINTS; i++) {
      thinned.push(points[Math.floor(i * step)]);
    }
    points = thinned;
  }

  const { customerCount, topCustomers } = await aggregateCustomers(userId, start, end);

  // visits 表无城市字段（只有 location_name/address），城市列表暂返回空
  const cities: string[] = [];

  const userRes = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM users WHERE user_id = $1`,
    [userId]
  );

  const personal: SpecialReportPersonal = {
    visit_count: Number(statsRes.rows[0]?.visit_count || 0),
    customer_count: customerCount,
    distance_km: Math.round(Number(distanceRes.rows[0]?.distance_km || 0) * 10) / 10,
    active_days: Number(statsRes.rows[0]?.active_days || 0),
    busiest_day: busiestRes.rows[0]
      ? { date: busiestRes.rows[0].date, visit_count: Number(busiestRes.rows[0].visit_count) }
      : null,
    earliest_visit: earliestRes.rows[0]
      ? { date: earliestRes.rows[0].date, time: earliestRes.rows[0].time }
      : null,
    top_customers: topCustomers,
    cities,
    city_count: cities.length,
    anomaly_count: Number(anomalyRes.rows[0]?.count || 0),
    points,
  };

  const report: SpecialReport = {
    scope: role,
    user: {
      user_id: userId,
      user_name: userRes.rows[0]?.user_name || userId,
      department,
    },
    period: { start, end },
    personal,
  };

  // 管理者附加团队聚合：成员集合复用权限口径（admin=null 表示全公司），剔除 exclude_from_stats
  if (role !== "staff") {
    const visible = await getVisibleUserIds({
      id: 0,
      user_id: userId,
      user_name: report.user.user_name,
      department,
      role,
      manager_id: null,
      is_resigned: false,
      home_address: null,
      created_at: new Date(),
    });

    let memberIds: string[];
    if (visible === null) {
      const res = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE NOT exclude_from_stats`
      );
      memberIds = res.rows.map((r) => r.user_id);
    } else {
      if (visible.length === 0) {
        report.team = { member_count: 0, total_visits: 0, total_distance_km: 0, top_members: [] };
        return report;
      }
      const res = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE user_id = ANY($1::text[]) AND NOT exclude_from_stats`,
        [visible]
      );
      memberIds = res.rows.map((r) => r.user_id);
    }

    if (memberIds.length === 0) {
      report.team = { member_count: 0, total_visits: 0, total_distance_km: 0, top_members: [] };
      return report;
    }

    // 每人拜访次数
    const visitsRes = await pool.query<{
      user_id: string;
      user_name: string;
      visit_count: string;
    }>(
      `SELECT user_id, MAX(user_name) AS user_name, COALESCE(SUM(customer_count), 0)::int AS visit_count
       FROM visits
       WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
         AND NOT exclude_from_visit_count
       GROUP BY user_id`,
      [memberIds, start, end]
    );

    // 每人里程
    const routesRes = await pool.query<{ user_id: string; distance_km: string }>(
      `SELECT user_id, COALESCE(SUM(distance_km), 0)::float AS distance_km
       FROM routes
       WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
       GROUP BY user_id`,
      [memberIds, start, end]
    );
    const distMap = new Map(routesRes.rows.map((r) => [r.user_id, Number(r.distance_km)]));

    const members = visitsRes.rows.map((r) => ({
      user_name: r.user_name,
      visit_count: Number(r.visit_count),
      distance_km: Math.round((distMap.get(r.user_id) || 0) * 10) / 10,
    }));
    members.sort((a, b) => b.visit_count - a.visit_count);

    report.team = {
      member_count: memberIds.length,
      total_visits: members.reduce((sum, m) => sum + m.visit_count, 0),
      total_distance_km:
        Math.round(members.reduce((sum, m) => sum + m.distance_km, 0) * 10) / 10,
      top_members: members.slice(0, 10),
    };
  }

  return report;
}
