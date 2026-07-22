import { pool } from "../db";
import { buildOrgTree, OrgTreeNode } from "./orgService";
import { computeUserOverview } from "./userOverviewService";
import { renderConsoleReportMarkdown } from "./exportConsoleReportMarkdown";
import {
  computeMileageByApprovalForUsers,
  aggregateMileageByDate,
} from "./mileageAnalysis";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  ensureReportFolder,
  createDoc,
  overwriteDocContent,
  findDocNodeByName,
  inferReportType,
  ReportScope,
  ReportScopeTarget,
  ReportType,
} from "./dingtalkDoc";
import { Visit, Route } from "../types";
import { formatBeijingDate } from "../utils/timezone";

const RECENT_DATA_WINDOW_DAYS = 14;

export interface ScopeData {
  scope: ReportScope;
  name: string;
  target: ReportScopeTarget;
  start: string;
  end: string;
  reportType: ReportType;
  overview: {
    totals: {
      visit_count: number;
      customer_count: number;
      reported_distance_km: number;
      estimated_distance_km: number;
      anomaly_count: number;
    };
    daily: {
      date: string;
      visit_count: number;
      customer_count: number;
      reported_distance_km: number;
      estimated_distance_km: number;
      anomaly_count: number;
    }[];
    anomalies: {
      id: number;
      type: string;
      description: string;
      severity: string;
      anomaly_date: string;
      metadata: Record<string, any>;
    }[];
  };
  visits: Visit[];
  routes: Route[];
  hasData: boolean;
}

function formatDate(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    return formatBeijingDate(value);
  }
  return String(value).slice(0, 10);
}

function getUserIdsForScope(
  scope: ReportScope,
  node: OrgTreeNode | null,
  tree: OrgTreeNode[]
): string[] {
  if (scope === "company") {
    const ids = new Set<string>();
    for (const dept of tree) {
      for (const uid of dept.userIds || []) ids.add(uid);
      for (const sub of dept.children) {
        for (const uid of sub.userIds || []) ids.add(uid);
      }
    }
    return Array.from(ids);
  }

  if (!node) return [];

  if (scope === "department") {
    const ids = new Set<string>();
    for (const uid of node.userIds || []) ids.add(uid);
    for (const sub of node.children) {
      for (const uid of sub.userIds || []) ids.add(uid);
    }
    return Array.from(ids);
  }

  if (scope === "sub_department") {
    return node.userIds || [];
  }

  return [];
}

async function hasRecentData(userIds: string[]): Promise<boolean> {
  if (userIds.length === 0) return false;
  const result = await pool.query(
    `SELECT 1 FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= CURRENT_DATE - INTERVAL '${RECENT_DATA_WINDOW_DAYS} days'
     LIMIT 1`,
    [userIds]
  );
  return result.rows.length > 0;
}

async function computeScopeOverview(
  scope: ReportScope,
  node: OrgTreeNode | null,
  tree: OrgTreeNode[],
  start: string,
  end: string
): Promise<{ overview: ScopeData["overview"]; hasData: boolean; visits: Visit[]; routes: Route[] }> {
  const userIds = getUserIdsForScope(scope, node, tree);

  // 1. 总拜访次数/客户数
  const visitResult = await pool.query(
    `SELECT COUNT(*) AS visit_count,
            COUNT(DISTINCT COALESCE(customer_name, location_name)) AS customer_count
     FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= $2::date
       AND business_date <= $3::date`,
    [userIds, start, end]
  );

  // 2. 每日聚合
  const dailyResult = await pool.query(
    `SELECT business_date,
            COUNT(*) AS visit_count,
            COUNT(DISTINCT COALESCE(customer_name, location_name)) AS customer_count
     FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= $2::date
       AND business_date <= $3::date
     GROUP BY business_date
     ORDER BY business_date`,
    [userIds, start, end]
  );

  // 3. 每日估算里程（routes）与填报里程（按审批单聚合）
  const mileageResults = await computeMileageByApprovalForUsers(userIds, start, end);
  const byDate = aggregateMileageByDate(mileageResults);

  // 4. 异常数（按日）
  const anomalyResult = await pool.query(
    `SELECT anomaly_date, COUNT(*) AS anomaly_count
     FROM anomalies
     WHERE user_id = ANY($1::text[])
       AND anomaly_date >= $2::date
       AND anomaly_date <= $3::date
     GROUP BY anomaly_date
     ORDER BY anomaly_date`,
    [userIds, start, end]
  );

  // 6. 异常明细
  const anomalyDetailResult = await pool.query(
    `SELECT id, type, description, severity, anomaly_date, metadata
     FROM anomalies
     WHERE user_id = ANY($1::text[])
       AND anomaly_date >= $2::date
       AND anomaly_date <= $3::date
     ORDER BY anomaly_date DESC, created_at DESC`,
    [userIds, start, end]
  );

  // 7. 拜访明细（用于客户列表和地图点位）
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= $2::date
       AND business_date <= $3::date
     ORDER BY timestamp`,
    [userIds, start, end]
  );

  // 8. 路线明细
  const routesResult = await pool.query(
    `SELECT * FROM routes
     WHERE user_id = ANY($1::text[])
       AND business_date >= $2::date
       AND business_date <= $3::date
     ORDER BY id`,
    [userIds, start, end]
  );

  // 合并每日数据
  const dateMap = new Map<
    string,
    {
      date: string;
      visit_count: number;
      customer_count: number;
      reported_distance_km: number;
      estimated_distance_km: number;
      anomaly_count: number;
    }
  >();

  const ensureDay = (date: string) => {
    if (!dateMap.has(date)) {
      dateMap.set(date, {
        date,
        visit_count: 0,
        customer_count: 0,
        reported_distance_km: 0,
        estimated_distance_km: 0,
        anomaly_count: 0,
      });
    }
    return dateMap.get(date)!;
  };

  for (const row of dailyResult.rows) {
    const d = ensureDay(formatDate(row.business_date));
    d.visit_count = parseInt(row.visit_count, 10);
    d.customer_count = parseInt(row.customer_count, 10);
  }
  for (const [date, vals] of byDate) {
    const d = ensureDay(date);
    d.reported_distance_km = vals.reportedKm;
    d.estimated_distance_km = vals.estimatedKm;
  }
  for (const row of anomalyResult.rows) {
    const d = ensureDay(formatDate(row.anomaly_date));
    d.anomaly_count = parseInt(row.anomaly_count, 10);
  }

  const daily = Array.from(dateMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const totals = daily.reduce(
    (acc, cur) => ({
      visit_count: acc.visit_count + cur.visit_count,
      customer_count: Math.max(acc.customer_count, cur.customer_count),
      reported_distance_km: acc.reported_distance_km + cur.reported_distance_km,
      estimated_distance_km:
        acc.estimated_distance_km + cur.estimated_distance_km,
      anomaly_count: acc.anomaly_count + cur.anomaly_count,
    }),
    {
      visit_count: 0,
      customer_count: 0,
      reported_distance_km: 0,
      estimated_distance_km: 0,
      anomaly_count: 0,
    }
  );

  // customer_count 跨天去重应该用全局，这里简单用每日最大不太准确，重新计算全局去重
  const globalCustomerResult = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(customer_name, location_name)) AS customer_count
     FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= $2::date
       AND business_date <= $3::date`,
    [userIds, start, end]
  );
  totals.customer_count =
    parseInt(globalCustomerResult.rows[0]?.customer_count, 10) || 0;

  return {
    overview: {
      totals: {
        visit_count: totals.visit_count,
        customer_count: totals.customer_count,
        reported_distance_km: parseFloat(
          totals.reported_distance_km.toFixed(2)
        ),
        estimated_distance_km: Math.round(totals.estimated_distance_km),
        anomaly_count: totals.anomaly_count,
      },
      daily,
      anomalies: anomalyDetailResult.rows.map((r) => ({
        id: r.id,
        type: r.type,
        description: r.description,
        severity: r.severity,
        anomaly_date: formatDate(r.anomaly_date),
        metadata: r.metadata || {},
      })),
    },
    hasData: visitResult.rows[0]?.visit_count > 0,
    visits: visitsResult.rows,
    routes: routesResult.rows,
  };
}

function buildScopeName(scope: ReportScope, target: ReportScopeTarget): string {
  if (scope === "company") return "公司";
  if (scope === "department") return target.deptName || "部门";
  if (scope === "sub_department") return target.subDeptName || "子部门";
  return target.userName || "个人";
}

function buildSystemLink(
  scope: ReportScope,
  target: ReportScopeTarget,
  start: string,
  end: string
): string {
  if (scope === "person" && target.userId) {
    if (start === end) {
      return `/console?user=${encodeURIComponent(target.userId)}&date=${start}`;
    }
    return `/console?user=${encodeURIComponent(target.userId)}&start=${start}&end=${end}`;
  }
  return `/decision?start=${start}&end=${end}&mode=custom`;
}

export async function exportReportToDingTalkDoc(options: {
  operatorUserId: string;
  workspaceName: string;
  scope: ReportScope;
  target: ReportScopeTarget;
  start: string;
  end: string;
  orgTree?: OrgTreeNode[];
}): Promise<{
  url: string;
  docKey: string;
  nodeId: string;
  scope: ReportScope;
  reportType: ReportType;
  hasData: boolean;
}> {
  const { operatorUserId, workspaceName, scope, target, start, end, orgTree } =
    options;

  const operatorUnionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(operatorUnionId, workspaceName);
  const workspaceId = workspace.workspaceId;
  const rootNodeId = workspace.rootNodeId || "root";

  const { reportType, reportDate } = inferReportType(start, end);

  // 构建/复用组织架构树
  const tree = orgTree || (await buildOrgTree());

  // 找到对应节点
  let node: OrgTreeNode | null = null;
  if (scope === "department") {
    node = tree.find(
      (d) => d.shortName === target.deptName || d.name === target.deptName
    ) || null;
  } else if (scope === "sub_department") {
    for (const dept of tree) {
      const sub = dept.children.find(
        (c) =>
          c.shortName === target.subDeptName || c.name === target.subDeptName
      );
      if (sub) {
        node = sub;
        break;
      }
    }
  }

  // 计算数据
  let scopeData: Awaited<ReturnType<typeof computeScopeOverview>>;
  if (scope === "person" && target.userId) {
    const overview = await computeUserOverview(target.userId, start, end);
    const visits = (
      await pool.query(
        `SELECT * FROM visits WHERE user_id = $1 AND business_date >= $2::date AND business_date <= $3::date ORDER BY timestamp`,
        [target.userId, start, end]
      )
    ).rows;
    const routes = (
      await pool.query(
        `SELECT * FROM routes WHERE user_id = $1 AND business_date >= $2::date AND business_date <= $3::date ORDER BY id`,
        [target.userId, start, end]
      )
    ).rows;
    scopeData = {
      overview: {
        totals: {
          visit_count: overview.totals.visit_count,
          customer_count: overview.totals.visit_count,
          reported_distance_km: overview.totals.reported_distance_km,
          estimated_distance_km: overview.totals.estimated_distance_km,
          anomaly_count: overview.totals.anomaly_count,
        },
        daily: overview.daily.map((d) => ({
          date: d.date,
          visit_count: d.visit_count,
          customer_count: d.visit_count,
          reported_distance_km: d.reported_distance_km,
          estimated_distance_km: d.estimated_distance_km,
          anomaly_count: d.anomaly_count,
        })),
        anomalies: overview.anomalies.map((a) => ({
          id: a.id,
          type: a.type,
          description: a.description,
          severity: a.severity,
          anomaly_date: a.anomaly_date,
          metadata: a.metadata,
        })),
      },
      hasData: overview.totals.visit_count > 0,
      visits,
      routes,
    };
  } else {
    scopeData = await computeScopeOverview(scope, node, tree, start, end);
  }

  const scopeName = buildScopeName(scope, target);
  const titleName = scopeData.hasData ? scopeName : `${scopeName}（${reportDate}_${reportType.replace("报", "无拜访")}）`;

  // 生成 Markdown
  const markdown = renderConsoleReportMarkdown({
    userName: titleName,
    userId: target.userId,
    start,
    end,
    reportType,
    overview: scopeData.overview as any,
    visits: scope === "person" ? scopeData.visits : scopeData.visits,
    routes: scope === "person" ? scopeData.routes : undefined,
    systemLink: buildSystemLink(scope, target, start, end),
  });

  // 定位目标文件夹
  const targetFolder = await ensureReportFolder(
    operatorUnionId,
    workspaceId,
    rootNodeId,
    target,
    reportType,
    tree
  );

  // 文档名：{报告类型}_{名称}_{日期范围}
  const docName = `${reportType}_${scopeName}_${start}_${end}`;

  // 检查是否已存在
  const existingDoc = await findDocNodeByName(
    operatorUnionId,
    workspaceId,
    targetFolder.nodeId,
    docName
  );

  let doc;
  if (existingDoc?.nodeId) {
    console.log(`[Report Gen] 文档已存在，覆写: ${docName}`);
    await overwriteDocContent(existingDoc.nodeId, operatorUnionId, markdown);
    doc = {
      nodeId: existingDoc.nodeId,
      docKey: existingDoc.nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${existingDoc.nodeId}`,
    };
  } else {
    console.log(`[Report Gen] 创建新文档: ${docName}`);
    doc = await createDoc(
      operatorUnionId,
      workspaceId,
      targetFolder.nodeId,
      docName
    );
    await overwriteDocContent(doc.dentryUuid, operatorUnionId, markdown);
  }

  return {
    url: doc.url,
    docKey: doc.docKey,
    nodeId: doc.nodeId,
    scope,
    reportType,
    hasData: scopeData.hasData,
  };
}

async function generateReportsForPeriod(
  start: string,
  end: string,
  workspaceName: string
): Promise<{ scope: ReportScope; name: string; url: string; hasData: boolean }[]> {
  const operatorUserId = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operatorUserId) {
    throw new Error("未配置 DINGTALK_OPERATOR_USERID");
  }

  const tree = await buildOrgTree();
  const results: { scope: ReportScope; name: string; url: string; hasData: boolean }[] = [];

  // 公司维度
  const companyUserIds = getUserIdsForScope("company", null, tree);
  if (await hasRecentData(companyUserIds)) {
    const result = await exportReportToDingTalkDoc({
      operatorUserId,
      workspaceName,
      scope: "company",
      target: { scope: "company" },
      start,
      end,
      orgTree: tree,
    });
    results.push({ scope: "company", name: "公司", url: result.url, hasData: result.hasData });
  }

  // 部门 / 子部门 / 个人维度
  for (const dept of tree) {
    const deptUserIds = getUserIdsForScope("department", dept, tree);
    if (await hasRecentData(deptUserIds)) {
      const result = await exportReportToDingTalkDoc({
        operatorUserId,
        workspaceName,
        scope: "department",
        target: { scope: "department", deptName: dept.shortName },
        start,
        end,
        orgTree: tree,
      });
      results.push({ scope: "department", name: dept.shortName, url: result.url, hasData: result.hasData });
    }

    for (const sub of dept.children) {
      const subUserIds = getUserIdsForScope("sub_department", sub, tree);
      if (await hasRecentData(subUserIds)) {
        const result = await exportReportToDingTalkDoc({
          operatorUserId,
          workspaceName,
          scope: "sub_department",
          target: { scope: "sub_department", deptName: dept.shortName, subDeptName: sub.shortName },
          start,
          end,
          orgTree: tree,
        });
        results.push({ scope: "sub_department", name: sub.shortName, url: result.url, hasData: result.hasData });
      }

      for (const userId of sub.userIds || []) {
        if (await hasRecentData([userId])) {
          const userResult = await pool.query(
            "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
            [userId]
          );
          const userName = userResult.rows[0]?.user_name || userId;
          const result = await exportReportToDingTalkDoc({
            operatorUserId,
            workspaceName,
            scope: "person",
            target: { scope: "person", deptName: dept.shortName, subDeptName: sub.shortName, userId, userName },
            start,
            end,
            orgTree: tree,
          });
          results.push({ scope: "person", name: userName, url: result.url, hasData: result.hasData });
        }
      }
    }

    // 部门直属人员
    for (const userId of dept.userIds || []) {
      if (await hasRecentData([userId])) {
        const userResult = await pool.query(
          "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
          [userId]
        );
        const userName = userResult.rows[0]?.user_name || userId;
        const result = await exportReportToDingTalkDoc({
          operatorUserId,
          workspaceName,
          scope: "person",
          target: { scope: "person", deptName: dept.shortName, userId, userName },
          start,
          end,
          orgTree: tree,
        });
        results.push({ scope: "person", name: userName, url: result.url, hasData: result.hasData });
      }
    }
  }

  return results;
}

/** 生成某一天的日报 */
export async function generateDailyReports(date?: string): Promise<
  { scope: ReportScope; name: string; url: string; hasData: boolean }[]
> {
  const targetDate = date || formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成日报: ${targetDate}`);
  const results = await generateReportsForPeriod(targetDate, targetDate, workspaceName);
  console.log(`[Report Gen] 日报生成完成: ${results.length} 份`);
  return results;
}

/** 生成周报（默认上一周） */
export async function generateWeeklyReports(
  start?: string,
  end?: string
): Promise<{ scope: ReportScope; name: string; url: string; hasData: boolean }[]> {
  let weekStart: string;
  let weekEnd: string;
  if (start && end) {
    weekStart = start;
    weekEnd = end;
  } else {
    const now = new Date();
    const dayOfWeek = now.getDay() || 7;
    const lastSunday = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
    const lastMonday = new Date(lastSunday.getTime() - 6 * 24 * 60 * 60 * 1000);
    weekStart = formatDate(lastMonday);
    weekEnd = formatDate(lastSunday);
  }
  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成周报: ${weekStart} ~ ${weekEnd}`);
  const results = await generateReportsForPeriod(weekStart, weekEnd, workspaceName);
  console.log(`[Report Gen] 周报生成完成: ${results.length} 份`);
  return results;
}

/** 生成月报（默认上一月） */
export async function generateMonthlyReports(
  year?: number,
  month?: number
): Promise<{ scope: ReportScope; name: string; url: string; hasData: boolean }[]> {
  let targetYear: number;
  let targetMonth: number;
  if (year && month) {
    targetYear = year;
    targetMonth = month;
  } else {
    const now = new Date();
    targetYear = now.getFullYear();
    targetMonth = now.getMonth();
    if (targetMonth === 0) {
      targetYear -= 1;
      targetMonth = 12;
    }
  }
  const monthStart = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(targetYear, targetMonth, 0).getDate();
  const monthEnd = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${lastDay}`;

  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成月报: ${monthStart} ~ ${monthEnd}`);
  const results = await generateReportsForPeriod(monthStart, monthEnd, workspaceName);
  console.log(`[Report Gen] 月报生成完成: ${results.length} 份`);
  return results;
}
