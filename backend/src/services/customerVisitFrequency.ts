import { Visit } from "../types";
import {
  splitRealCustomerNames,
  normalizeCustomerName,
} from "./normalization";
import { formatBeijingDate } from "../utils/timezone";
import { getBusinessWeekStart } from "../utils/businessPeriod";

// 同客户高频拜访关注口径（仅展示，不落 anomalies、不计风险分）：
// 单个业务周内同一员工拜访同一客户超过 2 次，或单个自然月内超过 3 次，任一命中即 flagged。
export const FREQ_WEEK_THRESHOLD = 2;
export const FREQ_MONTH_THRESHOLD = 3;

// 高频拜访关注的客户名排除关键词（归一化后按包含匹配）：
// 公司自身名称/内部昵称被销售写进客户字段时，不算客户拜访。
// 公司地址白名单（company_addresses.name）由调用方经 excludedNames 传入，与这里的关键词合并生效。
export const EXCLUDED_CUSTOMER_NAME_KEYWORDS = ["丹弗科技", "小胖峰"];

export interface CustomerFreqItem {
  userId: string;
  userName: string;
  department: string | null;
  customerName: string;
  totalCount: number;
  maxWeekCount: number;
  maxMonthCount: number;
  flagged: boolean;
  flagReasons: string[]; // 如 ["2026-08-03 ~ 2026-08-09（4次）", "2026-08 月（7次）"]
}

/** 取拜访的业务日期（YYYY-MM-DD），business_date 缺失时回退按签到时间的北京时间日期 */
function visitBusinessDate(v: Visit): string {
  const raw: any = v.business_date;
  if (raw instanceof Date) return formatBeijingDate(raw);
  if (typeof raw === "string" && raw) return raw.slice(0, 10);
  return formatBeijingDate(new Date(v.timestamp));
}

/**
 * 统计「同一员工 × 同一客户」在时间段内的拜访频次。
 * visits 为已按 NOT exclude_from_visit_count 过滤的行；excludedIds 中
 * form_version !== 'v2' 的行（命中跨员工住址/公司地址）跳过。
 * excludedNames 传入公司相关名称（如 company_addresses.name），与内置
 * EXCLUDED_CUSTOMER_NAME_KEYWORDS 合并，归一化后按包含匹配剔除。
 */
export function computeCustomerVisitFrequency(
  visits: Visit[],
  excludedIds?: Set<number>,
  excludedNames?: string[]
): CustomerFreqItem[] {
  const nameKeywords = [
    ...EXCLUDED_CUSTOMER_NAME_KEYWORDS,
    ...(excludedNames || []).map((n) => normalizeCustomerName(n)),
  ].filter(Boolean);
  const isExcludedName = (raw: string) => {
    const norm = normalizeCustomerName(raw);
    return nameKeywords.some((k) => norm.includes(k));
  };
  interface GroupAcc {
    userId: string;
    userName: string;
    department: string | null;
    // 归一化客户名 → 原始名出现次数（展示名取最多的原始名）
    nameCounts: Map<string, number>;
    weekCounts: Map<string, number>;
    monthCounts: Map<string, number>;
    totalCount: number;
  }

  const groups = new Map<string, GroupAcc>();

  for (const v of visits) {
    if (excludedIds && v.form_version !== "v2" && excludedIds.has(v.id)) continue;

    for (const rawName of splitRealCustomerNames(v.customer_name)) {
      if (isExcludedName(rawName)) continue;
      const normalized = normalizeCustomerName(rawName);
      if (!normalized) continue;
      const key = v.user_id + " " + normalized;
      let g = groups.get(key);
      if (!g) {
        g = {
          userId: v.user_id,
          userName: v.user_name || v.user_id,
          department: v.department ?? null,
          nameCounts: new Map(),
          weekCounts: new Map(),
          monthCounts: new Map(),
          totalCount: 0,
        };
        groups.set(key, g);
      }
      const date = visitBusinessDate(v);
      const weekKey = formatBeijingDate(getBusinessWeekStart(date));
      const monthKey = date.slice(0, 7);
      g.nameCounts.set(rawName, (g.nameCounts.get(rawName) || 0) + 1);
      g.weekCounts.set(weekKey, (g.weekCounts.get(weekKey) || 0) + 1);
      g.monthCounts.set(monthKey, (g.monthCounts.get(monthKey) || 0) + 1);
      g.totalCount += 1;
    }
  }

  const items: CustomerFreqItem[] = [];
  for (const g of groups.values()) {
    let maxWeekCount = 0;
    let maxWeekKey = "";
    for (const [week, count] of g.weekCounts) {
      if (count > maxWeekCount) {
        maxWeekCount = count;
        maxWeekKey = week;
      }
    }
    let maxMonthCount = 0;
    let maxMonthKey = "";
    for (const [month, count] of g.monthCounts) {
      if (count > maxMonthCount) {
        maxMonthCount = count;
        maxMonthKey = month;
      }
    }

    const flagReasons: string[] = [];
    if (maxWeekCount > FREQ_WEEK_THRESHOLD) {
      // 展示为日期范围（周阈值仅作内部判定准则，不露出「单周」字样）
      const weekEnd = formatBeijingDate(
        new Date(getBusinessWeekStart(maxWeekKey).getTime() + 6 * 24 * 60 * 60 * 1000)
      );
      flagReasons.push(`${maxWeekKey} ~ ${weekEnd}（${maxWeekCount}次）`);
    }
    if (maxMonthCount > FREQ_MONTH_THRESHOLD) {
      flagReasons.push(`${maxMonthKey} 月（${maxMonthCount}次）`);
    }

    // 展示名：组内出现次数最多的原始名
    let customerName = "";
    let best = 0;
    for (const [name, count] of g.nameCounts) {
      if (count > best) {
        best = count;
        customerName = name;
      }
    }

    items.push({
      userId: g.userId,
      userName: g.userName,
      department: g.department,
      customerName,
      totalCount: g.totalCount,
      maxWeekCount,
      maxMonthCount,
      flagged: flagReasons.length > 0,
      flagReasons,
    });
  }

  // flagged 优先，再按 单月峰值 → 单周峰值 → 期内总数 降序
  items.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    return (
      b.maxMonthCount - a.maxMonthCount ||
      b.maxWeekCount - a.maxWeekCount ||
      b.totalCount - a.totalCount
    );
  });
  return items;
}
