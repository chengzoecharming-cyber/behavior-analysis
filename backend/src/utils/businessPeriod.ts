import {
  parseDateTimeAsBeijing,
  formatBeijingDate,
} from "./timezone";

const ANCHOR_MONTH = 6;
const ANCHOR_DAY = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 获取指定日期所在年份的业务周期锚点（6 月 1 日 00:00 +08:00）。
 */
export function getAnchorDate(year: number): Date {
  return parseDateTimeAsBeijing(`${year}-${String(ANCHOR_MONTH).padStart(2, "0")}-${String(ANCHOR_DAY).padStart(2, "0")}`);
}

function toDateInput(date: Date | string): Date {
  return date instanceof Date ? date : parseDateTimeAsBeijing(date);
}

/**
 * 计算指定日期所属业务周的起始日期。
 * 业务周以每年 6 月 1 日为起点，每 7 天一周。
 * 6 月 1 日之前为负周序号。
 */
export function getBusinessWeekStart(date: Date | string): Date {
  const d = toDateInput(date);
  const year = parseInt(formatBeijingDate(d).slice(0, 4), 10);
  const anchor = getAnchorDate(year);

  const diffDays = Math.floor((d.getTime() - anchor.getTime()) / DAY_MS);
  const weekIndex = Math.floor(diffDays / 7);
  const weekStart = new Date(anchor.getTime() + weekIndex * 7 * DAY_MS);

  return weekStart;
}

/**
 * 计算指定日期所属业务周的结束日期（第 7 天 23:59:59.999 +08:00）。
 */
export function getBusinessWeekEnd(date: Date | string): Date {
  const start = getBusinessWeekStart(date);
  return new Date(start.getTime() + 6 * DAY_MS + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999);
}

/**
 * 获取指定日期所属业务周的范围 [start, end]。
 */
export function getCurrentBusinessWeekRange(
  date: Date | string
): { start: Date; end: Date } {
  return {
    start: getBusinessWeekStart(date),
    end: getBusinessWeekEnd(date),
  };
}

/**
 * 获取指定日期上一完整业务周的范围 [start, end]。
 */
export function getPreviousBusinessWeekRange(
  date: Date | string
): { start: Date; end: Date } {
  const currentStart = getBusinessWeekStart(date);
  const previousStart = new Date(currentStart.getTime() - 7 * DAY_MS);
  const previousEnd = new Date(currentStart.getTime() - 1);
  return { start: previousStart, end: previousEnd };
}

/**
 * 判断指定日期是否为业务周的最后一天。
 * 即：明天会进入新的业务周。
 */
export function isBusinessWeekEnd(date: Date | string): boolean {
  const d = toDateInput(date);
  const nextDay = new Date(d.getTime() + DAY_MS);
  return getBusinessWeekStart(nextDay).getTime() > getBusinessWeekStart(d).getTime();
}

/**
 * 获取业务周序号（从 6 月 1 日开始为第 1 周）。
 * 6 月 1 日之前返回 0 或负数。
 */
export function getBusinessWeekNumber(date: Date | string): number {
  const d = toDateInput(date);
  const year = parseInt(formatBeijingDate(d).slice(0, 4), 10);
  const anchor = getAnchorDate(year);
  const diffDays = Math.floor((d.getTime() - anchor.getTime()) / DAY_MS);
  return Math.floor(diffDays / 7) + 1;
}

/**
 * 生成日期范围的字符串（YYYY-MM-DD ~ YYYY-MM-DD），用于异常文案。
 */
export function formatBusinessPeriod(
  start: Date | string,
  end: Date | string
): string {
  const s = start instanceof Date ? start : parseDateTimeAsBeijing(start);
  const e = end instanceof Date ? end : parseDateTimeAsBeijing(end);
  return `${formatBeijingDate(s)} ~ ${formatBeijingDate(e)}`;
}

/**
 * 获取指定日期所在业务周起点到当前日（含）的范围。
 * 用于重复签到实时计算。
 */
export function getBusinessWeekSoFarRange(
  date: Date | string
): { start: Date; end: Date } {
  const start = getBusinessWeekStart(date);
  const d = toDateInput(date);
  const end = new Date(d.getTime() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999);
  return { start, end };
}

/**
 * 获取「过去 N 个完整业务周」的范围，截止到指定日期的上一个业务周结束。
 */
export function getPastNBusinessWeeksRange(
  n: number,
  date: Date | string
): { start: Date; end: Date } {
  const currentStart = getBusinessWeekStart(date);
  const end = new Date(currentStart.getTime() - 1);
  const start = new Date(currentStart.getTime() - n * 7 * DAY_MS);
  return { start, end };
}

/**
 * 获取「上月」自然月范围。
 */
export function getLastMonthRange(
  date: Date | string
): { start: Date; end: Date } {
  const d = toDateInput(date);
  const year = parseInt(formatBeijingDate(d).slice(0, 4), 10);
  const month = parseInt(formatBeijingDate(d).slice(5, 7), 10);
  let lastYear = year;
  let lastMonth = month - 1;
  if (lastMonth === 0) {
    lastYear = year - 1;
    lastMonth = 12;
  }
  const start = parseDateTimeAsBeijing(`${lastYear}-${String(lastMonth).padStart(2, "0")}-01`);
  // 获取下月1日的前一天
  const nextMonth = lastMonth === 12 ? 1 : lastMonth + 1;
  const nextYear = lastMonth === 12 ? lastYear + 1 : lastYear;
  const nextMonthStart = parseDateTimeAsBeijing(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`);
  const end = new Date(nextMonthStart.getTime() - 1);
  return { start, end };
}

/**
 * 获取「本周」业务周范围（周一到当前日）。
 */
export function getCurrentWeekSoFarRange(
  date: Date | string
): { start: Date; end: Date } {
  return getBusinessWeekSoFarRange(date);
}

/**
 * 获取「上周」完整业务周范围。
 */
export function getLastWeekRange(
  date: Date | string
): { start: Date; end: Date } {
  return getPreviousBusinessWeekRange(date);
}

/**
 * 获取「过去两周」完整业务周范围。
 */
export function getLastTwoWeeksRange(
  date: Date | string
): { start: Date; end: Date } {
  return getPastNBusinessWeeksRange(2, date);
}

/**
 * 获取「过去三周」完整业务周范围。
 */
export function getLastThreeWeeksRange(
  date: Date | string
): { start: Date; end: Date } {
  return getPastNBusinessWeeksRange(3, date);
}

/**
 * 获取指定日期所在年份的自然月范围。
 */
export function getMonthRange(
  year: number,
  month: number
): { start: Date; end: Date } {
  const start = parseDateTimeAsBeijing(`${year}-${String(month).padStart(2, "0")}-01`);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthStart = parseDateTimeAsBeijing(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01`);
  const end = new Date(nextMonthStart.getTime() - 1);
  return { start, end };
}
