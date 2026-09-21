import dayjs from "dayjs";

/**
 * 业务周期锚点：固定为 2026-06-01 00:00（北京时间）。
 *
 * 与后端 `BUSINESS_WEEK_ANCHOR`（backend/src/utils/businessPeriod.ts）必须保持一致，
 * 改一处就要同步改另一处，否则前端「本周/近两周/近三周」筛选与后端按周统计的区间会错开。
 *
 * 业务周从该日起每 7 天一周连续排下去，不逐年重置。2026-06-01 是周一，
 * 因此业务周恒为「周一 ~ 周日」，与周报所用的自然周在 2026 年内完全重合。
 */
const BUSINESS_WEEK_ANCHOR = dayjs.tz("2026-06-01T00:00:00", "Asia/Shanghai");

export function getBusinessWeekStart(date: dayjs.Dayjs | string | Date): dayjs.Dayjs {
  const d = dayjs.tz(date, "Asia/Shanghai").startOf("day");
  const diffDays = d.diff(BUSINESS_WEEK_ANCHOR, "day");
  const weekIndex = Math.floor(diffDays / 7);
  return BUSINESS_WEEK_ANCHOR.add(weekIndex * 7, "day");
}

export function getBusinessWeekEnd(date: dayjs.Dayjs | string | Date): dayjs.Dayjs {
  return getBusinessWeekStart(date).add(6, "day").endOf("day");
}

export function getCurrentBusinessWeekRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const start = getBusinessWeekStart(d);
  const end = start.add(6, "day").endOf("day");
  return [start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")];
}

export function getPreviousBusinessWeekRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const currentStart = getBusinessWeekStart(d);
  const start = currentStart.subtract(7, "day");
  const end = currentStart.subtract(1, "day").endOf("day");
  return [start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")];
}

export function getPastNBusinessWeeksRange(n: number, date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const currentStart = getBusinessWeekStart(d);
  const start = currentStart.subtract(n * 7, "day");
  const end = currentStart.subtract(1, "day").endOf("day");
  return [start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")];
}

export function getLastMonthRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const lastMonth = d.subtract(1, "month");
  return [lastMonth.startOf("month").format("YYYY-MM-DD"), lastMonth.endOf("month").format("YYYY-MM-DD")];
}

/** 过去 N 个完整自然月（不含本月） */
export function getPastNMonthsRange(n: number, date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const start = d.subtract(n, "month").startOf("month");
  const end = d.subtract(1, "month").endOf("month");
  return [start.format("YYYY-MM-DD"), end.format("YYYY-MM-DD")];
}

export function getCurrentWeekSoFarRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  const d = date ? dayjs.tz(date, "Asia/Shanghai") : dayjs.tz();
  const start = getBusinessWeekStart(d);
  return [start.format("YYYY-MM-DD"), d.format("YYYY-MM-DD")];
}

export function getLastWeekRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  return getPreviousBusinessWeekRange(date);
}

export function getLastTwoWeeksRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  return getPastNBusinessWeeksRange(2, date);
}

export function getLastThreeWeeksRange(date?: dayjs.Dayjs | string | Date): [string, string] {
  return getPastNBusinessWeeksRange(3, date);
}

export function isBusinessWeekEnd(date: dayjs.Dayjs | string | Date): boolean {
  const d = dayjs.tz(date, "Asia/Shanghai");
  return d.day() === 0;
}

export function getBusinessWeekNumber(date?: dayjs.Dayjs | string | Date): number {
  const d = date ? dayjs.tz(date, "Asia/Shanghai").startOf("day") : dayjs.tz().startOf("day");
  const diffDays = d.diff(BUSINESS_WEEK_ANCHOR, "day");
  return Math.floor(diffDays / 7) + 1;
}

export function formatBusinessPeriod(start: string, end: string): string {
  return `${start} ~ ${end}`;
}
