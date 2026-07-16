import dayjs from "dayjs";

/**
 * 把后端返回的 ISO 时间字符串（可能带 Z）统一显示为北京时间。
 *
 * 注意：不要直接用 dayjs.tz(isoString)，因为 dayjs.tz 会把字符串里的 wall-clock
 * 时间直接当作目标时区时间，忽略尾部的 Z，导致带 Z 的 UTC 时间少 8 小时。
 * 正确做法是先让 dayjs() 按 UTC 解析，再 .tz("Asia/Shanghai") 转成北京时间。
 */
export function formatBeijingTime(
  value: string | Date | number | null | undefined,
  fmt = "YYYY-MM-DD HH:mm"
): string {
  if (value == null) return "--";
  return dayjs(value).tz("Asia/Shanghai").format(fmt);
}

export function formatBeijingHHmm(
  value: string | Date | number | null | undefined
): string {
  return formatBeijingTime(value, "HH:mm");
}
