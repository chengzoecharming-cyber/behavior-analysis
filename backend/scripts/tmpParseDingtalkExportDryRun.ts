/**
 * 钉钉审批后台导出 Excel 解析 dry-run（只读，不写库）。
 * 逐 sheet 解析为 visit 记录，输出统计 + 样本 + 与库中已有数据的重叠对账。
 * 用法：cd backend && npx ts-node scripts/tmpParseDingtalkExportDryRun.ts
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import os from "os";
import path from "path";
import * as XLSX from "xlsx";
import { pool } from "../src/db";

const DIR = path.join(os.homedir(), "Documents/作业/丹弗/地图");

interface ParsedRow {
  approvalId: string;
  user: string;
  userId: string;
  dept: string;
  createTime: string;
  status: string;
  tripType: string;
  stops: { time: string; address: string; customer: string; note: string; km: number | null }[];
}

function parseSheet(ws: XLSX.WorkSheet): ParsedRow[] {
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (aoa.length < 3) return [];
  const header: string[] = aoa[0].map(String);
  const col = (name: string) => header.indexOf(name);

  // 打卡点列对：所有「当前时间」列的位置，紧跟其后应为「当前地点」
  const timeCols: number[] = [];
  header.forEach((h, i) => { if (h === "当前时间") timeCols.push(i); });

  const iApproval = col("审批编号"), iUser = col("发起人姓名"), iUid = col("发起人UserID"),
    iDept = col("发起人部门"), iCreate = col("发起时间"), iStatus = col("审批状态"),
    iTrip = col("请选择出行方式"), iStartKm = col("出发里程读数"), iTotalKm = col("今日累计里程");

  const out: ParsedRow[] = [];
  for (let r = 2; r < aoa.length; r++) {
    const row = aoa[r];
    const approvalId = String(row[iApproval] || "").trim();
    if (!approvalId || approvalId === "审批编号") continue;
    const stops: ParsedRow["stops"] = [];
    timeCols.forEach((tc, seq) => {
      const time = String(row[tc] || "").trim();
      const address = String(row[tc + 1] || "").trim();
      if (!time && !address) return;
      // 客户名向前找（v1 口径：两站之间的客户字段属于即将前往的下一站）；
      // 拜访情况/累计里程向后找（跟在打卡点之后）
      const prevTc = seq > 0 ? timeCols[seq - 1] : -1;
      const nextTc = timeCols[seq + 1] ?? header.length;
      let customer = "", note = "", km: number | null = null;
      for (let i = prevTc + 2; i < tc; i++) {
        if (i < 0) continue;
        const h = header[i], v = String(row[i] || "").trim();
        if (h === "客户" && v && !customer) customer = v;
      }
      // 最后一站：尾部客户列也归它（findBefore 到底）
      if (seq === timeCols.length - 1) {
        for (let i = tc + 2; i < header.length; i++) {
          const h = header[i], v = String(row[i] || "").trim();
          if (h === "客户" && v && !customer) customer = v;
        }
      }
      for (let i = tc + 2; i < nextTc; i++) {
        const h = header[i], v = String(row[i] || "").trim();
        if (!v) continue;
        if (/^本次拜访情况\d*$/.test(h) && !note) note = v;
        else if (/^累计里程\d*$/.test(h) && km == null && !isNaN(parseFloat(v))) km = parseFloat(v);
      }
      stops.push({ time, address, customer, note, km });
    });
    out.push({
      approvalId, user: String(row[iUser] || ""), userId: String(row[iUid] || ""),
      dept: String(row[iDept] || ""), createTime: String(row[iCreate] || ""),
      status: String(row[iStatus] || ""), tripType: String(row[iTrip] || ""),
      stops,
    });
  }
  return out;
}

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$"));
  const all: (ParsedRow & { file: string; sheet: string })[] = [];
  for (const fn of files) {
    const wb = XLSX.readFile(path.join(DIR, fn));
    for (const sn of wb.SheetNames) {
      const rows = parseSheet(wb.Sheets[sn]);
      if (rows.length === 0) continue;
      for (const r of rows) all.push({ ...r, file: fn, sheet: sn });
      console.log(`${fn} / ${sn}: ${rows.length} 张审批单`);
    }
  }

  // 去重（同一审批单可能在多 sheet/多文件出现——按模板版本分 sheet，理论上不重复，仍防一手）
  const seen = new Set<string>();
  const unique = all.filter((r) => (seen.has(r.approvalId) ? false : (seen.add(r.approvalId), true)));
  const dupes = all.length - unique.length;

  const totalStops = unique.reduce((s, r) => s + r.stops.length, 0);
  const withCustomer = unique.reduce((s, r) => s + r.stops.filter((x) => x.customer && !/虚拟|签到用/.test(x.customer)).length, 0);
  const noStops = unique.filter((r) => r.stops.length === 0).length;
  const statuses: Record<string, number> = {};
  unique.forEach((r) => { statuses[r.status] = (statuses[r.status] || 0) + 1; });

  console.log(`\n===== 汇总 =====`);
  console.log(`审批单总数 ${all.length}，去重后 ${unique.length}（重复 ${dupes}）`);
  console.log(`打卡点总数 ${totalStops}，其中带真实客户名 ${withCustomer}`);
  console.log(`0 打卡点的审批单 ${noStops}`);
  console.log(`状态分布:`, statuses);

  // 与库中已有数据重叠对账（2025-10-15 起 API 已导入）
  const ids = unique.map((r) => r.approvalId);
  const existing = await pool.query(`SELECT approval_id FROM visits WHERE approval_id = ANY($1)`, [ids]);
  const existSet = new Set(existing.rows.map((x: any) => x.approval_id));
  const overlap = unique.filter((r) => existSet.has(r.approvalId));
  console.log(`\n与库中已有数据重叠（2025-10-15 起）: ${overlap.length} 张（导入时将跳过）`);

  // 抽样对照：重叠单中抽 3 张，对比解析结果与库里 visits
  for (const r of overlap.slice(0, 3)) {
    const db = await pool.query(
      `SELECT sequence, time, address, customer_name FROM visits WHERE approval_id=$1 ORDER BY sequence`, [r.approvalId]);
    console.log(`\n--- 对照 ${r.approvalId} (${r.user})`);
    console.log("Excel 解析:", r.stops.map((s) => `${s.time}|${s.address}|${s.customer}`));
    console.log("库中记录:", db.rows.map((s: any) => `${s.time}|${s.address}|${s.customer_name}`));
  }

  fs.writeFileSync("../tmp/excel-export-parsed.json", JSON.stringify(unique, null, 2));
  console.log(`\n全量解析结果已存 tmp/excel-export-parsed.json`);
  await pool.end();
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
