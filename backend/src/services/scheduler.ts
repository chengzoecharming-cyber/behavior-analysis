import { persistRiskSummaryCache } from "./riskSummaryService";
import { isDingTalkConfigured, syncApprovals, syncRunningApprovals } from "./dingtalk";
import { getYesterdayBeijing, toBeijingDayStart, toBeijingDayEnd, formatBeijingDate, getBeijingWeekday } from "../utils/timezone";
import { pool } from "../db";
import {
  generateDailyReports,
  generateWeeklyReports,
  generateMonthlyReports,
} from "./reportGenerationService";
import { checkAndSendAlerts, sendDailySyncSummary } from "./syncCheckService";

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

/** 计算距离下一个指定星期几（0=周日）目标时刻的毫秒数 */
function getMillisecondsUntilWeekday(hour: number, minute: number, targetWeekday: number): number {
  const now = new Date();
  const currentWeekday = getBeijingWeekday(now);
  let daysUntil = (targetWeekday - currentWeekday + 7) % 7;

  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingNow.getUTCFullYear();
  const month = pad2(beijingNow.getUTCMonth() + 1);
  const date = pad2(beijingNow.getUTCDate());
  const hourStr = pad2(hour);
  const minuteStr = pad2(minute);
  const todayTarget = new Date(`${year}-${month}-${date}T${hourStr}:${minuteStr}:00+08:00`);

  if (daysUntil === 0 && todayTarget.getTime() <= now.getTime()) {
    daysUntil = 7;
  }

  const base = now.getTime() + daysUntil * 24 * 60 * 60 * 1000;
  const beijingBase = new Date(base + 8 * 60 * 60 * 1000);
  const target = new Date(
    `${beijingBase.getUTCFullYear()}-${pad2(beijingBase.getUTCMonth() + 1)}-${pad2(
      beijingBase.getUTCDate()
    )}T${hourStr}:${minuteStr}:00+08:00`
  );
  return target.getTime() - now.getTime();
}

/** 计算距离下一个指定日期（如每月 30 日）目标时刻的毫秒数；若本月已过则取下个月同日 */
function getMillisecondsUntilDayOfMonth(hour: number, minute: number, targetDay: number): number {
  const now = new Date();
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let year = beijingNow.getUTCFullYear();
  let month = beijingNow.getUTCMonth() + 1;
  let day = beijingNow.getUTCDate();

  let candidate: Date;
  if (day <= targetDay) {
    candidate = new Date(
      `${year}-${pad2(month)}-${pad2(targetDay)}T${pad2(hour)}:${pad2(minute)}:00+08:00`
    );
  } else {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = new Date(
      `${year}-${pad2(month)}-${pad2(targetDay)}T${pad2(hour)}:${pad2(minute)}:00+08:00`
    );
  }
  return candidate.getTime() - now.getTime();
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

    // 同步完成后立即检查并发送告警
    try {
      const alerts = await checkAndSendAlerts();
      if (alerts.length > 0) {
        console.log(`[Scheduler] Sent ${alerts.length} sync alert(s)`);
      }
    } catch (alertErr) {
      console.error("[Scheduler] Failed to send sync alerts:", alertErr);
    }
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

  // 基础同步：每 3 小时同步最近 3 天（8:00, 11:00, 14:00, 17:00, 20:00, 23:00）
  const baseSyncHours = [8, 11, 14, 17, 20, 23];
  for (const hour of baseSyncHours) {
    const scheduleBaseSync = () => {
      const ms = getMillisecondsUntil(hour, 0);
      console.log(
        `[Scheduler] DingTalk base sync will run at ${hour}:00 in ${Math.round(ms / 1000 / 60)} minutes`
      );
      setTimeout(() => {
        syncLastNDays(3);
        scheduleBaseSync();
      }, ms);
    };
    scheduleBaseSync();
  }

  // RUNNING 审批单兜底：每天 12:00、18:00 重新拉取仍在进行中的审批单
  const runningSyncHours = [12, 18];
  for (const hour of runningSyncHours) {
    const scheduleRunningSync = () => {
      const ms = getMillisecondsUntil(hour, 0);
      console.log(
        `[Scheduler] DingTalk running approval sync will run at ${hour}:00 in ${Math.round(ms / 1000 / 60)} minutes`
      );
      setTimeout(async () => {
        try {
          await syncRunningApprovals();
        } catch (err) {
          console.error("[Scheduler] Running approval sync failed:", err);
        }
        scheduleRunningSync();
      }, ms);
    };
    scheduleRunningSync();
  }

  // 同步健康每日摘要：每天早上 9:00 发送昨日摘要
  const scheduleDailySyncSummary = () => {
    const ms = getMillisecondsUntil(9, 0);
    console.log(
      `[Scheduler] Daily sync summary will run at 9:00 in ${Math.round(ms / 1000 / 60)} minutes`
    );
    setTimeout(async () => {
      try {
        await sendDailySyncSummary();
      } catch (err) {
        console.error("[Scheduler] Daily sync summary failed:", err);
      }
      scheduleDailySyncSummary();
    }, ms);
  };
  scheduleDailySyncSummary();
}

function isReportGenerationConfigured(): boolean {
  return !!process.env.DINGTALK_OPERATOR_USERID;
}

/** 检查某类报告在指定周期内是否已有成功生成的日志 */
async function hasSuccessfulReportRun(
  reportType: string,
  periodStart: string,
  periodEnd: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM report_generation_logs
     WHERE report_type = $1
       AND period_start = $2::date
       AND period_end = $3::date
       AND status = 'success'
     LIMIT 1`,
    [reportType, periodStart, periodEnd]
  );
  return result.rows.length > 0;
}

/**
 * 启动补跑：调度方式是 setTimeout 递归，进程重启即丢，
 * 因此启动时检查「昨天的日报 / 本周周报 / 上月月报」是否已有成功日志，缺失则串行补跑。
 * 出错只记日志，不影响服务启动。
 */
export async function catchUpReportGeneration(): Promise<void> {
  if (!isReportGenerationConfigured()) {
    console.log("[Scheduler] Report catch-up skipped: DINGTALK_OPERATOR_USERID not configured");
    return;
  }

  const now = new Date();

  // 1. 昨天的日报（日报每天 9:00 生成昨天）
  try {
    const yesterday = getYesterdayBeijing();
    if (await hasSuccessfulReportRun("daily", yesterday, yesterday)) {
      console.log(`[Scheduler] Daily report for ${yesterday} already generated, skipping`);
    } else {
      console.log(`[Scheduler] Catching up daily report for ${yesterday}`);
      await generateDailyReports(yesterday, "catchup");
    }
  } catch (err) {
    console.error("[Scheduler] Daily report catch-up failed:", err);
  }

  // 2. 本周周报：仅当现在已过本周日 18:00（北京时间）
  try {
    const weekday = getBeijingWeekday(now); // 0=周日
    const mondayOffset = weekday === 0 ? 6 : weekday - 1;
    const weekStart = formatBeijingDate(new Date(now.getTime() - mondayOffset * 24 * 60 * 60 * 1000));
    const weekEnd = formatBeijingDate(new Date(now.getTime() + (6 - mondayOffset) * 24 * 60 * 60 * 1000));
    const sundayTarget = new Date(`${weekEnd}T18:00:00+08:00`);
    if (now.getTime() >= sundayTarget.getTime()) {
      if (await hasSuccessfulReportRun("weekly", weekStart, weekEnd)) {
        console.log(`[Scheduler] Weekly report for ${weekStart} ~ ${weekEnd} already generated, skipping`);
      } else {
        console.log(`[Scheduler] Catching up weekly report for ${weekStart} ~ ${weekEnd}`);
        await generateWeeklyReports(weekStart, weekEnd, "catchup");
      }
    }
  } catch (err) {
    console.error("[Scheduler] Weekly report catch-up failed:", err);
  }

  // 3. 上月月报：仅当现在已过本月 1 日 9:00（北京时间）
  try {
    const beijingToday = formatBeijingDate(now);
    const beijingYear = parseInt(beijingToday.slice(0, 4), 10);
    const beijingMonth = parseInt(beijingToday.slice(5, 7), 10);
    const monthTarget = new Date(`${beijingYear}-${pad2(beijingMonth)}-01T09:00:00+08:00`);
    if (now.getTime() >= monthTarget.getTime()) {
      let targetYear = beijingYear;
      let targetMonth = beijingMonth - 1;
      if (targetMonth === 0) {
        targetYear -= 1;
        targetMonth = 12;
      }
      const monthStart = `${targetYear}-${pad2(targetMonth)}-01`;
      const lastDay = new Date(targetYear, targetMonth, 0).getDate();
      const monthEnd = `${targetYear}-${pad2(targetMonth)}-${lastDay}`;
      if (await hasSuccessfulReportRun("monthly", monthStart, monthEnd)) {
        console.log(`[Scheduler] Monthly report for ${monthStart} ~ ${monthEnd} already generated, skipping`);
      } else {
        console.log(`[Scheduler] Catching up monthly report for ${monthStart} ~ ${monthEnd}`);
        await generateMonthlyReports(targetYear, targetMonth, "catchup");
      }
    }
  } catch (err) {
    console.error("[Scheduler] Monthly report catch-up failed:", err);
  }
}

/** 报告生成调度：日报 9:00（发昨天）、周报周日 18:00（发本周）、月报每月 1 日 9:00（发上月，北京时间） */
export function startReportGenerationScheduler(): void {
  if (!isReportGenerationConfigured()) {
    console.log("[Scheduler] Report generation skipped: DINGTALK_OPERATOR_USERID not configured");
    return;
  }

  // 日报：每天 9:00 生成昨天的日报
  const scheduleDaily = () => {
    const ms = getMillisecondsUntil(9, 0);
    console.log(`[Scheduler] Daily report generation will run in ${Math.round(ms / 1000 / 60)} minutes`);
    setTimeout(async () => {
      console.log("[Scheduler] Running daily report generation");
      try {
        await generateDailyReports();
      } catch (err) {
        console.error("[Scheduler] Daily report generation failed:", err);
      }
      scheduleDaily();
    }, ms);
  };

  // 周报
  const scheduleWeekly = () => {
    const ms = getMillisecondsUntilWeekday(18, 0, 0);
    console.log(`[Scheduler] Weekly report generation will run in ${Math.round(ms / 1000 / 60)} minutes`);
    setTimeout(async () => {
      console.log("[Scheduler] Running weekly report generation");
      try {
        await generateWeeklyReports();
      } catch (err) {
        console.error("[Scheduler] Weekly report generation failed:", err);
      }
      scheduleWeekly();
    }, ms);
  };

  // 月报：每月 1 日 9:00 生成上月整月的月报
  const scheduleMonthly = () => {
    const ms = getMillisecondsUntilDayOfMonth(9, 0, 1);
    console.log(`[Scheduler] Monthly report generation will run in ${Math.round(ms / 1000 / 60)} minutes`);
    setTimeout(async () => {
      console.log("[Scheduler] Running monthly report generation");
      try {
        await generateMonthlyReports();
      } catch (err) {
        console.error("[Scheduler] Monthly report generation failed:", err);
      }
      scheduleMonthly();
    }, ms);
  };

  scheduleDaily();
  scheduleWeekly();
  scheduleMonthly();

  // 启动时补跑缺失的报告（昨天的日报 / 本周周报 / 上月月报），串行执行、出错不影响启动
  catchUpReportGeneration().catch((err) => {
    console.error("[Scheduler] Report catch-up failed:", err);
  });
}
