import dayjs from "dayjs";

const ANCHOR_MONTH = 6;
const ANCHOR_DAY = 1;

function getAnchorDate(year: number): dayjs.Dayjs {
  return dayjs.tz(`${year}-${String(ANCHOR_MONTH).padStart(2, "0")}-${String(ANCHOR_DAY).padStart(2, "0")}T00:00:00`, "Asia/Shanghai");
}

export function getBusinessWeekStart(date: dayjs.Dayjs | string | Date): dayjs.Dayjs {
  const d = dayjs.tz(date, "Asia/Shanghai").startOf("day");
  const year = d.year();
  const anchor = getAnchorDate(year);
  const diffDays = d.diff(anchor, "day");
  const weekIndex = Math.floor(diffDays / 7);
  return anchor.add(weekIndex * 7, "day");
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
  const year = d.year();
  const anchor = getAnchorDate(year);
  const diffDays = d.diff(anchor, "day");
  return Math.floor(diffDays / 7) + 1;
}

export function formatBusinessPeriod(start: string, end: string): string {
  return `${start} ~ ${end}`;
}
