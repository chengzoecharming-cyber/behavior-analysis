// 统一使用北京时间（Asia/Shanghai，UTC+8，无夏令时）处理业务日期。
// 所有从客户端传入的日期/时间字符串（无显式时区）都按北京时间解析；
// 数据库存储统一为 UTC 的 TIMESTAMPTZ。

const TZ_OFFSET = "+08:00";

function hasTimezone(s: string): boolean {
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(s);
}

/**
 * 把客户端传入的时间戳字符串补成北京时间 ISO 字符串。
 * - 已带时区：原样返回
 * - 仅日期 YYYY-MM-DD：补 00:00:00+08:00
 * - 日期时间：补 +08:00
 */
export function ensureBeijingTimestamp(s: string): string {
  if (hasTimezone(s)) return s;
  const hasTime = /T\d{2}:\d{2}:\d{2}/.test(s);
  if (hasTime) return `${s}${TZ_OFFSET}`;
  return `${s}T00:00:00${TZ_OFFSET}`;
}

/** 获取某北京日期 00:00:00+08:00 的 ISO 字符串 */
export function toBeijingDayStart(dateStr: string): string {
  const datePart = dateStr.slice(0, 10);
  return `${datePart}T00:00:00${TZ_OFFSET}`;
}

/** 获取某北京日期 23:59:59+08:00 的 ISO 字符串 */
export function toBeijingDayEnd(dateStr: string): string {
  const datePart = dateStr.slice(0, 10);
  return `${datePart}T23:59:59${TZ_OFFSET}`;
}

/** 把 [startStr, endStr]（北京日期）转成当天起止的 ISO 范围 */
export function toBeijingRange(
  startStr: string,
  endStr: string
): { start: string; end: string } {
  return {
    start: toBeijingDayStart(startStr),
    end: toBeijingDayEnd(endStr),
  };
}

/**
 * 解析日期时间为 UTC Date。
 * - Date 实例：直接返回
 * - 纯数字：按毫秒时间戳（UTC）处理
 * - 带时区：按该时区解析
 * - 无显式时区：按北京时间解析
 */
export function parseDateTimeAsBeijing(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);

  const s = String(value).trim();
  if (!s) return new Date(NaN);

  // 纯数字毫秒时间戳（字符串形式）
  if (/^\d+$/.test(s)) return new Date(parseInt(s, 10));

  // 已带时区
  if (hasTimezone(s)) return new Date(s);

  // 仅日期
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00${TZ_OFFSET}`);
  }

  // 日期时间无显式时区：按北京时间
  const normalized = s.replace(" ", "T");
  return new Date(`${normalized}${TZ_OFFSET}`);
}

/** 把 Date 格式化为北京日期的 YYYY-MM-DD */
export function formatBeijingDate(d: Date): string {
  // Beijing 无夏令时，固定 UTC+8
  return new Date(d.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
}

/** 按北京时间获取 Date 对应的星期几（0=周日，6=周六） */
export function getBeijingWeekday(date: Date): number {
  // 将 UTC 时间戳转换为北京时间对应的本地时间表示
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.getUTCDay();
}

/** 获取“昨天”的北京日期字符串 */
export function getYesterdayBeijing(): string {
  const yesterdayUtc = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return formatBeijingDate(yesterdayUtc);
}
