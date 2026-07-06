import { persistRiskSummaryCache } from "./riskSummaryService";
import { isDingTalkConfigured, syncApprovals } from "./dingtalk";
import { getYesterdayBeijing, toBeijingDayStart, toBeijingDayEnd, formatBeijingDate } from "../utils/timezone";
import { pool } from "../db";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function getMillisecondsUntil(hour: number, minute: number): number {
  const now = new Date();
  // 按北京时间计算目标时刻，避免服务器本地时区影响
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingNow.getUTCFullYear();
  const month = pad2(beijingNow.getUTCMonth() + 1);
  const date = pad2(beijingNow.getUTCDate());
  const hourStr = pad2(hour);
  const minuteStr = pad2(minute);

  let target = new Date(`${year}-${month}-${date}T${hourStr}:${minuteStr}:00+08:00`);
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target.getTime() - now.getTime();
}

function dateToStartMs(dateStr: string): number {
  return new Date(toBeijingDayStart(dateStr)).getTime();
}

function dateToEndMs(dateStr: string): number {
  // 23:59:59.999 +08:00
  return new Date(toBeijingDayEnd(dateStr).replace("+08:00", ".999+08:00")).getTime();
}

/** 获取最近 N 天的北京日期字符串数组（不含今天，从昨天往前数） */
function getLastNBeijingDates(n: number): string[] {
  const dates: string[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dates.push(formatBeijingDate(d));
  }
  return dates;
}

/** 检查某个北京日期是否已经被成功同步过 */
async function hasSuccessfulSync(dateStr: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM dingtalk_sync_logs
     WHERE status = 'success'
       AND start_date <= $1
       AND end_date >= $1
     LIMIT 1`,
    [dateStr]
  );
  return result.rows.length > 0;
}

export function startRiskSummaryCacheScheduler(): void {
  const runCacheJob = async () => {
    const yesterday = getYesterdayBeijing();
    console.log(`[Scheduler] Refreshing risk summary cache for ${yesterday}`);
    try {
      await persistRiskSummaryCache(yesterday, { useExistingRoutes: true });
      console.log(`[Scheduler] Risk summary cache refreshed for ${yesterday}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to refresh risk summary cache:`, err);
    }
  };

  // 首次运行：等到凌晨 2 点
  const msUntil2AM = getMillisecondsUntil(2, 0);
  console.log(`[Scheduler] Risk summary cache job will run in ${Math.round(msUntil2AM / 1000 / 60)} minutes`);

  setTimeout(() => {
    runCacheJob();
    // 之后每 24 小时运行一次
    setInterval(runCacheJob, 24 * 60 * 60 * 1000);
  }, msUntil2AM);
}

/** 启动时补齐最近 N 天缺失的钉钉数据 */
export async function catchUpDingTalkSync(windowDays = 7): Promise<void> {
  if (!isDingTalkConfigured()) {
    console.log("[Scheduler] DingTalk catch-up skipped: not configured");
    return;
  }

  // 启动时先把历史遗留的 running 记录标记为失败
  await pool.query(
    `UPDATE dingtalk_sync_logs
     SET status = 'failed',
         error_message = '服务重启，同步任务被中断',
         finished_at = NOW()
     WHERE status = 'running'`
  );

  const dates = getLastNBeijingDates(windowDays);
  console.log(`[Scheduler] Checking last ${windowDays} days for missing sync: ${dates.join(", ")}`);

  for (const dateStr of dates) {
    if (await hasSuccessfulSync(dateStr)) {
      console.log(`[Scheduler] ${dateStr} already synced, skipping`);
      continue;
    }

    console.log(`[Scheduler] Catching up DingTalk approvals for ${dateStr}`);
    try {
      const result = await syncApprovals(dateToStartMs(dateStr), dateToEndMs(dateStr), "startup");
      console.log(
        `[Scheduler] Catch-up completed for ${dateStr}: ${result.totalInstances} instances, ${result.normalizedInserted} visits inserted, ${result.parseFailures} failures`
      );
    } catch (err) {
      console.error(`[Scheduler] Failed to catch up DingTalk approvals for ${dateStr}:`, err);
    }
  }
}

/** 同步最近 N 天（滑动窗口，用于覆盖可能漏掉的日期） */
async function syncLastNDays(n: number): Promise<void> {
  if (!isDingTalkConfigured()) return;

  const dates = getLastNBeijingDates(n);
  const startDate = dates[dates.length - 1];
  const endDate = dates[0];

  console.log(`[Scheduler] Syncing DingTalk approvals for last ${n} days: ${startDate} ~ ${endDate}`);
  try {
    const result = await syncApprovals(dateToStartMs(startDate), dateToEndMs(endDate), "scheduler");
    console.log(
      `[Scheduler] DingTalk sync completed: ${result.totalInstances} instances, ${result.normalizedInserted} visits inserted, ${result.parseFailures} failures`
    );
  } catch (err) {
    console.error(`[Scheduler] Failed to sync DingTalk approvals:`, err);
  }
}

export function startDingTalkSyncScheduler(): void {
  if (!isDingTalkConfigured()) {
    console.log("[Scheduler] DingTalk sync skipped: not configured");
    return;
  }

  // 启动时先补齐最近 7 天缺失的数据
  catchUpDingTalkSync(7).catch((err) => {
    console.error("[Scheduler] Catch-up sync failed:", err);
  });

  const runSyncJob = () => {
    syncLastNDays(3);
  };

  // 首次运行：等到凌晨 2 点 30 分（在风险摘要缓存之后）
  const msUntil230AM = getMillisecondsUntil(2, 30);
  console.log(`[Scheduler] DingTalk sync job will run in ${Math.round(msUntil230AM / 1000 / 60)} minutes`);

  setTimeout(() => {
    runSyncJob();
    // 之后每 24 小时运行一次
    setInterval(runSyncJob, 24 * 60 * 60 * 1000);
  }, msUntil230AM);
}
