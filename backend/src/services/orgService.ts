import { pool } from "../db";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { formatBeijingDate } from "../utils/timezone";
import {
  computeMileageByApprovalForUsers,
  aggregateMileageByUser,
  aggregateMileageByDate,
} from "./mileageAnalysis";

/** F10：公司视角排行榜中不展示的顶层部门 */
export const EXCLUDED_TOP_DEPARTMENTS = new Set([
  "财务",
  "人力资源部",
  "市场营销",
  "销售渠道",
  "销售渠道2",
  "供应商",
  "渠道及销售管理部",
  "研发部",
]);

/** 销售部在业务口径中的固定名称 */
const SALES_DEPARTMENT_NAME = "销售部";

/** 判断顶层部门是否应被排除（支持「部」后缀、子部门前缀等变体） */
export function isExcludedTopDepartment(name: string): boolean {
  for (const excluded of EXCLUDED_TOP_DEPARTMENTS) {
    if (name.startsWith(excluded)) {
      return true;
    }
  }
  return false;
}

/**
 * 组织架构服务
 *
 * 说明：
 * - 当前部门树从 visits.department 字段解析得到（如 "销售部-华东宁波"）
 * - "-" 前面的部分作为父部门，后面作为子部门
 * - 没有 "-" 的部门作为叶子节点
 * - 用户归属取其历史拜访记录中最常出现的叶子部门
 */

export interface OrgTreeNode {
  name: string; // 节点完整路径，如 "销售部" 或 "销售部-华东宁波"
  shortName: string; // 节点展示名称，如 "销售部" 或 "华东宁波"
  level: number; // 0=公司/根，1=部门，2=子部门
  children: OrgTreeNode[];
  userIds?: string[]; // 叶子节点下可下钻的用户列表（仅叶子节点有）
}

export interface OrgOverviewStat {
  totalVisits: number;
  totalEmployees: number;
  totalLocations: number;
  totalCustomers: number;
  totalReportedKm: number;
  totalEstimatedKm: number;
  totalStopMinutes: number;
  totalAnomalies: number;
}

export interface OrgRankingItem {
  key: string; // 下钻用的节点路径或用户ID
  name: string;
  level: "department" | "sub_department" | "person";
  visitCount: number;
  employeeCount: number;
  reportedKm: number;
  estimatedKm: number;
  stopMinutes: number;
  anomalyCount: number;
  /** 该节点是否还有可展开的下一级 */
  hasChildren: boolean;
  /** 风险命中标记（只要下级有命中即 true） */
  hasLowVisitCount: boolean;
  hasDuplicateLocation: boolean;
  hasMileageDeviation: boolean;
  hasMileageReadingInvalid: boolean;
}

export interface OrgTrendItem {
  date: string;
  visitCount: number;
  reportedKm: number;
  estimatedKm: number;
  stopMinutes: number;
  anomalyCount: number;
}

export interface OrgOverviewResult {
  scope: "company" | "department" | "sub_department";
  node: string;
  start: string;
  end: string;
  stats: OrgOverviewStat;
  ranking: OrgRankingItem[];
  trend: OrgTrendItem[];
  heatMapPoints: {
    lat: number;
    lng: number;
    count: number;
    userName: string;
    locationName: string;
    address: string;
    timestamp: string;
  }[];
  provinceDistribution: { name: string; count: number }[];
}

/**
 * 从 visits.department 解析出所有部门节点，并构建成树。
 */
export async function buildOrgTree(): Promise<OrgTreeNode[]> {
  const result = await pool.query(
    `SELECT DISTINCT department
     FROM visits
     WHERE department IS NOT NULL AND department <> ''
     ORDER BY department`
  );

  const roots = new Map<string, OrgTreeNode>();

  for (const row of result.rows) {
    const raw = String(row.department).trim();
    if (!raw) continue;

    // 处理逗号分隔的多部门：取第一个作为主业部门
    const primary = raw.split(",")[0].trim();
    if (!primary) continue;

    const segments = primary.split("-");

    if (segments.length === 1) {
      // 没有子部门的叶子节点
      const name = segments[0];
      if (isExcludedTopDepartment(name)) continue;
      if (!roots.has(name)) {
        roots.set(name, {
          name,
          shortName: name,
          level: 1,
          children: [],
          userIds: [],
        });
      }
    } else {
      const parentName = segments[0];
      if (isExcludedTopDepartment(parentName)) continue;
      const childName = segments.slice(1).join("-");

      if (!roots.has(parentName)) {
        roots.set(parentName, {
          name: parentName,
          shortName: parentName,
          level: 1,
          children: [],
        });
      }

      const parent = roots.get(parentName)!;
      let child = parent.children.find((c) => c.name === `${parentName}-${childName}`);
      if (!child) {
        child = {
          name: `${parentName}-${childName}`,
          shortName: childName,
          level: 2,
          children: [],
          userIds: [],
        };
        parent.children.push(child);
      }
    }
  }

  // 为每个叶子节点挂载用户列表
  for (const [_, root] of roots) {
    const leafNodes = root.children.length > 0 ? root.children : [root];
    for (const leaf of leafNodes) {
      leaf.userIds = await getUserIdsByOrgNode(leaf.name);
    }
  }

  return Array.from(roots.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 根据部门节点路径获取归属的用户ID列表（精确匹配叶子节点）。
 * 用户归属：取该用户在 visits 中最常出现的叶子部门。
 */
async function getUserIdsByOrgNode(nodeName: string): Promise<string[]> {
  const result = await pool.query(
    `WITH user_primary_dept AS (
       SELECT user_id,
              SPLIT_PART(department, ',', 1) AS primary_dept,
              COUNT(*) AS cnt,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rn
       FROM visits
       WHERE department IS NOT NULL AND department <> ''
       GROUP BY user_id, SPLIT_PART(department, ',', 1)
     )
     SELECT user_id
     FROM user_primary_dept
     WHERE rn = 1 AND primary_dept = $1`,
    [nodeName]
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * 获取某个节点下的所有用户ID（包括子部门）。
 */
async function getUserIdsUnderNode(nodeName: string): Promise<string[]> {
  const result = await pool.query(
    `WITH user_primary_dept AS (
       SELECT user_id,
              SPLIT_PART(department, ',', 1) AS primary_dept,
              COUNT(*) AS cnt,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rn
       FROM visits
       WHERE department IS NOT NULL AND department <> ''
       GROUP BY user_id, SPLIT_PART(department, ',', 1)
     )
     SELECT user_id
     FROM user_primary_dept
     WHERE rn = 1
       AND (primary_dept = $1 OR primary_dept LIKE $1 || '-%')`,
    [nodeName]
  );
  return result.rows.map((r) => r.user_id);
}

/**
 * 获取销售部在钉钉中的 dept_id。
 */
async function getSalesDeptId(): Promise<number | null> {
  const result = await pool.query(
    `SELECT dept_id FROM dingtalk_departments WHERE name = $1 LIMIT 1`,
    [SALES_DEPARTMENT_NAME]
  );
  if (result.rows.length === 0) return null;
  return parseInt(result.rows[0].dept_id, 10);
}

/**
 * 获取销售部下的所有子部门名称（按钉钉通讯录）。
 * 若钉钉表未同步，则退而求其次从 visits.department 解析。
 */
async function getSalesSubDepartments(): Promise<string[]> {
  const salesDeptId = await getSalesDeptId();
  if (salesDeptId) {
    const result = await pool.query(
      `SELECT name FROM dingtalk_departments WHERE parent_id = $1 ORDER BY name`,
      [salesDeptId]
    );
    if (result.rows.length > 0) {
      return result.rows.map((r) => String(r.name));
    }
  }

  // 兜底：从 visits 解析
  const result = await pool.query(
    `SELECT DISTINCT SPLIT_PART(SPLIT_PART(department, ',', 1), '-', 2) AS sub_name
     FROM visits
     WHERE department LIKE $1 || '-%'
     ORDER BY sub_name`,
    [SALES_DEPARTMENT_NAME]
  );
  return result.rows.map((r) => String(r.sub_name)).filter(Boolean);
}

/**
 * 判断指定节点在指定日期范围内是否还有下一级可展开。
 * - 人员节点：永远无
 * - 父部门/子部门：看其下是否有用户（不限于日期范围，保证展开入口稳定）
 */
async function nodeHasChildren(nodeName: string, level: "department" | "sub_department"): Promise<boolean> {
  if (level === "sub_department") {
    const userIds = await getUserIdsByOrgNode(nodeName);
    return userIds.length > 0;
  }
  // department 级别：有直属用户 或 有子部门用户
  const userIds = await getUserIdsUnderNode(nodeName);
  return userIds.length > 0;
}

/**
 * 判断部门字符串是否属于某个节点范围
 */
function departmentMatchesNode(department: string | null, nodeName: string): boolean {
  if (!department) return false;
  const primary = department.split(",")[0].trim();
  if (!primary) return false;

  // 节点是子部门：完全匹配前缀
  if (primary === nodeName) return true;

  // 节点是父部门：子部门以 "父部门-" 开头
  if (primary.startsWith(`${nodeName}-`)) return true;

  return false;
}

/**
 * 获取指定范围下的用户ID列表
 */
export async function resolveUserIdsForScope(
  scope: "company" | "department" | "sub_department",
  nodeName: string
): Promise<string[]> {
  if (scope === "company" || nodeName === "__ALL__") {
    const result = await pool.query(
      `SELECT DISTINCT user_id FROM visits WHERE user_id IS NOT NULL AND user_id <> ''`
    );
    return result.rows.map((r) => r.user_id);
  }

  // 父部门范围包含所有子部门用户
  return getUserIdsUnderNode(nodeName);
}

/**
 * 查询指定用户集合在日期范围内的拜访记录
 */
async function fetchVisitsForUsers(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<any[]> {
  if (userIds.length === 0) return [];

  const result = await pool.query(
    `SELECT id, user_id, user_name, business_date, lat, lng,
            location_name, address, timestamp, reported_distance_km,
            approval_id, trip_type
     FROM visits
     WHERE user_id = ANY($1)
       AND business_date >= $2::date
       AND business_date <= $3::date
     ORDER BY user_id, timestamp ASC`,
    [userIds, startDate, endDate]
  );
  return result.rows;
}

/**
 * 从地址字符串中提取省份名称。
 * 匹配中国常见省份、直辖市、自治区、特别行政区前缀。
 */
function extractProvince(address: string | null): string {
  if (!address) return "未知";
  const trimmed = address.trim();
  const provinces = [
    "北京", "天津", "上海", "重庆",
    "河北", "山西", "辽宁", "吉林", "黑龙江",
    "江苏", "浙江", "安徽", "福建", "江西", "山东",
    "河南", "湖北", "湖南",
    "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾",
    "内蒙古", "广西", "西藏", "宁夏", "新疆",
    "香港", "澳门",
  ];
  for (const p of provinces) {
    if (trimmed.startsWith(p)) return p;
  }
  return "未知";
}

/**
 * 统计指定用户范围内拜访地址的省份分布，返回 Top 5 + 其他。
 */
async function computeProvinceDistribution(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<{ name: string; count: number }[]> {
  if (userIds.length === 0) return [];
  const result = await pool.query(
    `SELECT address FROM visits
     WHERE user_id = ANY($1)
       AND business_date >= $2::date
       AND business_date <= $3::date
       AND address IS NOT NULL AND address <> ''`,
    [userIds, startDate, endDate]
  );

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const province = extractProvince(row.address);
    counts.set(province, (counts.get(province) || 0) + 1);
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top5 = sorted.slice(0, 5);
  const others = sorted.slice(5).reduce((sum, [, count]) => sum + count, 0);

  return [
    ...top5.map(([name, count]) => ({ name, count })),
    ...(others > 0 ? [{ name: "其他", count: others }] : []),
  ];
}

/**
 * 计算组织视角总览
 */
export async function computeOrgOverview(
  scope: "company" | "department" | "sub_department",
  nodeName: string,
  startDate: string,
  endDate: string
): Promise<OrgOverviewResult> {
  const userIds = await resolveUserIdsForScope(scope, nodeName);

  // 1. 基础统计：拜访数、员工数、地点数、客户数
  const overviewResult = await pool.query(
    `SELECT
       COUNT(*) AS total_visits,
       COUNT(DISTINCT user_id) AS total_employees,
       COUNT(DISTINCT CONCAT(ROUND(lat::numeric, 5), ',', ROUND(lng::numeric, 5))) AS total_locations,
       COUNT(DISTINCT customer_name) AS total_customers
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
       AND lat IS NOT NULL AND lng IS NOT NULL
       AND (lat <> 0 OR lng <> 0)
       AND user_id = ANY($3::text[])`,
    [startDate, endDate, userIds]
  );

  // 2. 填报里程与估算里程：统一按审批单首次签到日期聚合
  const mileageResults = await computeMileageByApprovalForUsers(
    userIds,
    startDate,
    endDate
  );
  const totalReportedKm = mileageResults.reduce(
    (sum, r) => sum + r.reportedKm,
    0
  );
  const totalEstimatedKm = mileageResults.reduce(
    (sum, r) => sum + r.estimatedKm,
    0
  );

  // 3. 停留时长
  const stopResult = await pool.query(
    `SELECT COALESCE(SUM(duration_minutes), 0) AS total_stop_minutes
     FROM stops
     WHERE user_id = ANY($1)
       AND business_date >= $2::date
       AND business_date <= $3::date`,
    [userIds, startDate, endDate]
  );

  // 4. 异常数
  const anomalyResult = await pool.query(
    `SELECT COUNT(*) AS total_anomalies
     FROM anomalies
     WHERE user_id = ANY($1)
       AND anomaly_date >= $2::date
       AND anomaly_date <= $3::date`,
    [userIds, startDate, endDate]
  );

  const stats: OrgOverviewStat = {
    totalVisits: parseInt(overviewResult.rows[0].total_visits, 10),
    totalEmployees: parseInt(overviewResult.rows[0].total_employees, 10),
    totalLocations: parseInt(overviewResult.rows[0].total_locations, 10),
    totalCustomers: parseInt(overviewResult.rows[0].total_customers, 10) || 0,
    totalReportedKm: parseFloat(totalReportedKm.toFixed(2)),
    totalEstimatedKm: parseFloat(totalEstimatedKm.toFixed(2)),
    totalStopMinutes: parseInt(stopResult.rows[0].total_stop_minutes, 10) || 0,
    totalAnomalies: parseInt(anomalyResult.rows[0].total_anomalies, 10),
  };

  // 6. 排行榜：根据 scope 决定下一级分组
  const ranking = await computeRanking(scope, nodeName, startDate, endDate, userIds);

  // 7. 趋势：按天聚合
  const trend = await computeTrend(userIds, startDate, endDate);

  // 8. 热力图点位
  const heatMapPoints = await computeHeatMapPoints(userIds, startDate, endDate);

  // 9. 省份分布
  const provinceDistribution = await computeProvinceDistribution(userIds, startDate, endDate);

  return {
    scope,
    node: nodeName,
    start: startDate,
    end: endDate,
    stats,
    ranking,
    trend,
    heatMapPoints,
    provinceDistribution,
  };
}

async function computeRanking(
  scope: "company" | "department" | "sub_department",
  nodeName: string,
  startDate: string,
  endDate: string,
  userIds: string[]
): Promise<OrgRankingItem[]> {
  if (scope === "company") {
    // 按父部门分组；过滤白名单，并强制保留销售部
    const result = await pool.query(
      `SELECT
         SPLIT_PART(SPLIT_PART(department, ',', 1), '-', 1) AS dept_name,
         COUNT(*) AS visit_count,
         COUNT(DISTINCT user_id) AS employee_count
       FROM visits
       WHERE business_date >= $1::date AND business_date <= $2::date
         AND user_id = ANY($3)
       GROUP BY dept_name
       ORDER BY visit_count DESC`,
      [startDate, endDate, userIds]
    );

    // 收集有数据的非排除父部门
    const itemMap = new Map<string, OrgRankingItem>();
    for (const row of result.rows) {
      const deptName = String(row.dept_name);
      if (isExcludedTopDepartment(deptName)) continue;

      const childUserIds = await getUserIdsUnderNode(deptName);
      const childStats = await getScopeStats(childUserIds, startDate, endDate);
      itemMap.set(deptName, {
        key: deptName,
        name: deptName,
        level: "department",
        visitCount: parseInt(row.visit_count, 10),
        employeeCount: parseInt(row.employee_count, 10),
        ...childStats,
        hasChildren: await nodeHasChildren(deptName, "department"),
      });
    }

    // 销售部始终展示，即使没有数据
    if (!itemMap.has(SALES_DEPARTMENT_NAME)) {
      const salesUserIds = await getUserIdsUnderNode(SALES_DEPARTMENT_NAME);
      const salesStats = await getScopeStats(salesUserIds, startDate, endDate);
      itemMap.set(SALES_DEPARTMENT_NAME, {
        key: SALES_DEPARTMENT_NAME,
        name: SALES_DEPARTMENT_NAME,
        level: "department",
        visitCount: 0,
        employeeCount: 0,
        ...salesStats,
        hasChildren: true, // 销售部固定可展开
      });
    } else {
      // 确保销售部标记为可展开
      itemMap.get(SALES_DEPARTMENT_NAME)!.hasChildren = true;
    }

    // 销售部置顶，其余按拜访量降序
    const salesItem = itemMap.get(SALES_DEPARTMENT_NAME)!;
    itemMap.delete(SALES_DEPARTMENT_NAME);
    const sorted = Array.from(itemMap.values()).sort((a, b) => b.visitCount - a.visitCount);
    return [salesItem, ...sorted];
  }

  if (scope === "department") {
    // 销售部：展示全部子部门（包括暂无数据的）
    if (nodeName === SALES_DEPARTMENT_NAME) {
      const salesSubDepts = await getSalesSubDepartments();
      const fullSubDeptNames = salesSubDepts.map((n) => `${SALES_DEPARTMENT_NAME}-${n}`);

      // 查询这些子部门在日期范围内的实际数据
      const result = await pool.query(
        `SELECT
           SPLIT_PART(department, ',', 1) AS sub_dept_name,
           COUNT(*) AS visit_count,
           COUNT(DISTINCT user_id) AS employee_count
         FROM visits
         WHERE business_date >= $1::date AND business_date <= $2::date
           AND user_id = ANY($3)
           AND SPLIT_PART(department, ',', 1) LIKE $4 || '-%'
         GROUP BY sub_dept_name
         ORDER BY visit_count DESC`,
        [startDate, endDate, userIds, nodeName]
      );

      const dataMap = new Map<string, { visitCount: number; employeeCount: number }>();
      for (const row of result.rows) {
        dataMap.set(String(row.sub_dept_name), {
          visitCount: parseInt(row.visit_count, 10),
          employeeCount: parseInt(row.employee_count, 10),
        });
      }

      const items: OrgRankingItem[] = [];
      for (const fullName of fullSubDeptNames) {
        const data = dataMap.get(fullName);
        const childUserIds = await getUserIdsByOrgNode(fullName);
        const childStats = await getScopeStats(childUserIds, startDate, endDate);
        items.push({
          key: fullName,
          name: fullName.replace(`${nodeName}-`, ""),
          level: "sub_department",
          visitCount: data?.visitCount ?? 0,
          employeeCount: data?.employeeCount ?? 0,
          ...childStats,
          hasChildren: await nodeHasChildren(fullName, "sub_department"),
        });
      }
      // 有数据的在前，无数据的在后，均保持内部名称排序
      return items.sort((a, b) => {
        if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
        return a.name.localeCompare(b.name, "zh-CN");
      });
    }

    // 其它父部门：仅展示有数据的子部门
    const result = await pool.query(
      `SELECT
         SPLIT_PART(department, ',', 1) AS sub_dept_name,
         COUNT(*) AS visit_count,
         COUNT(DISTINCT user_id) AS employee_count
       FROM visits
       WHERE business_date >= $1::date AND business_date <= $2::date
         AND user_id = ANY($3)
         AND SPLIT_PART(department, ',', 1) LIKE $4 || '-%'
       GROUP BY sub_dept_name
       ORDER BY visit_count DESC`,
      [startDate, endDate, userIds, nodeName]
    );

    const items: OrgRankingItem[] = [];
    for (const row of result.rows) {
      const subDeptName = row.sub_dept_name;
      const childUserIds = await getUserIdsUnderNode(subDeptName);
      const childStats = await getScopeStats(childUserIds, startDate, endDate);
      items.push({
        key: subDeptName,
        name: subDeptName.replace(`${nodeName}-`, ""),
        level: "sub_department",
        visitCount: parseInt(row.visit_count, 10),
        employeeCount: parseInt(row.employee_count, 10),
        ...childStats,
        hasChildren: await nodeHasChildren(subDeptName, "sub_department"),
      });
    }
    return items;
  }

  // scope === "sub_department"：按人员分组
  const result = await pool.query(
    `SELECT
       user_id,
       MAX(user_name) AS user_name,
       COUNT(*) AS visit_count
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
       AND user_id = ANY($3)
     GROUP BY user_id
     ORDER BY visit_count DESC`,
    [startDate, endDate, userIds]
  );

  const items: OrgRankingItem[] = [];
  for (const row of result.rows) {
    const childStats = await getScopeStats([row.user_id], startDate, endDate);
    items.push({
      key: row.user_id,
      name: row.user_name || row.user_id,
      level: "person",
      visitCount: parseInt(row.visit_count, 10),
      employeeCount: 1,
      ...childStats,
      hasChildren: false,
    });
  }
  return items;
}

async function getScopeStats(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<{
  reportedKm: number;
  estimatedKm: number;
  stopMinutes: number;
  anomalyCount: number;
  hasLowVisitCount: boolean;
  hasDuplicateLocation: boolean;
  hasMileageDeviation: boolean;
  hasMileageReadingInvalid: boolean;
}> {
  if (userIds.length === 0) {
    return {
      reportedKm: 0,
      estimatedKm: 0,
      stopMinutes: 0,
      anomalyCount: 0,
      hasLowVisitCount: false,
      hasDuplicateLocation: false,
      hasMileageDeviation: false,
      hasMileageReadingInvalid: false,
    };
  }

  const mileageResults = await computeMileageByApprovalForUsers(
    userIds,
    startDate,
    endDate
  );
  const byUser = aggregateMileageByUser(mileageResults);

  const [stops, anomalies, riskCounts] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(duration_minutes), 0) AS total
       FROM stops
       WHERE user_id = ANY($1)
         AND business_date >= $2::date
         AND business_date <= $3::date`,
      [userIds, startDate, endDate]
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM anomalies
       WHERE user_id = ANY($1)
         AND anomaly_date >= $2::date
         AND anomaly_date <= $3::date`,
      [userIds, startDate, endDate]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'low_visit_count') AS low_visit_count_count,
         COUNT(*) FILTER (WHERE type = 'duplicate_location') AS duplicate_location_count,
         COUNT(*) FILTER (WHERE type = 'mileage_deviation') AS mileage_deviation_count,
         COUNT(*) FILTER (WHERE type = 'mileage_reading_invalid') AS mileage_reading_invalid_count
       FROM anomalies
       WHERE user_id = ANY($1)
         AND anomaly_date >= $2::date
         AND anomaly_date <= $3::date`,
      [userIds, startDate, endDate]
    ),
  ]);

  const reportedKm = userIds.reduce(
    (sum, uid) => sum + (byUser.get(uid)?.reportedKm || 0),
    0
  );
  const estimatedKm = userIds.reduce(
    (sum, uid) => sum + (byUser.get(uid)?.estimatedKm || 0),
    0
  );

  const rc = riskCounts.rows[0];

  return {
    reportedKm: parseFloat(reportedKm.toFixed(2)),
    estimatedKm: parseFloat(estimatedKm.toFixed(2)),
    stopMinutes: parseInt(stops.rows[0].total, 10) || 0,
    anomalyCount: parseInt(anomalies.rows[0].total, 10) || 0,
    hasLowVisitCount: (parseInt(rc.low_visit_count_count, 10) || 0) > 0,
    hasDuplicateLocation: (parseInt(rc.duplicate_location_count, 10) || 0) > 0,
    hasMileageDeviation: (parseInt(rc.mileage_deviation_count, 10) || 0) > 0,
    hasMileageReadingInvalid: (parseInt(rc.mileage_reading_invalid_count, 10) || 0) > 0,
  };
}

async function computeTrend(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<OrgTrendItem[]> {
  const [visits, mileageResults, stops, anomalies] = await Promise.all([
    pool.query(
      `SELECT business_date, COUNT(*) AS visit_count
       FROM visits
       WHERE user_id = ANY($1)
         AND business_date >= $2::date
         AND business_date <= $3::date
       GROUP BY business_date
       ORDER BY business_date`,
      [userIds, startDate, endDate]
    ),
    computeMileageByApprovalForUsers(userIds, startDate, endDate),
    pool.query(
      `SELECT business_date, COALESCE(SUM(duration_minutes), 0) AS stop_minutes
       FROM stops
       WHERE user_id = ANY($1)
         AND business_date >= $2::date
         AND business_date <= $3::date
       GROUP BY business_date
       ORDER BY business_date`,
      [userIds, startDate, endDate]
    ),
    pool.query(
      `SELECT anomaly_date, COUNT(*) AS anomaly_count
       FROM anomalies
       WHERE user_id = ANY($1)
         AND anomaly_date >= $2::date
         AND anomaly_date <= $3::date
       GROUP BY anomaly_date
       ORDER BY anomaly_date`,
      [userIds, startDate, endDate]
    ),
  ]);

  const byDate = aggregateMileageByDate(mileageResults);

  const map = new Map<string, OrgTrendItem>();
  const ensureDay = (date: string) => {
    if (!map.has(date)) {
      map.set(date, {
        date,
        visitCount: 0,
        reportedKm: 0,
        estimatedKm: 0,
        stopMinutes: 0,
        anomalyCount: 0,
      });
    }
    return map.get(date)!;
  };

  for (const row of visits.rows) {
    ensureDay(formatBeijingDate(row.business_date)).visitCount = parseInt(row.visit_count, 10);
  }
  for (const [date, vals] of byDate) {
    const day = ensureDay(date);
    day.reportedKm = vals.reportedKm;
    day.estimatedKm = vals.estimatedKm;
  }
  for (const row of stops.rows) {
    ensureDay(formatBeijingDate(row.business_date)).stopMinutes = parseInt(row.stop_minutes, 10) || 0;
  }
  for (const row of anomalies.rows) {
    ensureDay(formatBeijingDate(row.anomaly_date)).anomalyCount = parseInt(row.anomaly_count, 10);
  }

  // 补齐无数据日期
  const result: OrgTrendItem[] = [];
  const s = new Date(startDate);
  const e = new Date(endDate);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split("T")[0];
    result.push(map.get(ds) || ensureDay(ds));
  }
  return result;
}

async function computeHeatMapPoints(
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<
  {
    lat: number;
    lng: number;
    count: number;
    userName: string;
    locationName: string;
    address: string;
    timestamp: string;
  }[]
> {
  const result = await pool.query(
    `SELECT
       lat,
       lng,
       COUNT(*) AS count,
       STRING_AGG(DISTINCT user_name, ', ' ORDER BY user_name) AS user_names,
       STRING_AGG(DISTINCT location_name, '; ' ORDER BY location_name) AS location_names,
       STRING_AGG(DISTINCT address, '; ' ORDER BY address) AS addresses,
       MIN(timestamp) AS first_timestamp
     FROM visits
     WHERE business_date >= $1::date AND business_date <= $2::date
       AND lat IS NOT NULL AND lng IS NOT NULL
       AND (lat <> 0 OR lng <> 0)
       AND user_id = ANY($3)
     GROUP BY lat, lng
     ORDER BY count DESC`,
    [startDate, endDate, userIds]
  );

  return result.rows.map((row) => ({
    lat: parseFloat(row.lat),
    lng: parseFloat(row.lng),
    count: parseInt(row.count, 10),
    userName: row.user_names || "",
    locationName: row.location_names || "",
    address: row.addresses || "",
    timestamp: row.first_timestamp,
  }));
}

