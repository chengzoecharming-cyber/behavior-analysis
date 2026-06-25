import { persistRiskSummaryCache } from "./riskSummaryService";

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
