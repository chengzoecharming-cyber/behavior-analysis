import { persistRiskSummaryCache } from "./riskSummaryService";
import { isDingTalkConfigured, syncApprovals } from "./dingtalk";

function getMillisecondsUntil(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function getYesterdayDateStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function dateToMs(dateStr: string): number {
  return new Date(dateStr + "T00:00:00+08:00").getTime();
}

export function startRiskSummaryCacheScheduler(): void {
  const runCacheJob = async () => {
    const yesterday = getYesterdayDateStr();
    console.log(`[Scheduler] Refreshing risk summary cache for ${yesterday}`);
    try {
      await persistRiskSummaryCache(yesterday);
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

export function startDingTalkSyncScheduler(): void {
  if (!isDingTalkConfigured()) {
    console.log("[Scheduler] DingTalk sync skipped: not configured");
    return;
  }

  const runSyncJob = async () => {
    const yesterday = getYesterdayDateStr();
    console.log(`[Scheduler] Syncing DingTalk approvals for ${yesterday}`);
    try {
      const result = await syncApprovals(dateToMs(yesterday), dateToMs(yesterday));
      console.log(
        `[Scheduler] DingTalk sync completed: ${result.totalInstances} instances, ${result.normalizedInserted} visits inserted, ${result.parseFailures} failures`
      );
    } catch (err) {
      console.error(`[Scheduler] Failed to sync DingTalk approvals:`, err);
    }
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
