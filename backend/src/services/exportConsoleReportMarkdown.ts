import { UserOverviewResult } from "./userOverviewService";
import { Visit, Route, Stop } from "../types";
import { ReportType } from "./dingtalkDoc";

export interface MarkdownReportInput {
  userName: string;
  userId?: string;
  start: string;
  end: string;
  reportType: ReportType;
  overview: UserOverviewResult;
  visits?: Visit[];
  routes?: Route[];
  /** 停留点列表，仅个人日报用于「估算里程」板块 */
  stops?: Stop[];
  /** 系统访问链接，会追加在报告底部 */
  systemLink?: string;
}

function formatTime(dateInput: Date | string): string {
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return String(dateInput);
  return d.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildSystemLink(input: MarkdownReportInput): string {
  if (input.systemLink) return input.systemLink;
  if (input.userId) {
    if (input.start === input.end) {
      return `/console?user=${encodeURIComponent(input.userId)}&date=${input.start}`;
    }
    return `/console?user=${encodeURIComponent(input.userId)}&start=${input.start}&end=${input.end}`;
  }
  return `/decision?start=${input.start}&end=${input.end}&mode=custom`;
}

function resolveCustomerDisplayName(v: Visit): string {
  // 1. 优先使用真实客户名
  let customer = (v.customer_name || "").trim();
  // 去掉钉钉表单常见前缀
  customer = customer.replace(/^客户名称[:：]\s*/, "");

  // 过滤占位/无效客户名（包含「虚拟客户」「签到用」或清空前缀后为空）
  if (customer && !customer.includes("虚拟客户") && !customer.includes("签到用")) {
    return customer;
  }

  // 2. 没有真实客户名时用地址
  const address = (v.address || "").trim();
  if (address) {
    return address;
  }

  // 3. 兜底用 location_name
  const location = (v.location_name || "").trim();
  if (location) {
    return location;
  }

  return "未命名客户";
}

function computeCustomerFrequency(
  visits: Visit[]
): { customerName: string; count: number }[] {
  const map = new Map<string, number>();
  for (const v of visits) {
    const name = resolveCustomerDisplayName(v);
    map.set(name, (map.get(name) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([customerName, count]) => ({ customerName, count }))
    .sort((a, b) => b.count - a.count);
}

function renderCoreSummary(
  lines: string[],
  totals: UserOverviewResult["totals"],
  visits?: Visit[]
) {
  const customerCount = visits
    ? new Set(
        visits.map(
          (v) => v.customer_name || v.location_name || "未命名客户"
        )
      ).size
    : 0;

  lines.push("## 核心指标");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 拜访客户数 | ${customerCount} 家 |`);
  lines.push(`| 拜访次数 | ${totals.visit_count} 次 |`);
  lines.push(`| 估算里程 | ${Math.round(totals.estimated_distance_km)} km |`);
  lines.push("");
}

function renderCustomerList(
  lines: string[],
  visits: Visit[],
  withOwner = false
) {
  const customers = computeCustomerFrequency(visits);
  if (customers.length === 0) return;

  lines.push("## 客户拜访列表");
  lines.push("");
  lines.push("按访问频率从高到低排序：");
  lines.push("");

  if (withOwner) {
    // 非个人维度：显示客户被哪些人员访问过
    lines.push("| 排名 | 客户 | 访问次数 | 涉及人员 |");
    lines.push("|---|---|---|---|");
    for (let i = 0; i < customers.length; i++) {
      const c = customers[i];
      const owners = [
        ...new Set(
          visits
            .filter(
              (v) =>
                (v.customer_name || v.location_name || "未命名客户") ===
                c.customerName
            )
            .map((v) => v.user_name || "—")
        ),
      ].join("、");
      lines.push(
        `| ${i + 1} | ${c.customerName} | ${c.count} | ${owners} |`
      );
    }
  } else {
    lines.push("| 排名 | 客户 | 访问次数 |");
    lines.push("|---|---|---|");
    for (let i = 0; i < customers.length; i++) {
      const c = customers[i];
      lines.push(`| ${i + 1} | ${c.customerName} | ${c.count} |`);
    }
  }
  lines.push("");
}

function renderDailyItinerary(lines: string[], visits: Visit[], routes: Route[]) {
  if (!visits || visits.length === 0) return;

  const sortedVisits = [...visits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  lines.push("## 拜访轨迹");
  lines.push("");

  for (let i = 0; i < sortedVisits.length; i++) {
    const v = sortedVisits[i];
    lines.push(`### ${i + 1}. ${v.location_name}`);
    lines.push("");
    lines.push(`- **时间：** ${formatTime(v.timestamp)}`);
    lines.push(`- **客户：** ${v.customer_name || "—"}`);
    lines.push(`- **地址：** ${v.address || "—"}`);
    if (v.lat && v.lng) {
      lines.push(`- **坐标：** ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`);
    }
    if (v.reported_distance_km) {
      lines.push(`- **累计里程：** ${v.reported_distance_km} km`);
    }
    if (v.visit_note) {
      lines.push(`- **拜访情况：** ${v.visit_note}`);
    }
    lines.push("");
  }

  if (routes && routes.length > 0) {
    lines.push("### 行驶路段");
    lines.push("");
    lines.push("| 起点 | 终点 | 距离(km) | 时长(分) |");
    lines.push("|---|---|---|---|");
    for (const r of routes) {
      const from = sortedVisits.find((v) => v.id === r.from_visit_id);
      const to = sortedVisits.find((v) => v.id === r.to_visit_id);
      lines.push(
        `| ${from?.location_name || "—"} | ${to?.location_name || "—"} | ${r.distance_km.toFixed(
          1
        )} | ${r.duration_min} |`
      );
    }
    lines.push("");
  }
}

/** 估算里程板块：总里程 + 按时间顺序的停留点列表（仅个人日报） */
function renderMileageStops(
  lines: string[],
  totals: UserOverviewResult["totals"],
  stops: Stop[]
) {
  lines.push("## 估算里程");
  lines.push("");
  lines.push(`总里程：${Math.round(totals.estimated_distance_km)} km`);
  lines.push("");
  if (stops.length > 0) {
    lines.push("停留点（按时间顺序）：");
    lines.push("");
    for (let i = 0; i < stops.length; i++) {
      lines.push(`${i + 1}. ${stops[i].location_name || "未命名地点"}`);
    }
    lines.push("");
  }
}

export function renderConsoleReportMarkdown(input: MarkdownReportInput): string {
  const { userName, start, end, reportType, overview, visits, routes, stops } = input;
  const totals = overview.totals;
  const lines: string[] = [];

  // 标题
  lines.push(`# ${userName} 客户拜访${reportType}`);
  lines.push("");
  lines.push(`**时间范围：** ${start === end ? start : `${start} ~ ${end}`}`);
  lines.push("");
  lines.push(
    `**生成时间：** ${new Date().toLocaleString("zh-CN", { hour12: false })}`
  );
  lines.push("");

  // 是否个人日报（停留点与拜访轨迹板块仅个人日报展示）
  const isPersonalDaily = reportType === "日报" && !!input.userId;

  // 核心指标（客户数、拜访次数、估算里程）
  renderCoreSummary(lines, totals, visits);

  // 客户拜访列表
  if (visits && visits.length > 0) {
    renderCustomerList(lines, visits, !input.userId);
  }

  // 个人日报：估算里程 + 停留点列表
  if (isPersonalDaily && stops) {
    renderMileageStops(lines, totals, stops);
  }

  // AI 拜访总结占位
  lines.push("## 客户拜访总结");
  lines.push("");
  lines.push("（AI 总结能力待接入，后续将由 Kimi 基于拜访情况自动生成）");
  lines.push("");

  // 个人日报：拜访轨迹（拜访明细 + 行驶路段）
  if (isPersonalDaily && visits && visits.length > 0) {
    renderDailyItinerary(lines, visits, routes || []);
  }

  // 系统链接
  lines.push("## 系统链接");
  lines.push("");
  lines.push(`[在系统中查看详情](${buildSystemLink(input)})`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    "_本报告由 销售外勤行为分析系统 自动生成。_"
  );
  lines.push("");

  return lines.join("\n");
}
