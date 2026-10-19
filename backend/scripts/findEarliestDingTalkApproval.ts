/**
 * 临时脚本：查钉钉审批表单最早一条实例的时间。
 * listids 对 start_time 有「最早距今 N 天」限制，先二分边界，
 * 再在允许的最早窗口取第一页第一条（按创建时间升序），拉详情。
 * 用法：cd backend && npx ts-node scripts/findEarliestDingTalkApproval.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { getApprovalInstances, getApprovalDetail } from "../src/services/dingtalk";

const DAY = 24 * 3600 * 1000;

async function tryRange(startMs: number, endMs: number): Promise<string[]> {
  const { list } = await getApprovalInstances(startMs, endMs, 0, 20);
  return list;
}

async function main() {
  const now = Date.now();

  // 二分查找允许的最早 start_time（距今 lo~hi 天之间）
  let lo = 340; // 已知可行（2025-08-03 ≈ 距今360天? 留点余量逐步确认）
  let hi = 400; // 已知不可行
  // 先确认 lo 可行、hi 不可行
  try {
    await tryRange(now - lo * DAY, now - (lo - 30) * DAY);
  } catch {
    console.log(`lo=${lo} 天不可行，缩小范围`);
    lo = 300;
    await tryRange(now - lo * DAY, now - (lo - 30) * DAY);
  }
  try {
    await tryRange(now - hi * DAY, now - (hi - 30) * DAY);
    console.log(`hi=${hi} 天竟然可行，继续加大`);
    hi = 500;
  } catch {
    /* 预期失败 */
  }

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await tryRange(now - mid * DAY, now - (mid - 30) * DAY);
      lo = mid;
    } catch {
      hi = mid;
    }
  }
  console.log(`listids 最早可查 start_time ≈ 距今 ${lo} 天（${new Date(now - lo * DAY).toISOString().slice(0, 10)}）`);

  // 用精确毫秒边界再试一次：用 now - lo 天作为 start，拉到当前，取第一页第一条
  // 注意 listids 按实例创建时间升序返回，第一页第一条即全表最早实例（在可查范围内）
  const start = now - (lo - 1) * DAY;
  const ids = await tryRange(start, start + 30 * DAY);
  if (ids.length === 0) {
    console.log("边界窗口无数据");
    return;
  }
  const firstId = ids[0];
  const detail = await getApprovalDetail(firstId);
  console.log("可查范围内最早实例 ID:", firstId);
  console.log("创建时间:", detail.create_time);
  console.log("发起人:", detail.originator_userid, detail.originator_dept_name);
  console.log("标题:", detail.title);
  console.log("状态:", detail.status, "结果:", detail.result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
