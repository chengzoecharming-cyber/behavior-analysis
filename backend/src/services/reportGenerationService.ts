import { randomUUID } from "crypto";
import { pool } from "../db";
import { buildOrgTree, OrgTreeNode } from "./orgService";
import { buildRobotSignedUrl, getExportConfig, sendMarkdownToDingTalkChat } from "./dingtalkFile";
import { batchFilterHomeVisits, loadUserHomeAddresses } from "./addressWhitelistService";
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
import { Visit, Route, Stop } from "../types";
import { formatBeijingDate, getBeijingWeekday } from "../utils/timezone";

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
  let personStops: Stop[] | undefined;
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
    // 停留点（按开始时间排序，用于个人日报的「理论签到里程」板块）
    personStops = (
      await pool.query(
        `SELECT * FROM stops WHERE user_id = $1 AND business_date >= $2::date AND business_date <= $3::date ORDER BY start_time`,
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

  // 客户统计与客户列表排除员工住址（拜访轨迹仍完整展示）
  const visitUserIds = [...new Set(scopeData.visits.map((v) => v.user_id))];
  const homeAddressMap = await loadUserHomeAddresses(visitUserIds);
  const homeVisitIds = await batchFilterHomeVisits(scopeData.visits, homeAddressMap);

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
    stops: scope === "person" ? personStops : undefined,
    homeVisitIds,
    systemLink: buildSystemLink(scope, target, start, end),
  });

  // 记录内容大小，便于排查钉钉文档 API 因内容过大返回 ServiceUnavailable 的问题
  console.log(
    `[Report Gen] ${scope}/${scopeName} markdown 大小: ${(Buffer.byteLength(markdown, "utf8") / 1024).toFixed(1)} KB`
  );

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

/** 报告生成触发来源 */
export type ReportTriggerSource = "scheduler" | "manual" | "catchup";

/** 单个维度的生成结果（失败不再中断整个 run） */
export interface ReportGenerationResult {
  scope: ReportScope;
  name: string;
  url?: string;
  hasData?: boolean;
  status: "success" | "failed";
  error?: string;
}

/** 单维度导出最大尝试次数（首次 + 重试 1 次） */
const MAX_EXPORT_ATTEMPTS = 2;
/** 单维度导出失败重试间隔（毫秒） */
const RETRY_INTERVAL_MS = 5000;

const REPORT_TYPE_LABELS: Record<string, string> = {
  daily: "日报",
  weekly: "周报",
  monthly: "月报",
};

const SCOPE_LABELS: Record<ReportScope, string> = {
  company: "公司",
  department: "部门",
  sub_department: "子部门",
  person: "个人",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUserNameById(userId: string): Promise<string> {
  const userResult = await pool.query(
    "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return userResult.rows[0]?.user_name || userId;
}

/** 写入一条报告生成日志（写日志失败不影响主流程） */
async function insertGenerationLog(entry: {
  runId: string;
  reportType: string;
  periodStart: string;
  periodEnd: string;
  scope: ReportScope;
  scopeName: string;
  status: "success" | "failed";
  docUrl?: string;
  errorMessage?: string;
  durationMs: number;
  triggerSource: ReportTriggerSource;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO report_generation_logs
        (run_id, report_type, period_start, period_end, scope, scope_name, status, doc_url, error_message, duration_ms, trigger_source)
       VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.runId,
        entry.reportType,
        entry.periodStart,
        entry.periodEnd,
        entry.scope,
        entry.scopeName,
        entry.status,
        entry.docUrl || null,
        entry.errorMessage || null,
        entry.durationMs,
        entry.triggerSource,
      ]
    );
  } catch (err) {
    console.error("[Report Gen] 写入生成日志失败:", err);
  }
}

/** 导出单个维度的报告：失败重试一次，最终成功/失败都写日志，绝不向上抛异常 */
async function exportScopeWithRetry(options: {
  operatorUserId: string;
  workspaceName: string;
  scope: ReportScope;
  target: ReportScopeTarget;
  scopeName: string;
  start: string;
  end: string;
  orgTree: OrgTreeNode[];
  runId: string;
  reportType: string;
  triggerSource: ReportTriggerSource;
}): Promise<ReportGenerationResult> {
  const { scope, scopeName, start, end, runId, reportType, triggerSource } =
    options;
  const startedAt = Date.now();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_EXPORT_ATTEMPTS; attempt++) {
    try {
      const result = await exportReportToDingTalkDoc({
        operatorUserId: options.operatorUserId,
        workspaceName: options.workspaceName,
        scope,
        target: options.target,
        start,
        end,
        orgTree: options.orgTree,
      });
      await insertGenerationLog({
        runId,
        reportType,
        periodStart: start,
        periodEnd: end,
        scope,
        scopeName,
        status: "success",
        docUrl: result.url,
        durationMs: Date.now() - startedAt,
        triggerSource,
      });
      return {
        scope,
        name: scopeName,
        url: result.url,
        hasData: result.hasData,
        status: "success",
      };
    } catch (err: any) {
      lastError = err;
      console.warn(
        `[Report Gen] ${SCOPE_LABELS[scope]}/${scopeName} 第 ${attempt} 次导出失败:`,
        err?.message || err
      );
      if (attempt < MAX_EXPORT_ATTEMPTS) {
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  }

  const errorMessage = lastError?.message || String(lastError);
  await insertGenerationLog({
    runId,
    reportType,
    periodStart: start,
    periodEnd: end,
    scope,
    scopeName,
    status: "failed",
    errorMessage,
    durationMs: Date.now() - startedAt,
    triggerSource,
  });
  return { scope, name: scopeName, status: "failed", error: errorMessage };
}

/**
 * run 结束后发一条 markdown 汇总（成功/失败合并，避免刷屏）。
 * 优先走应用群机器人 /chat/send（DINGTALK_EXPORT_CHAT_ID，无关键词限制）；
 * 未配置 chatId 时回退到自定义机器人 webhook（受安全关键词限制）。
 */
async function sendReportRunSummary(
  reportType: string,
  periodStart: string,
  periodEnd: string,
  results: ReportGenerationResult[]
): Promise<void> {
  try {
    const { robotWebhook, robotSecret, chatId } = getExportConfig();
    if (!chatId && !robotWebhook) return;

    const successItems = results.filter((r) => r.status === "success");
    const failedItems = results.filter((r) => r.status === "failed");
    const successCountBy = (scope: ReportScope) =>
      successItems.filter((r) => r.scope === scope).length;
    const companyUrl = successItems.find((r) => r.scope === "company")?.url;

    const label = REPORT_TYPE_LABELS[reportType] || reportType;
    const periodText =
      periodStart === periodEnd ? periodStart : `${periodStart} ~ ${periodEnd}`;
    const hasFailed = failedItems.length > 0;

    // 群机器人若配置了安全关键词，消息内容必须包含该关键词，否则发送被拒（310000）
    const keyword = process.env.DINGTALK_EXPORT_ROBOT_KEYWORD || "";
    const prefix = keyword ? `【${keyword}】` : "";

    const lines = [
      `## ${prefix}${hasFailed ? "⚠️" : "📊"} 外勤${label} ${periodText} 已生成`,
      "",
      `共 ${results.length} 份（公司 ${successCountBy("company")} / 部门 ${successCountBy("department")} / 子部门 ${successCountBy("sub_department")} / 个人 ${successCountBy("person")}），成功 ${successItems.length}、失败 ${failedItems.length}`,
    ];
    if (hasFailed) {
      lines.push("", "**失败维度**：");
      for (const item of failedItems.slice(0, 10)) {
        lines.push(
          `- ${SCOPE_LABELS[item.scope]}/${item.name}：${item.error || "未知错误"}`
        );
      }
      if (failedItems.length > 10) {
        lines.push(`- …其余 ${failedItems.length - 10} 项详见「数据同步中心 - 报告生成」`);
      }
    }
    if (companyUrl) {
      lines.push("", `[查看详情](${companyUrl})`);
    }

    const title = `外勤${label}生成${hasFailed ? "（部分失败）" : "完成"}`;
    const text = lines.join("\n");

    // 优先走应用群机器人通道（无关键词限制），未配置 chatId 时回退 webhook
    if (chatId) {
      try {
        await sendMarkdownToDingTalkChat(title, text);
      } catch (err: any) {
        console.warn("[Report Gen] 群聊汇总发送失败:", err?.message || err);
      }
      return;
    }

    const url = buildRobotSignedUrl(robotWebhook!, robotSecret);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: {
          title: `外勤${label}生成${hasFailed ? "（部分失败）" : "完成"}`,
          text: lines.join("\n"),
        },
      }),
    });
    if (!res.ok) {
      console.warn("[Report Gen] 机器人汇总发送失败:", res.status, res.statusText);
      return;
    }
    const data: any = await res.json().catch(() => null);
    if (data && data.errcode !== 0) {
      console.warn("[Report Gen] 机器人汇总发送失败:", data.errmsg, `(${data.errcode})`);
    }
  } catch (err) {
    console.error("[Report Gen] 机器人汇总发送异常:", err);
  }
}

async function generateReportsForPeriod(
  start: string,
  end: string,
  workspaceName: string,
  options: { reportType: string; triggerSource: ReportTriggerSource }
): Promise<ReportGenerationResult[]> {
  const { reportType, triggerSource } = options;
  const operatorUserId = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operatorUserId) {
    throw new Error("未配置 DINGTALK_OPERATOR_USERID");
  }

  const tree = await buildOrgTree();
  // 同一次 run 内所有维度共享 run_id，用于聚合查询
  const runId = randomUUID();
  const results: ReportGenerationResult[] = [];

  // 公司维度
  const companyUserIds = getUserIdsForScope("company", null, tree);
  if (await hasRecentData(companyUserIds)) {
    results.push(
      await exportScopeWithRetry({
        operatorUserId,
        workspaceName,
        scope: "company",
        target: { scope: "company" },
        scopeName: "公司",
        start,
        end,
        orgTree: tree,
        runId,
        reportType,
        triggerSource,
      })
    );
  }

  // 部门 / 子部门 / 个人维度
  for (const dept of tree) {
    const deptUserIds = getUserIdsForScope("department", dept, tree);
    if (await hasRecentData(deptUserIds)) {
      results.push(
        await exportScopeWithRetry({
          operatorUserId,
          workspaceName,
          scope: "department",
          target: { scope: "department", deptName: dept.shortName },
          scopeName: dept.shortName,
          start,
          end,
          orgTree: tree,
          runId,
          reportType,
          triggerSource,
        })
      );
    }

    for (const sub of dept.children) {
      const subUserIds = getUserIdsForScope("sub_department", sub, tree);
      if (await hasRecentData(subUserIds)) {
        results.push(
          await exportScopeWithRetry({
            operatorUserId,
            workspaceName,
            scope: "sub_department",
            target: {
              scope: "sub_department",
              deptName: dept.shortName,
              subDeptName: sub.shortName,
            },
            scopeName: sub.shortName,
            start,
            end,
            orgTree: tree,
            runId,
            reportType,
            triggerSource,
          })
        );
      }

      for (const userId of sub.userIds || []) {
        if (await hasRecentData([userId])) {
          const userName = await getUserNameById(userId);
          results.push(
            await exportScopeWithRetry({
              operatorUserId,
              workspaceName,
              scope: "person",
              target: {
                scope: "person",
                deptName: dept.shortName,
                subDeptName: sub.shortName,
                userId,
                userName,
              },
              scopeName: userName,
              start,
              end,
              orgTree: tree,
              runId,
              reportType,
              triggerSource,
            })
          );
        }
      }
    }

    // 部门直属人员
    for (const userId of dept.userIds || []) {
      if (await hasRecentData([userId])) {
        const userName = await getUserNameById(userId);
        results.push(
          await exportScopeWithRetry({
            operatorUserId,
            workspaceName,
            scope: "person",
            target: {
              scope: "person",
              deptName: dept.shortName,
              userId,
              userName,
            },
            scopeName: userName,
            start,
            end,
            orgTree: tree,
            runId,
            reportType,
            triggerSource,
          })
        );
      }
    }
  }

  // run 结束后发一条机器人汇总（含失败告警），失败不影响返回结果
  await sendReportRunSummary(reportType, start, end, results);

  return results;
}

/** 生成某一天的日报 */
export async function generateDailyReports(
  date?: string,
  triggerSource: ReportTriggerSource = "scheduler"
): Promise<ReportGenerationResult[]> {
  const targetDate = date || formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成日报: ${targetDate}（${triggerSource}）`);
  const results = await generateReportsForPeriod(targetDate, targetDate, workspaceName, {
    reportType: "daily",
    triggerSource,
  });
  const failedCount = results.filter((r) => r.status === "failed").length;
  console.log(`[Report Gen] 日报生成完成: ${results.length} 份，失败 ${failedCount} 份`);
  return results;
}

/** 生成周报（默认本周一～今天，周日 18:00 触发时即本周一～周日） */
export async function generateWeeklyReports(
  start?: string,
  end?: string,
  triggerSource: ReportTriggerSource = "scheduler"
): Promise<ReportGenerationResult[]> {
  let weekStart: string;
  let weekEnd: string;
  if (start && end) {
    weekStart = start;
    weekEnd = end;
  } else {
    // 按北京时间计算本周一～今天，避免周日（getDay()=0）被算成上周
    const now = new Date();
    const weekday = getBeijingWeekday(now); // 0=周日
    const mondayOffset = weekday === 0 ? 6 : weekday - 1;
    weekStart = formatBeijingDate(new Date(now.getTime() - mondayOffset * 24 * 60 * 60 * 1000));
    weekEnd = formatBeijingDate(now);
  }
  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成周报: ${weekStart} ~ ${weekEnd}（${triggerSource}）`);
  const results = await generateReportsForPeriod(weekStart, weekEnd, workspaceName, {
    reportType: "weekly",
    triggerSource,
  });
  const failedCount = results.filter((r) => r.status === "failed").length;
  console.log(`[Report Gen] 周报生成完成: ${results.length} 份，失败 ${failedCount} 份`);
  return results;
}

/** 生成月报（默认上一月） */
export async function generateMonthlyReports(
  year?: number,
  month?: number,
  triggerSource: ReportTriggerSource = "scheduler"
): Promise<ReportGenerationResult[]> {
  let targetYear: number;
  let targetMonth: number;
  if (year && month) {
    targetYear = year;
    targetMonth = month;
  } else {
    // 按北京时间推算上个月，避免服务器本地时区（容器内为 UTC）影响
    const beijingToday = formatBeijingDate(new Date());
    const beijingYear = parseInt(beijingToday.slice(0, 4), 10);
    const beijingMonth = parseInt(beijingToday.slice(5, 7), 10);
    if (beijingMonth === 1) {
      targetYear = beijingYear - 1;
      targetMonth = 12;
    } else {
      targetYear = beijingYear;
      targetMonth = beijingMonth - 1;
    }
  }
  const monthStart = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const lastDay = new Date(targetYear, targetMonth, 0).getDate();
  const monthEnd = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${lastDay}`;

  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  console.log(`[Report Gen] 开始生成月报: ${monthStart} ~ ${monthEnd}（${triggerSource}）`);
  const results = await generateReportsForPeriod(monthStart, monthEnd, workspaceName, {
    reportType: "monthly",
    triggerSource,
  });
  const failedCount = results.filter((r) => r.status === "failed").length;
  console.log(`[Report Gen] 月报生成完成: ${results.length} 份，失败 ${failedCount} 份`);
  return results;
}
