import {
  parseDateTimeAsBeijing,
  formatBeijingDate,
} from "./timezone";

/**
 * 业务周期锚点：固定为 2026-06-01 00:00（北京时间）。
 *
 * 业务周从该日起每 7 天一周连续排下去，不逐年重置。2026-06-01 是周一，
 * 因此业务周恒为「周一 ~ 周日」，2026 年内与周报所用的自然周完全重合。
 *
 * 不要改成「取日期所在年份的 6 月 1 日」：那样每年 6/1 会重新起算，而 6/1 的星期
 * 逐年漂移（2027-06-01 是周二），周边界会漂成周二~周一，跨年处还会出现重叠周
 * （2026-12-28 起的一周与 2026-12-29 起的一周重叠 5 天），且周序号每年重置、跨年出现负数。
 */
export const BUSINESS_WEEK_ANCHOR = parseDateTimeAsBeijing("2026-06-01");

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateInput(date: Date | string): Date {
  return date instanceof Date ? date : parseDateTimeAsBeijing(date);
}

/**
 * 计算指定日期所属业务周的起始日期。
 * 业务周以固定锚点 2026-06-01 为起点，每 7 天一周连续排下去。
 * 2026-06-01 之前为负周序号（该区间无业务数据，暂不处理）。
 */
export function getBusinessWeekStart(date: Date | string): Date {
  const d = toDateInput(date);

  const diffDays = Math.floor((d.getTime() - BUSINESS_WEEK_ANCHOR.getTime()) / DAY_MS);
  const weekIndex = Math.floor(diffDays / 7);
  const weekStart = new Date(BUSINESS_WEEK_ANCHOR.getTime() + weekIndex * 7 * DAY_MS);

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
 * 获取业务周序号：从固定锚点 2026-06-01 起为第 1 周，此后连续递增，不逐年重置。
 * 2026-06-01 之前返回 0 或负数（该区间无业务数据，暂不处理）。
 */
export function getBusinessWeekNumber(date: Date | string): number {
  const d = toDateInput(date);
  const diffDays = Math.floor((d.getTime() - BUSINESS_WEEK_ANCHOR.getTime()) / DAY_MS);
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
