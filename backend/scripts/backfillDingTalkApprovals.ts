import { syncApprovals } from "../src/services/dingtalk";
import { parseDateTimeAsBeijing, formatBeijingDate } from "../src/utils/timezone";

/**
 * 一次性补全脚本：同步指定日期范围内的所有钉钉审批数据。
 *
 * 适用场景：
 * - 上线新同步策略后，需要把历史上漏掉的 RUNNING 审批单数据补全
 * - 服务器上重新部署后，需要把服务器数据库中的数据补齐到和钉钉一致
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/backfillDingTalkApprovals.ts 2026-06-01 2026-07-20
 *
 * 默认同步最近 30 天（如果未传参数）。
 */
async function main() {
  const args = process.argv.slice(2);
  let startDate: string;
  let endDate: string;

  if (args.length >= 2) {
    startDate = args[0];
    endDate = args[1];
  } else {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    endDate = formatBeijingDate(end);
    startDate = formatBeijingDate(start);
    console.log(`[backfill] 未指定日期范围，默认同步最近 30 天: ${startDate} ~ ${endDate}`);
  }

  const start = parseDateTimeAsBeijing(`${startDate} 00:00:00`);
  const end = parseDateTimeAsBeijing(`${endDate} 23:59:59.999`);

  console.log(`[backfill] 开始同步 ${startDate} ~ ${endDate} 的钉钉审批数据`);
  const result = await syncApprovals(start.getTime(), end.getTime(), "manual");
  console.log("[backfill] 同步完成:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[backfill] 同步失败:", err);
  process.exit(1);
});
