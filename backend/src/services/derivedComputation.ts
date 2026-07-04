import { computeAndPersistRoutes } from "./routeService";
import { persistRiskSummaryCache } from "./riskSummaryService";
import { toBeijingDayStart, toBeijingDayEnd } from "../utils/timezone";

export interface AffectedUserDate {
  user_id: string;
  business_date: string;
}

/**
 * 为新增/更新的拜访记录自动补算衍生数据：
 * 1. 按用户 + 业务日期重新计算路线（routes）
 * 2. 刷新受影响日期的风险摘要缓存（包含异常检测）
 *
 * 通常在 Excel 上传或钉钉同步成功后后台调用，避免用户手动跑脚本。
 */
export async function recomputeDerivedDataForVisits(
  pairs: AffectedUserDate[]
): Promise<void> {
  if (pairs.length === 0) return;

  const uniquePairs = Array.from(
    new Map(pairs.map((p) => [`${p.user_id}|${p.business_date}`, p])).values()
  );
  const affectedDates = new Set<string>();

  for (const { user_id, business_date } of uniquePairs) {
    affectedDates.add(business_date);
    const start = toBeijingDayStart(business_date);
    const end = toBeijingDayEnd(business_date);
    try {
      await computeAndPersistRoutes(user_id, start, end);
    } catch (err) {
      console.warn(
        `[recomputeDerivedDataForVisits] 路线计算失败: ${user_id} @ ${business_date}`,
        err
      );
    }
  }

  for (const date of affectedDates) {
    try {
      await persistRiskSummaryCache(date, { useExistingRoutes: true });
    } catch (err) {
      console.warn(
        `[recomputeDerivedDataForVisits] 风险缓存刷新失败: ${date}`,
        err
      );
    }
  }
}
