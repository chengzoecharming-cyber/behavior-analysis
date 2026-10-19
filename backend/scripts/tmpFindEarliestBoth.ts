/**
 * 临时脚本：分别查 v1/v2 审批表单在 listids 可查范围内的最早实例。
 * 用法：cd backend && npx ts-node scripts/tmpFindEarliestBoth.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { getApprovalInstances, getApprovalDetail, getDingTalkConfig } from "../src/services/dingtalk";

const DAY = 24 * 3600 * 1000;

async function earliestFor(processCode: string, label: string) {
  const now = Date.now();
  let lo = 30; // 距今 30 天必然可行
  let hi = 400; // 预期不可行，逐步逼近
  try {
    await getApprovalInstances(now - hi * DAY, now - (hi - 30) * DAY, 0, 20, processCode);
    console.log(`${label}: hi=${hi} 天仍可行，listids 窗口至少 400 天`);
    lo = hi;
  } catch {
    /* 预期失败 */
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await getApprovalInstances(now - mid * DAY, now - (mid - 30) * DAY, 0, 20, processCode);
      lo = mid;
    } catch {
      hi = mid;
    }
  }
  const windowStart = new Date(now - lo * DAY).toISOString().slice(0, 10);
  console.log(`${label}: listids 最早可查 start_time ≈ 距今 ${lo} 天（${windowStart}）`);

  // 从可查起点起，分页找第一张实例
  let cursor = 0;
  for (let hop = 0; hop < 40; hop++) {
    const start = now - lo * DAY + hop * 30 * DAY;
    if (start > now) break;
    const { list } = await getApprovalInstances(start, Math.min(start + 30 * DAY, now), 0, 20, processCode);
    if (list.length > 0) {
      const detail = await getApprovalDetail(list[0]);
      console.log(`${label}: 最早实例 ${list[0]}`);
      console.log(`${label}:   创建时间 ${detail.create_time}  状态 ${detail.status}  标题 ${detail.title}`);
      return;
    }
    cursor++;
  }
  console.log(`${label}: 可查范围内没有任何实例`);
}

async function main() {
  const cfg = getDingTalkConfig();
  await earliestFor(cfg.processCode, "v1");
  if (cfg.processCodeV2) await earliestFor(cfg.processCodeV2, "v2");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
