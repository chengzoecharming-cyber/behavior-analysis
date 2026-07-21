import { pool } from "../db";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import {
  formatBeijingDate,
  parseDateTimeAsBeijing,
} from "../utils/timezone";
import {
  getBusinessWeekStart,
  getBusinessWeekEnd,
  getBusinessWeekNumber,
} from "../utils/businessPeriod";
import {
  EXCLUDED_TOP_DEPARTMENTS,
  isExcludedTopDepartment,
} from "./orgService";

export interface WeeklyTrendItem {
  week: string; // 展示文案，如 "6.29-7.5"
  weekStart: string;
  weekEnd: string;
  visitCount: number;
  avgVisitsPerEmployee: number; // 有数据员工的周人均拜访次数
  reportedKm: number;
  estimatedKm: number;
  activeEmployees: number;
}

export interface WordCloudEmployee {
  userId: string;
  userName: string;
  department: string;
  visitCount: number;
  anomalyCount: number;
}

export interface DepartmentRadarItem {
  department: string;
  avgVisitsPerEmployee: number; // 人均拜访次数
  avgCustomerCoverage: number; // 人均客户覆盖
  avgEstimatedKm: number; // 人均估算里程
}

export interface CompanyDashboardSummary {
  totalVisits: number;
  activeEmployees: number;
  customerCoverage: number;
  avgVisitFrequency: number; // 次/人/周
}

export interface CompanyDashboardResult {
  start: string;
  end: string;
  summary: CompanyDashboardSummary;
  weeklyTrend: WeeklyTrendItem[];
  employeeWordCloud: WordCloudEmployee[];
  departmentRadar: DepartmentRadarItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JUDGE_LAYER_ANOMALY_TYPES = [
  "low_visit_count",
  "duplicate_location",
  "mileage_deviation",
  "mileage_reading_invalid",
];

/**
 * 生成 [startStr, endStr] 之间（含）的所有北京日期字符串
 */
function eachDate(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const start = parseDateTimeAsBeijing(startStr);
  const end = parseDateTimeAsBeijing(endStr);
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    dates.push(formatBeijingDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function getWeekKey(dateStr: string): string {
  const d = parseDateTimeAsBeijing(dateStr);
  const start = getBusinessWeekStart(d);
  const end = getBusinessWeekEnd(d);
  const weekNumber = getBusinessWeekNumber(d);
  return `${formatBeijingDate(start)}_${formatBeijingDate(end)}_${weekNumber}`;
}

function formatShortDate(dateStr: string): string {
  const d = parseDateTimeAsBeijing(dateStr);
  const beijing = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const month = beijing.getUTCMonth() + 1;
  const day = beijing.getUTCDate();
  return `${month}.${day}`;
}

function getWeekDisplay(dateStr: string): string {
  const range = getWeekRange(dateStr);
  return `${formatShortDate(range.start)}-${formatShortDate(range.end)}`;
}

function getWeekRange(dateStr: string): { start: string; end: string } {
  const d = parseDateTimeAsBeijing(dateStr);
  return {
    start: formatBeijingDate(getBusinessWeekStart(d)),
    end: formatBeijingDate(getBusinessWeekEnd(d)),
  };
}

/**
 * 计算公司级 Dashboard 数据。
 * 只统计周期内有拜访数据的员工。
 */
export async function computeCompanyDashboard(
  startDate: string,
  endDate: string
): Promise<CompanyDashboardResult> {
  // 1. 汇总指标
  const summaryResult = await pool.query(
    `SELECT
       COUNT(*) AS total_visits,
       COUNT(DISTINCT user_id) AS active_employees,
       COUNT(DISTINCT NULLIF(customer_name, '')) AS customer_coverage
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date`,
    [startDate, endDate]
  );

  const totalVisits = parseInt(summaryResult.rows[0].total_visits, 10) || 0;
  const activeEmployees = parseInt(summaryResult.rows[0].active_employees, 10) || 0;
  const customerCoverage = parseInt(summaryResult.rows[0].customer_coverage, 10) || 0;

  // 2. 周趋势：先按天聚合，再归到业务周
  const dates = eachDate(startDate, endDate);
  const dailyMap = new Map<
    string,
    {
      visitCount: number;
      reportedKm: number;
      estimatedKm: number;
      activeEmployees: Set<string>;
    }
  >();

  // 初始化每一天
  for (const d of dates) {
    dailyMap.set(d, {
      visitCount: 0,
      reportedKm: 0,
      estimatedKm: 0,
      activeEmployees: new Set<string>(),
    });
  }

  // 每天拜访数与活跃员工
  const dailyVisitsResult = await pool.query(
    `SELECT business_date, COUNT(*) AS visit_count, COUNT(DISTINCT user_id) AS active_employees
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
     GROUP BY business_date
     ORDER BY business_date`,
    [startDate, endDate]
  );
  for (const row of dailyVisitsResult.rows) {
    const d = formatBeijingDate(row.business_date);
    const day = dailyMap.get(d);
    if (day) {
      day.visitCount = parseInt(row.visit_count, 10) || 0;
    }
  }

  // 每天活跃员工集合（用于每周统计）
  const dailyUsersResult = await pool.query(
    `SELECT business_date, user_id
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
     GROUP BY business_date, user_id`,
    [startDate, endDate]
  );
  for (const row of dailyUsersResult.rows) {
    const d = formatBeijingDate(row.business_date);
    const day = dailyMap.get(d);
    if (day) {
      day.activeEmployees.add(row.user_id);
    }
  }

  // 每天填报里程：按 approval_id 取最大值，再跨审批求和
  const dailyReportedResult = await pool.query(
    `SELECT business_date, SUM(approval_total) AS reported_km
     FROM (
       SELECT business_date,
              approval_group,
              MAX(reported_distance_km) AS approval_total
       FROM (
         SELECT business_date,
                reported_distance_km,
                COALESCE(approval_id, user_id || '_' || business_date::text) AS approval_group
         FROM visits
         WHERE business_date >= $1::date
           AND business_date <= $2::date
           AND (trip_type IS NULL OR trip_type NOT LIKE '%公共交通%')
       ) t
       WHERE reported_distance_km > 0 AND reported_distance_km <= $3
       GROUP BY business_date, approval_group
     ) t2
     GROUP BY business_date
     ORDER BY business_date`,
    [startDate, endDate, MAX_MILEAGE_KM]
  );
  for (const row of dailyReportedResult.rows) {
    const d = formatBeijingDate(row.business_date);
    const day = dailyMap.get(d);
    if (day) {
      day.reportedKm = parseFloat(row.reported_km) || 0;
    }
  }

  // 每天估算里程
  const dailyEstimatedResult = await pool.query(
    `SELECT business_date, COALESCE(SUM(distance_km), 0) AS estimated_km
     FROM routes
     WHERE business_date >= $1::date AND business_date <= $2::date
     GROUP BY business_date
     ORDER BY business_date`,
    [startDate, endDate]
  );
  for (const row of dailyEstimatedResult.rows) {
    const d = formatBeijingDate(row.business_date);
    const day = dailyMap.get(d);
    if (day) {
      day.estimatedKm = parseFloat(row.estimated_km) || 0;
    }
  }

  // 按业务周汇总
  const weeklyMap = new Map<
    string,
    {
      week: string;
      weekStart: string; // 实际包含数据范围起点
      weekEnd: string;   // 实际包含数据范围终点
      businessWeekStart: string; // 业务周起点，用于排序
      visitCount: number;
      reportedKm: number;
      estimatedKm: number;
      activeEmployees: Set<string>;
    }
  >();

  for (const d of dates) {
    const day = dailyMap.get(d)!;
    const key = getWeekKey(d);
    const range = getWeekRange(d);
    if (!weeklyMap.has(key)) {
      weeklyMap.set(key, {
        week: getWeekDisplay(d),
        weekStart: range.start,
        weekEnd: range.end,
        businessWeekStart: range.start,
        visitCount: 0,
        reportedKm: 0,
        estimatedKm: 0,
        activeEmployees: new Set<string>(),
      });
    }
    const week = weeklyMap.get(key)!;
    week.visitCount += day.visitCount;
    week.reportedKm += day.reportedKm;
    week.estimatedKm += day.estimatedKm;
    for (const userId of day.activeEmployees) {
      week.activeEmployees.add(userId);
    }
  }

  // 裁剪首尾周标签为实际选中范围，并生成显示文案
  for (const week of weeklyMap.values()) {
    const start = parseDateTimeAsBeijing(week.weekStart);
    const end = parseDateTimeAsBeijing(week.weekEnd);
    const queryStart = parseDateTimeAsBeijing(startDate);
    const queryEnd = parseDateTimeAsBeijing(endDate);
    const actualStart = new Date(Math.max(start.getTime(), queryStart.getTime()));
    const actualEnd = new Date(Math.min(end.getTime(), queryEnd.getTime()));
    week.weekStart = formatBeijingDate(actualStart);
    week.weekEnd = formatBeijingDate(actualEnd);
    week.week = `${formatShortDate(week.weekStart)}-${formatShortDate(week.weekEnd)}`;
  }

  // 按业务周开始日期排序
  const weeklyTrend: WeeklyTrendItem[] = Array.from(weeklyMap.values())
    .sort((a, b) => a.businessWeekStart.localeCompare(b.businessWeekStart))
    .map((w) => ({
      week: w.week,
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      visitCount: w.visitCount,
      avgVisitsPerEmployee:
        w.activeEmployees.size > 0
          ? parseFloat((w.visitCount / w.activeEmployees.size).toFixed(2))
          : 0,
      reportedKm: parseFloat(w.reportedKm.toFixed(2)),
      estimatedKm: parseFloat(w.estimatedKm.toFixed(2)),
      activeEmployees: w.activeEmployees.size,
    }));

  // 3. 员工活跃度词云：只返回有数据的员工
  const employeeResult = await pool.query(
    `SELECT
       user_id,
       MAX(user_name) AS user_name,
       MAX(SPLIT_PART(SPLIT_PART(department, ',', 1), '-', 1)) AS department,
       COUNT(*) AS visit_count
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
     GROUP BY user_id
     ORDER BY visit_count DESC`,
    [startDate, endDate]
  );

  const userIds = employeeResult.rows.map((r) => r.user_id);

  // 每个员工的异常数（判定层）
  const anomalyResult = userIds.length
    ? await pool.query(
        `SELECT user_id, COUNT(*) AS anomaly_count
         FROM anomalies
         WHERE user_id = ANY($1)
           AND anomaly_date >= $2::date
           AND anomaly_date <= $3::date
           AND type = ANY($4)
         GROUP BY user_id`,
        [userIds, startDate, endDate, JUDGE_LAYER_ANOMALY_TYPES]
      )
    : { rows: [] };
  const anomalyCountMap = new Map<string, number>();
  for (const row of anomalyResult.rows) {
    anomalyCountMap.set(row.user_id, parseInt(row.anomaly_count, 10) || 0);
  }

  const employeeWordCloud: WordCloudEmployee[] = employeeResult.rows.map((row) => ({
    userId: row.user_id,
    userName: row.user_name || row.user_id,
    department: row.department || "",
    visitCount: parseInt(row.visit_count, 10) || 0,
    anomalyCount: anomalyCountMap.get(row.user_id) || 0,
  }));

  // 4. 部门雷达：只包含有数据的非排除顶层部门，销售部置顶
  const departmentResult = await pool.query(
    `SELECT
       SPLIT_PART(SPLIT_PART(department, ',', 1), '-', 1) AS dept_name,
       COUNT(*) AS visit_count,
       COUNT(DISTINCT user_id) AS employee_count,
       COUNT(DISTINCT NULLIF(customer_name, '')) AS customer_coverage
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
     GROUP BY dept_name
     ORDER BY visit_count DESC`,
    [startDate, endDate]
  );

  // 各部门估算里程（按 route 去重，避免 join visits 后重复计算）
  const deptMileageResult = await pool.query(
    `WITH route_dept AS (
       SELECT DISTINCT
         r.id,
         r.distance_km,
         SPLIT_PART(SPLIT_PART(v.department, ',', 1), '-', 1) AS dept_name
       FROM routes r
       JOIN visits v ON r.user_id = v.user_id AND r.business_date = v.business_date
       WHERE v.business_date >= $1::date AND v.business_date <= $2::date
     )
     SELECT dept_name, COALESCE(SUM(distance_km), 0) AS estimated_km
     FROM route_dept
     GROUP BY dept_name`,
    [startDate, endDate]
  );
  const deptEstimatedKmMap = new Map<string, number>();
  for (const row of deptMileageResult.rows) {
    deptEstimatedKmMap.set(row.dept_name, parseFloat(row.estimated_km) || 0);
  }

  const departmentRadar: DepartmentRadarItem[] = departmentResult.rows
    .filter((row) => !isExcludedTopDepartment(String(row.dept_name)))
    .map((row) => {
      const employeeCount = parseInt(row.employee_count, 10) || 0;
      const visitCount = parseInt(row.visit_count, 10) || 0;
      const customerCoverage = parseInt(row.customer_coverage, 10) || 0;
      const estimatedKm = deptEstimatedKmMap.get(row.dept_name) || 0;
      return {
        department: row.dept_name,
        avgVisitsPerEmployee:
          employeeCount > 0 ? parseFloat((visitCount / employeeCount).toFixed(1)) : 0,
        avgCustomerCoverage:
          employeeCount > 0 ? parseFloat((customerCoverage / employeeCount).toFixed(1)) : 0,
        avgEstimatedKm:
          employeeCount > 0 ? parseFloat((estimatedKm / employeeCount).toFixed(1)) : 0,
      };
    });

  // 销售部置顶
  const salesIndex = departmentRadar.findIndex((d) => d.department === "销售部");
  if (salesIndex > 0) {
    const [sales] = departmentRadar.splice(salesIndex, 1);
    departmentRadar.unshift(sales);
  }

  // 平均拜访频率：总拜访 / 活跃员工 / 周数
  const weekCount = weeklyTrend.length || 1;
  const avgVisitFrequency =
    activeEmployees > 0
      ? parseFloat((totalVisits / activeEmployees / weekCount).toFixed(2))
      : 0;

  return {
    start: startDate,
    end: endDate,
    summary: {
      totalVisits,
      activeEmployees,
      customerCoverage,
      avgVisitFrequency,
    },
    weeklyTrend,
    employeeWordCloud,
    departmentRadar,
  };
}
