import { OrgTreeNode } from "./orgService";
import { ReportScope, ReportType } from "./dingtalkDoc";
import { splitCustomerNames } from "./normalization";
import { resolveReportVisitNote } from "./exportConsoleReportMarkdown";
import { Route, Visit } from "../types";

interface WikiReportOverview {
  totals: {
    visit_count: number;
    estimated_distance_km: number;
  };
}

export interface WikiReportInput {
  scope: ReportScope;
  scopeName: string;
  titleName: string;
  start: string;
  end: string;
  reportType: ReportType;
  overview: WikiReportOverview;
  visits: Visit[];
  routes: Route[];
  homeVisitIds?: Set<number>;
  systemLink: string;
  orgTree: OrgTreeNode[];
}

interface VisitItem {
  visit: Visit;
  customerName: string;
}

interface EmployeeGroup {
  groupName: string;
  users: {
    userId: string;
    userName: string;
    visits: Visit[];
    estimatedKm: number;
  }[];
}

function formatPeriod(start: string, end: string): string {
  return start === end ? start : `${start} ~ ${end}`;
}

function formatKm(value: number): string {
  return `${Math.round(value || 0)} km`;
}

function visitTimeMs(v: Visit): number {
  const time = new Date(v.timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isCountableVisit(v: Visit, homeVisitIds?: Set<number>): boolean {
  return !v.exclude_from_visit_count && !homeVisitIds?.has(v.id);
}

function countVisits(visits: Visit[], homeVisitIds?: Set<number>): number {
  return visits
    .filter((v) => isCountableVisit(v, homeVisitIds))
    .reduce((sum, v) => sum + (v.customer_count || 1), 0);
}

function resolveCustomerNames(v: Visit): string[] {
  const names = splitCustomerNames(v.customer_name);
  if (names.length > 0) return names;
  if (v.location_name?.trim()) return [v.location_name.trim()];
  if (v.address?.trim()) return [v.address.trim()];
  return ["未命名客户"];
}

function buildVisitItems(visits: Visit[], homeVisitIds?: Set<number>): VisitItem[] {
  return visits
    .filter((v) => isCountableVisit(v, homeVisitIds))
    .sort((a, b) => visitTimeMs(a) - visitTimeMs(b))
    .flatMap((visit) =>
      resolveCustomerNames(visit).map((customerName) => ({ visit, customerName }))
    );
}

function duplicateKey(userId: string, customerName: string): string {
  return `${userId}\u0000${customerName}`;
}

function buildDuplicateCounts(visits: Visit[], homeVisitIds?: Set<number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of buildVisitItems(visits, homeVisitIds)) {
    const key = duplicateKey(item.visit.user_id, item.customerName);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function renderVisitItem(
  index: number,
  item: VisitItem,
  duplicateCounts: Map<string, number>
): string {
  const count = duplicateCounts.get(duplicateKey(item.visit.user_id, item.customerName)) || 0;
  const marker = count > 2 ? `（重复拜访 ${count} 次）` : "";
  const note = resolveReportVisitNote(item.visit);
  const summary = note?.text?.trim() || "无拜访情况";
  return `${index}. **${item.customerName}**${marker}\n   ${summary}`;
}

function renderSummary(lines: string[], visitCount: number, estimatedKm: number): void {
  lines.push(`> 拜访总数：${visitCount} 次`);
  lines.push(`> 总里程：${formatKm(estimatedKm)}`);
  lines.push("");
}

function renderSystemLink(lines: string[], systemLink: string): void {
  lines.push("---");
  lines.push("");
  lines.push(`[进入系统查看详情](${systemLink})`);
  lines.push("");
}

function buildUserNameMap(visits: Visit[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const v of visits) {
    if (!result.has(v.user_id)) {
      result.set(v.user_id, v.user_name || v.user_id);
    }
  }
  return result;
}

function buildRouteDistanceByUser(routes: Route[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const r of routes) {
    result.set(r.user_id, (result.get(r.user_id) || 0) + (r.distance_km || 0));
  }
  return result;
}

function collectUserIds(node: OrgTreeNode): string[] {
  const ids = new Set<string>();
  for (const userId of node.userIds || []) ids.add(userId);
  for (const child of node.children || []) {
    for (const userId of child.userIds || []) ids.add(userId);
  }
  return Array.from(ids);
}

function buildEmployeeGroups(input: WikiReportInput): EmployeeGroup[] {
  const visitsByUser = new Map<string, Visit[]>();
  for (const v of input.visits) {
    if (!visitsByUser.has(v.user_id)) visitsByUser.set(v.user_id, []);
    visitsByUser.get(v.user_id)!.push(v);
  }

  const userNames = buildUserNameMap(input.visits);
  const distanceByUser = buildRouteDistanceByUser(input.routes);
  const makeUser = (userId: string) => ({
    userId,
    userName: userNames.get(userId) || userId,
    visits: (visitsByUser.get(userId) || []).sort((a, b) => visitTimeMs(a) - visitTimeMs(b)),
    estimatedKm: distanceByUser.get(userId) || 0,
  });

  const sortUsers = (ids: string[]) =>
    ids.sort((a, b) => (userNames.get(a) || a).localeCompare(userNames.get(b) || b, "zh-CN"));

  if (input.scope === "sub_department") {
    return [{
      groupName: input.scopeName,
      users: sortUsers(Array.from(visitsByUser.keys())).map(makeUser),
    }];
  }

  const groups: EmployeeGroup[] = [];
  for (const dept of input.orgTree) {
    if (input.scope === "department" && dept.name !== input.scopeName && dept.shortName !== input.scopeName) {
      continue;
    }

    const nodes = dept.children.length > 0 ? dept.children : [dept];
    for (const node of nodes) {
      const userIds = collectUserIds(node).filter((id) => visitsByUser.has(id));
      if (userIds.length === 0) continue;
      groups.push({
        groupName: node.shortName,
        users: sortUsers(userIds).map(makeUser),
      });
    }
  }

  if (groups.length > 0) return groups;

  return [{
    groupName: input.scopeName,
    users: sortUsers(Array.from(visitsByUser.keys())).map(makeUser),
  }];
}

export function renderWikiReportMarkdown(input: WikiReportInput): string {
  const lines: string[] = [];
  const duplicateCounts = buildDuplicateCounts(input.visits, input.homeVisitIds);

  lines.push(`# ${input.titleName} 客户拜访${input.reportType}`);
  lines.push("");
  lines.push(`**时间范围：** ${formatPeriod(input.start, input.end)}`);
  lines.push("");

  if (input.scope === "person") {
    const items = buildVisitItems(input.visits, input.homeVisitIds);
    renderSummary(lines, countVisits(input.visits, input.homeVisitIds), input.overview.totals.estimated_distance_km);

    for (let i = 0; i < items.length; i++) {
      lines.push(renderVisitItem(i + 1, items[i], duplicateCounts));
      lines.push("");
    }
    if (items.length === 0) {
      lines.push("暂无有效客户拜访记录。");
      lines.push("");
    }

    renderSystemLink(lines, input.systemLink);
    return lines.join("\n");
  }

  renderSummary(lines, input.overview.totals.visit_count, input.overview.totals.estimated_distance_km);

  for (const group of buildEmployeeGroups(input)) {
    lines.push(`## ${group.groupName}`);
    lines.push("");

    for (let userIndex = 0; userIndex < group.users.length; userIndex++) {
      const user = group.users[userIndex];
      const items = buildVisitItems(user.visits, input.homeVisitIds);

      lines.push(`#### ${user.userName}`);
      lines.push("");
      renderSummary(lines, countVisits(user.visits, input.homeVisitIds), user.estimatedKm);

      for (let i = 0; i < items.length; i++) {
        lines.push(renderVisitItem(i + 1, items[i], duplicateCounts));
        lines.push("");
      }
      if (items.length === 0) {
        lines.push("暂无有效客户拜访记录。");
        lines.push("");
      }

      if (userIndex < group.users.length - 1) {
        lines.push("---");
        lines.push("");
      }
    }
  }

  renderSystemLink(lines, input.systemLink);
  return lines.join("\n");
}
