import { OrgTreeNode } from "./orgService";
import { ReportScope, ReportType } from "./dingtalkDoc";
import { splitCustomerNames } from "./normalization";
import { computeCustomerVisitFrequency } from "./customerVisitFrequency";
import { resolveReportVisitNote } from "./exportConsoleReportMarkdown";
import { Route, Visit } from "../types";
import { formatBeijingDate, getBeijingWeekday } from "../utils/timezone";

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
  /** 公司相关名称（company_addresses.name），高频拜访关注章节按名称剔除公司自身打卡 */
  excludedCustomerNames?: string[];
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

/** 北京时间 HH:mm（TIMESTAMPTZ 为 UTC，+8 换算） */
function formatBeijingTimeHM(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const hh = String(bj.getUTCHours()).padStart(2, "0");
  const mm = String(bj.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 取 visits 的第一张照片 URL（photos 为 JSONB 数组） */
function firstPhotoUrl(v: Visit): string {
  const photos = (v as any).photos;
  if (Array.isArray(photos) && photos.length > 0 && typeof photos[0] === "string") {
    return photos[0];
  }
  return "";
}

/** 出行方式分类（仅日报使用）：含「开车」→ 车，其余非空 → 公（公共交通/其他）；空则不分类 */
function tripCategory(tripType?: string | null): { label: string; color: string } | null {
  const t = (tripType || "").trim();
  if (!t) return null;
  if (t.includes("开车")) return { label: "车", color: "#1890ff" };
  return { label: "公", color: "#722ed1" };
}

/** 多审批单出行方式不一致时，只给非开车（公共交通/其他）的记录打紫色 [公]，开车不打 */
function tripTagPublicOnly(v: Visit): string {
  const c = tripCategory(v.trip_type);
  return c && c.label === "公" ? ` <font color="${c.color}">公</font>` : "";
}

/**
 * 员工当日出行方式展示模式（仅日报）：
 * - 所有审批单出行方式一致（或只有一种）→ heading：tag 放人名/标题行；
 * - 多张审批单出行方式不同 → perItem：tag 放各审批单对应的客户名后。
 * 按「有出行方式的 visit」取分类集合；全部无出行方式（老数据）→ 不打 tag。
 */
function resolveTripTagMode(items: VisitItem[]): { headingTag: string; perItem: boolean } {
  const cats = new Set<string>();
  for (const item of items) {
    const c = tripCategory(item.visit.trip_type);
    if (c) cats.add(c.label);
  }
  if (cats.size !== 1) return { headingTag: "", perItem: cats.size > 1 };
  const c = tripCategory(items.find((i) => tripCategory(i.visit.trip_type))!.visit.trip_type)!;
  return { headingTag: ` <font color="${c.color}">${c.label}</font>`, perItem: false };
}

/** 钉钉图片 CDN（OSS）缩略图：原图撑满文档宽，追加 resize 参数生成小图文件 */
function thumbUrl(url: string, width = 150): string {
  if (!url || !url.includes("dingtalk.com")) return url;
  return `${url}?x-oss-process=image/resize,w_${width}`;
}

function renderVisitItem(
  index: number,
  item: VisitItem,
  duplicateCounts: Map<string, number>,
  isDaily: boolean,
  tripPerItem: boolean
): string {
  const count = duplicateCounts.get(duplicateKey(item.visit.user_id, item.customerName)) || 0;
  const marker = count > 2 ? `（重复拜访 ${count} 次）` : "";
  const note = resolveReportVisitNote(item.visit);
  const summary = note?.text?.trim() || "无拜访情况";

  // 陪同拜访（2026-10-15 v3 表单）：客户名后加橙色「陪」tag，陪同人名单独一行灰色次要信息
  const accompany = item.visit.visit_detail?.accompany?.trim();
  const accompanyTag = accompany ? ` <font color="#fa8c16">陪</font>` : "";
  // 出行方式不一致的日报：非开车审批单的记录客户名后加紫色「公」tag
  const tripTag = isDaily && tripPerItem ? tripTagPublicOnly(item.visit) : "";

  // 次要信息（仅日报）：打卡时间跟在客户名同行（灰色），地址单独一行（灰色），避免一行过长
  // 钉钉文档会把列表项内连续行合并成一段，每个子行末尾都加 <br/> 保证逐行显示
  let timeSuffix = "";
  let addressLine = "";
  if (isDaily) {
    const time = formatBeijingTimeHM(item.visit.timestamp as any);
    if (time) timeSuffix = ` <font color="#999">${time}</font>`;
    const address = item.visit.address?.trim() || "";
    if (address) addressLine = `<font color="#999">${address}</font>`;
  }

  const titleLine = `${index}. **${item.customerName}**${tripTag}${accompanyTag}${marker}${timeSuffix}`;

  // 照片（仅日报）：现场交流照片取第一张；陪同拜访时陪同合照也取第一张
  const photoUrl = isDaily ? firstPhotoUrl(item.visit) : "";
  const accompanyPhotoUrl =
    isDaily && accompany && Array.isArray(item.visit.visit_detail?.accompany_photo)
      ? item.visit.visit_detail!.accompany_photo![0] || ""
      : "";

  // 陪同拜访且有照片：两列布局在钉钉 markdown 导入下会爆表格（单元格不支持 <br/>/图片），
  // 实测不可用（2026-10-16 排版测试），回退为纯文本逐行 + 缩略图
  const lines = [titleLine];
  if (addressLine) lines.push(`   ${addressLine}<br/>`);
  if (accompany) lines.push(`   <font color="#999">陪同：${accompany}</font><br/>`);
  lines.push(`   ${summary}<br/>`);
  if (photoUrl) lines.push(`   ![](${thumbUrl(photoUrl)})<br/>`);
  if (accompanyPhotoUrl) lines.push(`   ![](${thumbUrl(accompanyPhotoUrl)})`);
  return lines.join("\n");
}

function renderSummary(lines: string[], visitCount: number, estimatedKm: number): void {
  lines.push(`> 拜访总数：${visitCount} 次`);
  lines.push(`> 总里程：${formatKm(estimatedKm)}`);
  lines.push("");
}

/**
 * 「高频拜访关注」小节：同一员工对同一客户 单业务周 >2 次或单自然月 >3 次。
 * 仅周报/月报渲染（日报不渲染）；仅展示，不计风险分。
 * 复用 input.visits 与报告侧已算好的住址/公司地址排除集合（homeVisitIds），不新增查询。
 */
function renderFreqSection(lines: string[], input: WikiReportInput): void {
  // input.visits 是未过滤的原始行，先按 exclude_from_visit_count 过滤（与分析接口口径一致）
  const items = computeCustomerVisitFrequency(
    input.visits.filter((v) => !v.exclude_from_visit_count),
    input.homeVisitIds,
    input.excludedCustomerNames
  ).filter((i) => i.flagged);

  lines.push("## 高频拜访关注");
  lines.push("");
  if (items.length === 0) {
    lines.push("本期无同客户高频拜访。");
    lines.push("");
    return;
  }
  lines.push("| 员工 | 客户 | 期内次数 | 峰值 |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of items) {
    lines.push(
      `| ${item.userName} | ${item.customerName} | ${item.totalCount} | ${item.flagReasons.join("、")} |`
    );
  }
  lines.push("");
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 取拜访的业务日期（YYYY-MM-DD），business_date 缺失时回退按签到时间的北京时间日期 */
function visitBusinessDate(v: Visit): string {
  const raw: any = v.business_date;
  if (raw instanceof Date) return formatBeijingDate(raw);
  if (typeof raw === "string" && raw) return raw.slice(0, 10);
  return formatBeijingDate(new Date(v.timestamp));
}

/** 日期分组标题：「周一 2026-08-25」，灰色粗体（钉钉文档支持 <font color> 标签，已实测） */
function formatDateGroupTitle(date: string): string {
  const weekday = getBeijingWeekday(new Date(`${date}T00:00:00Z`));
  return `<font color="gray">**${WEEKDAY_NAMES[weekday]} ${date}**</font>`;
}

/**
 * 渲染拜访条目列表。周报/月报（groupByDate=true）按业务日期升序分组，
 * 每日加「周X YYYY-MM-DD」小标题；编号在同一成员下跨日期连续。
 */
function renderVisitItems(
  lines: string[],
  items: VisitItem[],
  duplicateCounts: Map<string, number>,
  groupByDate: boolean,
  isDaily: boolean,
  tripPerItem: boolean
): void {
  if (!groupByDate) {
    for (let i = 0; i < items.length; i++) {
      lines.push(renderVisitItem(i + 1, items[i], duplicateCounts, isDaily, tripPerItem));
      lines.push("");
    }
    return;
  }

  const byDate = new Map<string, VisitItem[]>();
  for (const item of items) {
    const date = visitBusinessDate(item.visit);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(item);
  }

  let index = 0;
  for (const date of Array.from(byDate.keys()).sort()) {
    lines.push(formatDateGroupTitle(date));
    lines.push("");
    for (const item of byDate.get(date)!) {
      lines.push(renderVisitItem(++index, item, duplicateCounts, isDaily, tripPerItem));
      lines.push("");
    }
  }
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
  // 日报只有一天，无需按日期分组；周报/月报按日期分组展示
  const groupByDate = input.reportType !== "日报";
  const isDaily = input.reportType === "日报";

  lines.push(`# ${input.titleName} 客户拜访${input.reportType}`);
  lines.push("");
  lines.push(`**时间范围：** ${formatPeriod(input.start, input.end)}`);
  lines.push("");

  if (input.scope === "person") {
    const items = buildVisitItems(input.visits, input.homeVisitIds);
    // 日报：出行方式一致时 tag 放标题（人名）行，不一致时逐条打 [公]
    const tripMode = isDaily ? resolveTripTagMode(items) : { headingTag: "", perItem: false };
    if (tripMode.headingTag) {
      lines[0] = lines[0] + tripMode.headingTag;
    }
    renderSummary(lines, countVisits(input.visits, input.homeVisitIds), input.overview.totals.estimated_distance_km);

    if (groupByDate) {
      renderFreqSection(lines, input);
    }

    renderVisitItems(lines, items, duplicateCounts, groupByDate, isDaily, tripMode.perItem);
    if (items.length === 0) {
      lines.push("暂无有效客户拜访记录。");
      lines.push("");
    }

    renderSystemLink(lines, input.systemLink);
    return lines.join("\n");
  }

  renderSummary(lines, input.overview.totals.visit_count, input.overview.totals.estimated_distance_km);

  if (groupByDate) {
    renderFreqSection(lines, input);
  }

  for (const group of buildEmployeeGroups(input)) {
    lines.push(`## ${group.groupName}`);
    lines.push("");

    for (let userIndex = 0; userIndex < group.users.length; userIndex++) {
      const user = group.users[userIndex];
      const items = buildVisitItems(user.visits, input.homeVisitIds);
      // 日报：该员工出行方式一致时 tag 放人名行，不一致时逐条打 [公]
      const tripMode = isDaily ? resolveTripTagMode(items) : { headingTag: "", perItem: false };

      lines.push(`#### ${user.userName}${tripMode.headingTag}`);
      lines.push("");
      renderSummary(lines, countVisits(user.visits, input.homeVisitIds), user.estimatedKm);

      renderVisitItems(lines, items, duplicateCounts, groupByDate, isDaily, tripMode.perItem);
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
