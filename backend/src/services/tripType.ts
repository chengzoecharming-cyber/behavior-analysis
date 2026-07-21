/**
 * 判断某次拜访/行程是否需要计算里程。
 *
 * 钉钉原始选项中，只有「拜访客户签到-开车（统计里里程）」属于驾车行程，需要里程与读数。
 * 其余选项（公共交通、陪同拜访、特殊签到、虚拟客户等）只用于记录拜访客户数，不计算里程。
 *
 * 注意：trip_type 为空时默认按驾车处理（兼容早期 Excel 导入等无出行方式的数据）。
 */
export function isMileageRequiredTrip(tripType?: string | null): boolean {
  if (!tripType) return true;
  const t = tripType.trim();
  return t.includes("开车") || t.includes("驾车");
}
