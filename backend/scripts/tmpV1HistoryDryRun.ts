/**
 * 临时 dry-run：统计 v1 历史段（2025-11 ~ 2026-05）钉钉审批的字段缺口。
 * 只读：调钉钉 API 拉实例 + 本地解析，不写任何数据库。
 * 用法：cd backend && npx ts-node scripts/tmpV1HistoryDryRun.ts [2025-11-01] [2026-06-01]
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";

import {
  getApprovalInstances,
  getApprovalDetail,
  parseApprovalInstance,
  getDingTalkConfig,
} from "../src/services/dingtalk";

const DAY = 24 * 3600 * 1000;

interface MonthStat {
  instances: number;
  byStatus: Record<string, number>;
  parsedVisits: number;
  noCoord: number;
  noCustomer: number;
  noMileage: number;
  noNote: number;
  zeroVisitApprovals: number;
  tripTypes: Record<string, number>;
}

const stats: Record<string, MonthStat> = {};
const zeroVisitDetails: any[] = [];

function monthKey(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

function statFor(ms: number): MonthStat {
  const k = monthKey(ms);
  if (!stats[k]) {
    stats[k] = {
      instances: 0, byStatus: {}, parsedVisits: 0,
      noCoord: 0, noCustomer: 0, noMileage: 0, noNote: 0,
      zeroVisitApprovals: 0, tripTypes: {},
    };
  }
  return stats[k];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const startDate = process.argv[2] || "2025-11-01";
  const endDate = process.argv[3] || "2026-06-01";
  const cfg = getDingTalkConfig();
  const startMs = new Date(`${startDate}T00:00:00+08:00`).getTime();
  const endMs = new Date(`${endDate}T00:00:00+08:00`).getTime();

  // 1) 分页收集全部实例 ID
  const ids: string[] = [];
  fs.mkdirSync("../tmp/v1-history-cache", { recursive: true });
  for (let w = startMs; w < endMs; w += 30 * DAY) {
    let cursor = 0;
    for (;;) {
      const { list, nextCursor } = await getApprovalInstances(w, Math.min(w + 30 * DAY, endMs), cursor, 20, cfg.processCode);
      ids.push(...list);
      if (!nextCursor || list.length === 0) break;
      cursor = nextCursor;
      await sleep(120);
    }
  }
  console.log(`共拉到 ${ids.length} 张审批单（${startDate} ~ ${endDate}）`);

  // 2) 逐单拉详情 + 解析 + 统计
  let done = 0;
  for (const id of ids) {
    done++;
    if (done % 50 === 0) console.log(`  进度 ${done}/${ids.length}`);
    let detail: any;
    const cachePath = `../tmp/v1-history-cache/${id}.json`;
    try {
      if (fs.existsSync(cachePath)) {
        detail = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      } else {
        detail = await getApprovalDetail(id);
        fs.writeFileSync(cachePath, JSON.stringify(detail));
      }
    } catch (e: any) {
      console.log(`  详情拉取失败 ${id}: ${e?.message}`);
      continue;
    }
    const createMs = Number(detail.create_time ? new Date(detail.create_time).getTime() : NaN);
    const st = statFor(isNaN(createMs) ? startMs : createMs);
    st.instances++;
    const status = detail.status || "UNKNOWN";
    st.byStatus[status] = (st.byStatus[status] || 0) + 1;

    const comps: any[] = detail.form_component_values || [];
    const trip = comps.find((c) => /请选择出行方式/.test((c.name || "").trim()) && (c.value || "").trim() && c.value !== "null")?.value || "(未填)";
    st.tripTypes[trip] = (st.tripTypes[trip] || 0) + 1;

    if (status !== "COMPLETED") continue;

    let visits: any[] = [];
    try {
      visits = await parseApprovalInstance(detail, cfg.processCode);
    } catch (e: any) {
      console.log(`  解析异常 ${id}: ${e?.message}`);
      continue;
    }
    st.parsedVisits += visits.length;
    for (const v of visits) {
      if (v.lat == null || v.lng == null) st.noCoord++;
      if (!v.customer_name || !String(v.customer_name).trim()) st.noCustomer++;
      if (v.reported_distance_km == null) st.noMileage++;
      if (!v.visit_note || !String(v.visit_note).trim()) st.noNote++;
    }
    if (visits.length === 0) {
      st.zeroVisitApprovals++;
      const filled = comps
        .filter((c) => (c.value || "").trim() && c.value !== "null")
        .map((c) => `${(c.name || "").trim()}=${String(c.value).slice(0, 40)}`);
      zeroVisitDetails.push({
        approval_id: id,
        month: monthKey(isNaN(createMs) ? startMs : createMs),
        user: detail.originator_user_name || detail.originator_userid,
        trip,
        filledFields: filled,
      });
    }
    await sleep(80);
  }

  // 3) 输出
  console.log("\n===== 按月统计 =====");
  for (const [m, s] of Object.entries(stats).sort()) {
    console.log(
      `${m} | 单数 ${s.instances} | 状态 ${JSON.stringify(s.byStatus)} | 解析出拜访 ${s.parsedVisits}` +
      ` | 缺坐标 ${s.noCoord} | 缺客户 ${s.noCustomer} | 缺里程 ${s.noMileage} | 缺备注 ${s.noNote}` +
      ` | 0拜访COMPLETED单 ${s.zeroVisitApprovals}`
    );
  }
  console.log("\n===== 出行方式分布 =====");
  const allTrips: Record<string, number> = {};
  for (const s of Object.values(stats)) for (const [t, n] of Object.entries(s.tripTypes)) allTrips[t] = (allTrips[t] || 0) + n;
  for (const [t, n] of Object.entries(allTrips).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${t}`);

  fs.mkdirSync("../tmp", { recursive: true });
  fs.writeFileSync("../tmp/v1-history-zero-visit.json", JSON.stringify(zeroVisitDetails, null, 2));
  console.log(`\n0拜访单明细已写到 tmp/v1-history-zero-visit.json（${zeroVisitDetails.length} 张）`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
