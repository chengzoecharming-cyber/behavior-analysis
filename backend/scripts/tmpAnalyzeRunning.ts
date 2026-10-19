/**
 * 临时分析：从本地缓存重解析 RUNNING 状态的 v1 审批单，
 * 验证 ① RUNNING 单能解析出多少有效拜访（含客户名） ② v1 表单里程字段是否齐全。
 * 只读缓存，不调钉钉实例接口。用法：cd backend && npx ts-node scripts/tmpAnalyzeRunning.ts
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";

import { parseApprovalInstance, getDingTalkConfig } from "../src/services/dingtalk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = getDingTalkConfig();
  const files = fs.readdirSync("../tmp/v1-history-cache").filter((f) => f.endsWith(".json"));
  let running = 0, parsedTotal = 0, withCustomer = 0, withMileage = 0, zeroVisit = 0;
  const samples: any[] = [];

  for (const f of files) {
    const detail = JSON.parse(fs.readFileSync(`../tmp/v1-history-cache/${f}`, "utf8"));
    if (detail.status !== "RUNNING") continue;
    running++;
    let visits: any[] = [];
    try {
      visits = await parseApprovalInstance(detail, cfg.processCode);
    } catch (e: any) {
      console.log(`解析异常 ${f}: ${e?.message}`);
      continue;
    }
    if (visits.length === 0) {
      zeroVisit++;
      continue;
    }
    parsedTotal += visits.length;
    for (const v of visits) {
      if (v.customer_name && String(v.customer_name).trim()) withCustomer++;
      if (v.reported_distance_km != null) withMileage++;
    }
    if (samples.length < 5) {
      samples.push({
        id: detail.business_id || f,
        user: detail.originator_user_name,
        create: detail.create_time,
        visits: visits.map((v: any) => ({
          seq: v.sequence, time: v.time, customer: v.customer_name,
          km: v.reported_distance_km, lat: v.lat, lng: v.lng,
        })),
      });
    }
    await sleep(20); // parse 内部可能调通讯录接口，缓一下
  }

  console.log(`\nRUNNING 单共 ${running} 张`);
  console.log(`解析出拜访 ${parsedTotal} 条，其中带客户名 ${withCustomer}，带里程读数 ${withMileage}`);
  console.log(`解析出 0 拜访的 RUNNING 单 ${zeroVisit} 张`);
  console.log("\n样例：");
  console.log(JSON.stringify(samples, null, 2));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
