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

/**
 * 打开埋点表 DDL 不放 db.ts（避免与其他改动纠缠），模块内幂等建一次。
 */
let tablesReady: Promise<void> | null = null;
export function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS special_report_views (
          id SERIAL PRIMARY KEY,
          token VARCHAR(64) NOT NULL,
          user_id VARCHAR(64) NOT NULL,
          viewed_at TIMESTAMPTZ DEFAULT NOW(),
          user_agent TEXT
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_special_report_views_user
          ON special_report_views(user_id)
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

/** 记录一次打开（fire-and-forget 由调用方保证），失败仅记日志 */
export async function recordSpecialReportView(
  token: string,
  userId: string,
  userAgent: string | null
): Promise<void> {
  try {
    await ensureTables();
    await pool.query(
      `INSERT INTO special_report_views (token, user_id, user_agent) VALUES ($1, $2, $3)`,
      [token, userId, userAgent ? userAgent.slice(0, 500) : null]
    );
  } catch (err) {
    console.warn("[SpecialReport] 打开埋点写入失败:", err);
  }
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
  points: { lat: number; lng: number; date: string }[];
  monthly: { month: string; visit_count: number }[];
  weekday: { counts: number[]; top_weekday: number; top_count: number };
  longest_day: { date: string; distance_km: number } | null;
  percentile: number | null;
  title: { name: string; desc: string } | null;
  zero_anomaly: boolean;
  /** 区间内每一天的拜访数（无拜访补 0），日历点阵用 */
  daily: { date: string; visit_count: number }[];
  /** 按周聚合（周一开头），波形图用 */
  weekly: { week_start: string; visit_count: number }[];
  /** 每天最早签到中时间最早的 5 天（升序），「窗户画框」页用 */
  earliest_days: { date: string; time: string }[];
  /** 全量真实客户拜访计数（降序，最多 40 个），「客户矩阵墙」用 */
  customer_tiles: TopCustomer[];
}

interface MemberHighlight {
  user_name: string;
  visit_count: number;
  distance_km: number;
  title_name: string | null;
  top_customer_name: string | null;
  top_customer_count: number;
  longest_day_km: number;
}

interface SpecialReportTeam {
  member_count: number;
  total_visits: number;
  total_distance_km: number;
  top_members: { user_name: string; visit_count: number; distance_km: number }[];
  star_member: { user_name: string; visit_count: number } | null;
  most_improved: { user_name: string; growth: number } | null;
  member_highlights: MemberHighlight[];
}

export interface SpecialReportOpenStat {
  user_name: string;
  user_id: string;
  views: number;
  last_viewed: string | null;
}

export interface SpecialReport {
  scope: "staff" | "manager" | "admin";
  user: { user_id: string; user_name: string; department: string | null };
  period: { start: string; end: string };
  personal: SpecialReportPersonal;
  team?: SpecialReportTeam;
  /** 仅 admin：本期战报各人打开统计 */
  open_stats?: SpecialReportOpenStat[];
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
): Promise<{ customerCount: number; topCustomers: TopCustomer[]; customerTiles: TopCustomer[] }> {
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
    customerTiles: sorted.slice(0, 40).map(([name, count]) => ({ name, count })),
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
  // 结束日截断到「今天」（北京时间）：战报周期可能写死到未来（如 9.30），
  // 截断后聚合与 period 返回都不含未来日期，日历点阵不会出现大片未来暗点。
  // rawEnd 保留原周期末日，供 open_stats 按 token 原始周期匹配
  const rawEnd = end;
  const todayCN = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  if (end > todayCN) end = todayCN;

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

  // 足迹散点（带 business_date，按时间升序；过多时按时间均匀抽稀到 MAX_POINTS 个）
  const pointsRes = await pool.query<{ lat: number; lng: number; date: string }>(
    `SELECT lat, lng, business_date::text AS date FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND lat IS NOT NULL AND lng IS NOT NULL
     ORDER BY timestamp ASC`,
    [userId, start, end]
  );
  let points = pointsRes.rows;
  if (points.length > MAX_POINTS) {
    const step = points.length / MAX_POINTS;
    const thinned: { lat: number; lng: number; date: string }[] = [];
    for (let i = 0; i < MAX_POINTS; i++) {
      thinned.push(points[Math.floor(i * step)]);
    }
    points = thinned;
  }

  // 按月份聚合（区间内每月一条，无拜访的月份补 0）
  const monthlyRes = await pool.query<{ month: string; visit_count: string }>(
    `SELECT to_char(m.month_start, 'YYYY-MM') AS month,
            COALESCE(SUM(v.customer_count), 0)::int AS visit_count
     FROM generate_series(
            date_trunc('month', $2::date),
            date_trunc('month', $3::date),
            INTERVAL '1 month'
          ) AS m(month_start)
     LEFT JOIN visits v
       ON v.user_id = $1::text
      AND v.business_date >= m.month_start
      AND v.business_date < m.month_start + INTERVAL '1 month'
      AND NOT v.exclude_from_visit_count
     GROUP BY m.month_start
     ORDER BY m.month_start`,
    [userId, start, end]
  );
  const monthly = monthlyRes.rows.map((r) => ({
    month: r.month,
    visit_count: Number(r.visit_count),
  }));

  // 按天聚合（区间内每一天一条，无拜访补 0），日历点阵用
  const dailyRes = await pool.query<{ date: string; visit_count: string }>(
    `SELECT d.day::date::text AS date,
            COALESCE(SUM(v.customer_count), 0)::int AS visit_count
     FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d(day)
     LEFT JOIN visits v
       ON v.user_id = $1::text
      AND v.business_date = d.day
      AND NOT v.exclude_from_visit_count
     GROUP BY d.day
     ORDER BY d.day`,
    [userId, start, end]
  );
  const daily = dailyRes.rows.map((r) => ({
    date: r.date,
    visit_count: Number(r.visit_count),
  }));

  // 按周聚合（date_trunc('week') 周一开头，覆盖区间涉及的所有周，无拜访补 0），波形图用
  const weeklyRes = await pool.query<{ week_start: string; visit_count: string }>(
    `SELECT w.week_start::date::text AS week_start,
            COALESCE(SUM(v.customer_count), 0)::int AS visit_count
     FROM generate_series(
            date_trunc('week', $2::date),
            date_trunc('week', $3::date),
            INTERVAL '1 week'
          ) AS w(week_start)
     LEFT JOIN visits v
       ON v.user_id = $1::text
      AND v.business_date >= w.week_start
      AND v.business_date < w.week_start + INTERVAL '1 week'
      AND v.business_date BETWEEN $2::date AND $3::date
      AND NOT v.exclude_from_visit_count
     GROUP BY w.week_start
     ORDER BY w.week_start`,
    [userId, start, end]
  );
  const weekly = weeklyRes.rows.map((r) => ({
    week_start: r.week_start,
    visit_count: Number(r.visit_count),
  }));

  // 每天最早一次签到的北京时间 HH:MM，取最早的 5 天（升序），「窗户画框」页用
  const earliestDaysRes = await pool.query<{ date: string; time: string }>(
    `SELECT business_date::text AS date,
            to_char(MIN(timestamp) AT TIME ZONE 'Asia/Shanghai', 'HH24:MI') AS time
     FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
     GROUP BY business_date
     ORDER BY time ASC
     LIMIT 5`,
    [userId, start, end]
  );
  const earliestDays = earliestDaysRes.rows.map((r) => ({ date: r.date, time: r.time }));

  // 按星期聚合（isodow：1=周一 … 7=周日）
  const weekdayRes = await pool.query<{ dow: number; visit_count: string }>(
    `SELECT EXTRACT(isodow FROM business_date)::int AS dow,
            COALESCE(SUM(customer_count), 0)::int AS visit_count
     FROM visits
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
       AND NOT exclude_from_visit_count
     GROUP BY dow`,
    [userId, start, end]
  );
  const weekdayCounts = new Array(7).fill(0) as number[];
  for (const r of weekdayRes.rows) {
    weekdayCounts[r.dow - 1] = Number(r.visit_count);
  }
  let topWeekday = 1;
  for (let i = 1; i < 7; i++) {
    if (weekdayCounts[i] > weekdayCounts[topWeekday - 1]) topWeekday = i + 1;
  }
  const weekday = {
    counts: weekdayCounts,
    top_weekday: topWeekday,
    top_count: weekdayCounts[topWeekday - 1],
  };

  // 里程最长的一天（routes 按 business_date 聚合）
  const longestDayRes = await pool.query<{ date: string; distance_km: string }>(
    `SELECT business_date::text AS date, SUM(distance_km)::float AS distance_km
     FROM routes
     WHERE user_id = $1 AND business_date BETWEEN $2 AND $3
     GROUP BY business_date
     ORDER BY distance_km DESC, business_date ASC
     LIMIT 1`,
    [userId, start, end]
  );
  const longestDay = longestDayRes.rows[0]
    ? {
        date: longestDayRes.rows[0].date,
        distance_km: Math.round(Number(longestDayRes.rows[0].distance_km) * 10) / 10,
      }
    : null;

  // 全公司同区间每人拜访数 + 里程（剔除 exclude_from_stats、剔除 0 拜访），
  // 一趟聚合同时算拜访分位与里程分位
  const companyRes = await pool.query<{
    user_id: string;
    visit_count: string;
    distance_km: string;
  }>(
    `SELECT v.user_id,
            SUM(v.customer_count)::int AS visit_count,
            COALESCE(r.distance_km, 0)::float AS distance_km
     FROM visits v
     LEFT JOIN (
       SELECT user_id, SUM(distance_km) AS distance_km
       FROM routes
       WHERE business_date BETWEEN $1 AND $2
       GROUP BY user_id
     ) r ON r.user_id = v.user_id
     WHERE v.business_date BETWEEN $1 AND $2
       AND NOT v.exclude_from_visit_count
       AND NOT EXISTS (
         SELECT 1 FROM users ux
         WHERE ux.user_id = v.user_id AND ux.exclude_from_stats
       )
     GROUP BY v.user_id, r.distance_km
     HAVING SUM(v.customer_count) > 0`,
    [start, end]
  );
  const myVisitCount = Number(statsRes.rows[0]?.visit_count || 0);
  const myDistance = Math.round(Number(distanceRes.rows[0]?.distance_km || 0) * 10) / 10;
  let percentile: number | null = null;
  let distancePercentile: number | null = null;
  if (companyRes.rows.length > 0 && myVisitCount > 0) {
    const beatenVisits = companyRes.rows.filter(
      (r) => Number(r.visit_count) < myVisitCount
    ).length;
    percentile = Math.round((beatenVisits / companyRes.rows.length) * 100);
    const beatenDistance = companyRes.rows.filter(
      (r) => Number(r.distance_km) < myDistance
    ).length;
    distancePercentile = Math.round((beatenDistance / companyRes.rows.length) * 100);
  }

  // 区间天数（含首尾）
  const periodDays =
    Math.round(
      (new Date(end + "T00:00:00+08:00").getTime() -
        new Date(start + "T00:00:00+08:00").getTime()) /
        86400000
    ) + 1;

  // 称号：按优先级取第一个命中
  const anomalyCount = Number(anomalyRes.rows[0]?.count || 0);
  const earliestTime = earliestRes.rows[0]?.time || null;
  const activeDays = Number(statsRes.rows[0]?.active_days || 0);
  let title: { name: string; desc: string } | null = null;
  if (myVisitCount > 0) {
    if (percentile !== null && percentile >= 90) {
      title = { name: "卷王", desc: "拜访数跻身全公司前 10%" };
    } else if (distancePercentile !== null && distancePercentile >= 90) {
      title = { name: "行者", desc: "里程数跻身全公司前 10%" };
    } else if (earliestTime !== null && earliestTime < "08:00") {
      title = { name: "追光者", desc: "总是赶在城市醒来之前出发" };
    } else if (activeDays >= periodDays * 0.5) {
      title = { name: "劳模", desc: "一半以上的日子都在路上" };
    } else {
      title = { name: "稳步前行者", desc: "不疾不徐，日拱一卒" };
    }
  }

  const { customerCount, topCustomers, customerTiles } = await aggregateCustomers(userId, start, end);

  // visits 表无城市字段（只有 location_name/address），城市列表暂返回空
  const cities: string[] = [];

  const userRes = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM users WHERE user_id = $1`,
    [userId]
  );

  const personal: SpecialReportPersonal = {
    visit_count: myVisitCount,
    customer_count: customerCount,
    distance_km: myDistance,
    active_days: activeDays,
    busiest_day: busiestRes.rows[0]
      ? { date: busiestRes.rows[0].date, visit_count: Number(busiestRes.rows[0].visit_count) }
      : null,
    earliest_visit: earliestRes.rows[0]
      ? { date: earliestRes.rows[0].date, time: earliestRes.rows[0].time }
      : null,
    top_customers: topCustomers,
    cities,
    city_count: cities.length,
    anomaly_count: anomalyCount,
    points,
    monthly,
    weekday,
    longest_day: longestDay,
    percentile,
    title,
    zero_anomaly: anomalyCount === 0 && myVisitCount > 0,
    daily,
    weekly,
    earliest_days: earliestDays,
    customer_tiles: customerTiles,
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
        report.team = {
          member_count: 0,
          total_visits: 0,
          total_distance_km: 0,
          top_members: [],
          star_member: null,
          most_improved: null,
          member_highlights: [],
        };
        return report;
      }
      const res = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE user_id = ANY($1::text[]) AND NOT exclude_from_stats`,
        [visible]
      );
      memberIds = res.rows.map((r) => r.user_id);
    }

    if (memberIds.length === 0) {
      report.team = {
        member_count: 0,
        total_visits: 0,
        total_distance_km: 0,
        top_members: [],
        star_member: null,
        most_improved: null,
        member_highlights: [],
      };
      return report;
    }

    // 每人拜访次数 / 活跃天数 / 最早签到（一趟聚合，避免 N+1）；
    // 从 users LEFT JOIN，保证区间内无拜访的成员也出现在 member_highlights（visit_count=0）
    const visitsRes = await pool.query<{
      user_id: string;
      user_name: string;
      visit_count: string;
      active_days: string;
      earliest_ts: Date | null;
    }>(
      `SELECT u.user_id, u.user_name, COALESCE(v.visit_count, 0)::int AS visit_count,
              COALESCE(v.active_days, 0)::int AS active_days,
              v.earliest_ts
       FROM users u
       LEFT JOIN (
         SELECT user_id, COALESCE(SUM(customer_count), 0)::int AS visit_count,
                COUNT(DISTINCT business_date)::int AS active_days,
                MIN(timestamp) AS earliest_ts
         FROM visits
         WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
           AND NOT exclude_from_visit_count
         GROUP BY user_id
       ) v ON v.user_id = u.user_id
       WHERE u.user_id = ANY($1::text[])`,
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

    // 每人单日里程（一趟查回，JS 侧取最大）→ longest_day_km
    const dailyDistRes = await pool.query<{
      user_id: string;
      day_km: string;
    }>(
      `SELECT user_id, SUM(distance_km)::float AS day_km
       FROM routes
       WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
       GROUP BY user_id, business_date`,
      [memberIds, start, end]
    );
    const longestDayMap = new Map<string, number>();
    for (const r of dailyDistRes.rows) {
      const km = Number(r.day_km);
      longestDayMap.set(r.user_id, Math.max(longestDayMap.get(r.user_id) || 0, km));
    }

    // 每人客户明细（一趟查回，JS 侧按 splitRealCustomerNames 口径计 top1）
    const custRes = await pool.query<{ user_id: string; customer_name: string | null }>(
      `SELECT user_id, customer_name FROM visits
       WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
         AND NOT exclude_from_visit_count`,
      [memberIds, start, end]
    );
    const custCounterByUser = new Map<string, Map<string, number>>();
    for (const r of custRes.rows) {
      let counter = custCounterByUser.get(r.user_id);
      if (!counter) {
        counter = new Map();
        custCounterByUser.set(r.user_id, counter);
      }
      for (const name of splitRealCustomerNames(r.customer_name)) {
        counter.set(name, (counter.get(name) || 0) + 1);
      }
    }
    const topCustMap = new Map<string, { name: string; count: number }>();
    for (const [uid, counter] of custCounterByUser) {
      let best: { name: string; count: number } | null = null;
      for (const [name, count] of counter) {
        if (!best || count > best.count) best = { name, count };
      }
      if (best) topCustMap.set(uid, best);
    }

    const memberStats = new Map(
      visitsRes.rows.map((r) => [
        r.user_id,
        { active_days: Number(r.active_days), earliest_ts: r.earliest_ts },
      ])
    );

    const members = visitsRes.rows.map((r) => ({
      user_id: r.user_id,
      user_name: r.user_name,
      visit_count: Number(r.visit_count),
      distance_km: Math.round((distMap.get(r.user_id) || 0) * 10) / 10,
    }));
    members.sort((a, b) => b.visit_count - a.visit_count);

    // 队内称号归属：拜访第1 → 卷王；里程第1 → 行者；最早签到 → 追光者；
    // 活跃天数 ≥ 区间一半 → 劳模（个人口径）；都不中 → null
    const topVisitUser = members[0]?.user_id ?? null;
    let topDistUser: string | null = null;
    let topDist = -1;
    let earliestUser: string | null = null;
    let earliestTs: number | null = null;
    for (const m of members) {
      if (m.distance_km > topDist) {
        topDist = m.distance_km;
        topDistUser = m.user_id;
      }
      const ts = memberStats.get(m.user_id)?.earliest_ts;
      if (ts && (earliestTs === null || ts.getTime() < earliestTs)) {
        earliestTs = ts.getTime();
        earliestUser = m.user_id;
      }
    }

    const memberHighlights: MemberHighlight[] = members.map((m) => {
      const stats = memberStats.get(m.user_id);
      const activeDays = stats?.active_days || 0;
      let titleName: string | null = null;
      if (m.visit_count > 0) {
        if (m.user_id === topVisitUser) titleName = "卷王";
        else if (m.user_id === topDistUser && topDist > 0) titleName = "行者";
        else if (m.user_id === earliestUser) titleName = "追光者";
        else if (activeDays >= periodDays * 0.5) titleName = "劳模";
      }
      const topCust = topCustMap.get(m.user_id) || null;
      return {
        user_name: m.user_name,
        visit_count: m.visit_count,
        distance_km: m.distance_km,
        title_name: titleName,
        top_customer_name: topCust?.name ?? null,
        top_customer_count: topCust?.count ?? 0,
        longest_day_km: Math.round((longestDayMap.get(m.user_id) || 0) * 10) / 10,
      };
    });

    // 进步最大：区间对半切，后半段拜访数 − 前半段拜访数，取增长最多且后半段 >0 的成员
    let mostImproved: { user_name: string; growth: number } | null = null;
    if (memberIds.length >= 2) {
      const midDate = new Date(
        new Date(start + "T00:00:00+08:00").getTime() +
          Math.floor(periodDays / 2) * 86400000
      );
      const mid = `${midDate.getFullYear()}-${String(midDate.getMonth() + 1).padStart(2, "0")}-${String(midDate.getDate()).padStart(2, "0")}`;
      const halvesRes = await pool.query<{
        user_id: string;
        user_name: string;
        half: number;
        visit_count: string;
      }>(
        `SELECT user_id, MAX(user_name) AS user_name,
                CASE WHEN business_date < $4 THEN 0 ELSE 1 END AS half,
                COALESCE(SUM(customer_count), 0)::int AS visit_count
         FROM visits
         WHERE user_id = ANY($1::text[]) AND business_date BETWEEN $2 AND $3
           AND NOT exclude_from_visit_count
         GROUP BY user_id, half`,
        [memberIds, start, end, mid]
      );
      const halfMap = new Map<string, { name: string; first: number; second: number }>();
      for (const r of halvesRes.rows) {
        const entry = halfMap.get(r.user_id) || { name: r.user_name, first: 0, second: 0 };
        if (r.half === 0) entry.first = Number(r.visit_count);
        else entry.second = Number(r.visit_count);
        halfMap.set(r.user_id, entry);
      }
      let bestGrowth = 0;
      for (const { name, first, second } of halfMap.values()) {
        const growth = second - first;
        if (second > 0 && growth > bestGrowth) {
          bestGrowth = growth;
          mostImproved = { user_name: name, growth };
        }
      }
    }

    report.team = {
      member_count: memberIds.length,
      total_visits: members.reduce((sum, m) => sum + m.visit_count, 0),
      total_distance_km:
        Math.round(members.reduce((sum, m) => sum + m.distance_km, 0) * 10) / 10,
      top_members: members
        .slice(0, 10)
        .map(({ user_name, visit_count, distance_km }) => ({
          user_name,
          visit_count,
          distance_km,
        })),
      star_member: members[0]
        ? { user_name: members[0].user_name, visit_count: members[0].visit_count }
        : null,
      most_improved: mostImproved,
      member_highlights: memberHighlights,
    };
  }

  // 仅 admin：本期战报各人打开统计（同周期 token 的浏览记录）
  if (role === "admin") {
    try {
      await ensureTables();
      const openRes = await pool.query<{
        user_id: string;
        user_name: string;
        views: string;
        last_viewed: Date | null;
      }>(
        `SELECT v.user_id, MAX(u.user_name) AS user_name,
                COUNT(*)::int AS views,
                MAX(v.viewed_at) AS last_viewed
         FROM special_report_views v
         JOIN special_report_tokens t ON t.token = v.token
         JOIN users u ON u.user_id = v.user_id
         WHERE t.period_start = $1 AND t.period_end = $2
         GROUP BY v.user_id
         ORDER BY views DESC, v.user_id`,
        [start, rawEnd]
      );
      report.open_stats = openRes.rows.map((r) => ({
        user_name: r.user_name,
        user_id: r.user_id,
        views: Number(r.views),
        last_viewed: r.last_viewed ? r.last_viewed.toISOString() : null,
      }));
    } catch (err) {
      console.warn("[SpecialReport] 打开统计查询失败:", err);
      report.open_stats = [];
    }
  }

  return report;
}
