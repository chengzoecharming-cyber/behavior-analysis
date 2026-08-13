import "dotenv/config";
import fs from "fs";
import path from "path";
import { pool } from "../src/db";
import { inferReportType, ReportScope, ReportScopeTarget } from "../src/services/dingtalkDoc";
import { buildOrgTree, OrgTreeNode } from "../src/services/orgService";
import { computeUserOverview } from "../src/services/userOverviewService";
import { renderWikiReportMarkdown } from "../src/services/wikiReportMarkdown";
import {
  batchFilterCompanyVisits,
  batchFilterHomeVisits,
  loadAllHomeAddresses,
  loadCompanyAddresses,
} from "../src/services/addressWhitelistService";
import { Visit, Route } from "../src/types";

interface Args {
  scope: ReportScope;
  user?: string;
  node?: string;
  date?: string;
  start?: string;
  end?: string;
  out?: string;
}

function parseArgs(): Args {
  const result: Args = { scope: "person" };
  for (const raw of process.argv.slice(2)) {
    const [key, ...parts] = raw.replace(/^--/, "").split("=");
    const value = parts.join("=");
    if (!value) continue;
    if (key === "scope" && ["company", "department", "sub_department", "person"].includes(value)) {
      result.scope = value as ReportScope;
    } else if (key === "user") {
      result.user = value;
    } else if (key === "node") {
      result.node = value;
    } else if (key === "date") {
      result.date = value;
    } else if (key === "start") {
      result.start = value;
    } else if (key === "end") {
      result.end = value;
    } else if (key === "out") {
      result.out = value;
    }
  }
  return result;
}

function assertDate(value: string | undefined, label: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`请提供 ${label}=YYYY-MM-DD`);
  }
  return value;
}

function collectUserIds(node: OrgTreeNode): string[] {
  const ids = new Set<string>();
  for (const userId of node.userIds || []) ids.add(userId);
  for (const child of node.children || []) {
    for (const userId of child.userIds || []) ids.add(userId);
  }
  return Array.from(ids);
}

function findDepartment(tree: OrgTreeNode[], name: string): OrgTreeNode | null {
  return tree.find((d) => d.name === name || d.shortName === name) || null;
}

function findSubDepartment(tree: OrgTreeNode[], name: string): OrgTreeNode | null {
  for (const dept of tree) {
    const sub = dept.children.find((c) => c.name === name || c.shortName === name);
    if (sub) return sub;
  }
  return null;
}

function getUserIdsForScope(scope: ReportScope, node: OrgTreeNode | null, tree: OrgTreeNode[]): string[] {
  if (scope === "company") {
    const ids = new Set<string>();
    for (const dept of tree) {
      for (const userId of collectUserIds(dept)) ids.add(userId);
    }
    return Array.from(ids);
  }
  if (!node) return [];
  return collectUserIds(node);
}

async function findUser(user: string): Promise<{ userId: string; userName: string } | null> {
  const byUsers = await pool.query(
    `SELECT user_id, user_name
     FROM users
     WHERE user_id = $1 OR user_name = $1
     ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [user]
  );
  if (byUsers.rows[0]) {
    return { userId: byUsers.rows[0].user_id, userName: byUsers.rows[0].user_name || byUsers.rows[0].user_id };
  }

  const byVisits = await pool.query(
    `SELECT user_id, user_name, COUNT(*) AS cnt
     FROM visits
     WHERE user_id = $1 OR user_name = $1
     GROUP BY user_id, user_name
     ORDER BY cnt DESC
     LIMIT 1`,
    [user]
  );
  if (!byVisits.rows[0]) return null;
  return { userId: byVisits.rows[0].user_id, userName: byVisits.rows[0].user_name || byVisits.rows[0].user_id };
}

function buildSystemLink(target: ReportScopeTarget, start: string, end: string): string {
  const baseUrl = (
    process.env.REPORT_SYSTEM_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    "http://8.219.97.3:5173"
  ).replace(/\/+$/, "");

  if (target.scope === "person" && target.userId) {
    if (start === end) return `${baseUrl}/console?user=${encodeURIComponent(target.userId)}&date=${start}`;
    return `${baseUrl}/console?user=${encodeURIComponent(target.userId)}&start=${start}&end=${end}`;
  }
  const params = new URLSearchParams({ scope: target.scope });
  if (target.scope === "department" && target.deptName) params.set("node", target.deptName);
  if (target.scope === "sub_department" && target.subDeptName) params.set("node", target.subDeptName);
  params.set("start", start);
  params.set("end", end);
  return `${baseUrl}/console?${params.toString()}`;
}

async function loadVisits(userIds: string[], start: string, end: string): Promise<Visit[]> {
  if (userIds.length === 0) return [];
  return (
    await pool.query(
      `SELECT *
       FROM visits
       WHERE user_id = ANY($1::text[])
         AND business_date >= $2::date
         AND business_date <= $3::date
       ORDER BY timestamp`,
      [userIds, start, end]
    )
  ).rows;
}

async function loadRoutes(userIds: string[], start: string, end: string): Promise<Route[]> {
  if (userIds.length === 0) return [];
  return (
    await pool.query(
      `SELECT *
       FROM routes
       WHERE user_id = ANY($1::text[])
         AND business_date >= $2::date
         AND business_date <= $3::date
       ORDER BY id`,
      [userIds, start, end]
    )
  ).rows;
}

async function buildHomeVisitIds(visits: Visit[]): Promise<Set<number>> {
  const homeAddressMap = await loadAllHomeAddresses();
  const homeVisitIds = await batchFilterHomeVisits(visits, homeAddressMap);
  const companyAddresses = await loadCompanyAddresses();
  for (const id of batchFilterCompanyVisits(visits, companyAddresses)) {
    homeVisitIds.add(id);
  }
  return homeVisitIds;
}

function countVisits(visits: Visit[], homeVisitIds: Set<number>): number {
  return visits
    .filter((v) => !v.exclude_from_visit_count && !homeVisitIds.has(v.id))
    .reduce((sum, v) => sum + (v.customer_count || 1), 0);
}

function sumRouteKm(routes: Route[]): number {
  return routes.reduce((sum, r) => sum + (r.distance_km || 0), 0);
}

async function main() {
  const args = parseArgs();
  const start = args.date || args.start;
  const end = args.date || args.end || args.start;
  const startDate = assertDate(start, "date 或 start");
  const endDate = assertDate(end, "date 或 end");
  if (startDate > endDate) throw new Error("start 不能晚于 end");

  const tree = await buildOrgTree();
  const { reportType, reportDate } = inferReportType(startDate, endDate);

  let target: ReportScopeTarget;
  let scopeName: string;
  let titleName: string;
  let visits: Visit[];
  let routes: Route[];
  let overview: { totals: { visit_count: number; estimated_distance_km: number } };

  if (args.scope === "person") {
    if (!args.user) throw new Error("person 预览需要 --user=姓名或user_id");
    const user = await findUser(args.user);
    if (!user) throw new Error(`找不到用户: ${args.user}`);
    target = { scope: "person", userId: user.userId, userName: user.userName };
    scopeName = user.userName;
    const fullOverview = await computeUserOverview(user.userId, startDate, endDate);
    visits = await loadVisits([user.userId], startDate, endDate);
    routes = await loadRoutes([user.userId], startDate, endDate);
    overview = fullOverview;
    titleName = fullOverview.totals.visit_count > 0 ? scopeName : `${scopeName}（${reportDate}_${reportType.replace("报", "无拜访")}）`;
  } else {
    let node: OrgTreeNode | null = null;
    if (args.scope === "department") {
      if (!args.node) throw new Error("department 预览需要 --node=部门名");
      node = findDepartment(tree, args.node);
      if (!node) throw new Error(`找不到部门: ${args.node}`);
      scopeName = node.shortName;
      target = { scope: "department", deptName: node.name };
    } else if (args.scope === "sub_department") {
      if (!args.node) throw new Error("sub_department 预览需要 --node=子部门名");
      node = findSubDepartment(tree, args.node);
      if (!node) throw new Error(`找不到子部门: ${args.node}`);
      scopeName = node.shortName;
      target = { scope: "sub_department", subDeptName: node.name };
    } else {
      scopeName = "公司";
      target = { scope: "company" };
    }

    const userIds = getUserIdsForScope(args.scope, node, tree);
    visits = await loadVisits(userIds, startDate, endDate);
    routes = await loadRoutes(userIds, startDate, endDate);
    const homeVisitIds = await buildHomeVisitIds(visits);
    overview = {
      totals: {
        visit_count: countVisits(visits, homeVisitIds),
        estimated_distance_km: sumRouteKm(routes),
      },
    };
    titleName = overview.totals.visit_count > 0 ? scopeName : `${scopeName}（${reportDate}_${reportType.replace("报", "无拜访")}）`;
  }

  const homeVisitIds = await buildHomeVisitIds(visits);
  const markdown = renderWikiReportMarkdown({
    scope: args.scope,
    scopeName,
    titleName,
    start: startDate,
    end: endDate,
    reportType,
    overview,
    visits,
    routes,
    homeVisitIds,
    systemLink: buildSystemLink(target, startDate, endDate),
    orgTree: tree,
  });

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, markdown, "utf8");
    console.log(`已写入预览文件: ${outPath}`);
  } else {
    console.log(markdown);
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
