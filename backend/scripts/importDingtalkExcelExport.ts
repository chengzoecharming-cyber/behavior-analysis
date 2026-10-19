/**
 * 钉钉审批后台导出 Excel 历史导入（2024-09 ~ 2025-10，API 365 天盲区补录）。
 *
 * 用法（cd backend）：
 *   npx ts-node scripts/importDingtalkExcelExport.ts --dry            # 只解析+统计，不写库不调高德
 *   npx ts-node scripts/importDingtalkExcelExport.ts --geocode 4000   # 只做地理编码（限 N 次调用），结果落缓存
 *   npx ts-node scripts/importDingtalkExcelExport.ts --import         # 用缓存坐标入库（幂等，可重跑）
 *
 * 设计要点：
 * - 审批编号 = 钉钉 approval_id，processParsedVisits 的防重链路与 API 数据共用，重叠自动跳过；
 * - source 传 "dingtalk" 以复用「审批单级归日」口径；source_detail='excel-export' 标记真实来源；
 * - 「已撤销」不入库；「审批中」按 RUNNING 入库；「已修改」按 COMPLETED 入库；
 * - 客户名向前挂（v1 口径：两站之间填的客户属于下一站），已通过 289 张重叠单逐字段验证。
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import os from "os";
import path from "path";
import * as XLSX from "xlsx";
import { pool } from "../src/db";
import { processParsedVisits } from "../src/services/normalization";
import { geocodeAddressWithSimplification } from "../src/services/geocoding";
import type { ParsedVisit } from "../src/types";

const DIR = process.env.EXCEL_EXPORT_DIR || path.join(os.homedir(), "Documents/作业/丹弗/地图");
const CACHE = path.resolve(__dirname, "../../tmp/geocode-cache.json");

interface ExcelStop {
  time: string;
  address: string;
  customer: string;
  note: string;
  km: number | null;
  endKm: number | null;
}

interface ExcelApproval {
  approvalId: string;
  user: string;
  userId: string;
  dept: string;
  createTime: string;
  status: string;
  tripType: string;
  vehicle: string;
  startKm: number | null;
  stops: ExcelStop[];
}

function parseSheet(ws: XLSX.WorkSheet): ExcelApproval[] {
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  if (aoa.length < 3) return [];
  const header: string[] = aoa[0].map(String);
  const col = (name: string) => header.indexOf(name);
  const timeCols: number[] = [];
  header.forEach((h, i) => { if (h === "当前时间") timeCols.push(i); });

  const iApproval = col("审批编号"), iUser = col("发起人姓名"), iUid = col("发起人UserID"),
    iDept = col("发起人部门"), iCreate = col("发起时间"), iStatus = col("审批状态"),
    iTrip = col("请选择出行方式"), iVehicle = col("选择出行车辆"), iStartKm = col("出发里程读数");

  const out: ExcelApproval[] = [];
  for (let r = 2; r < aoa.length; r++) {
    const row = aoa[r];
    const approvalId = String(row[iApproval] || "").trim();
    if (!approvalId || approvalId === "审批编号") continue;
    const stops: ExcelStop[] = [];
    timeCols.forEach((tc, seq) => {
      const time = String(row[tc] || "").trim();
      const address = String(row[tc + 1] || "").trim();
      if (!time && !address) return;
      const prevTc = seq > 0 ? timeCols[seq - 1] : -1;
      const nextTc = timeCols[seq + 1] ?? header.length;
      let customer = "", note = "", km: number | null = null, endKm: number | null = null;
      for (let i = Math.max(prevTc + 2, 0); i < tc; i++) {
        const h = header[i], v = String(row[i] || "").trim();
        if (h === "客户" && v && !customer) customer = v;
      }
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
        else if (/^终点里程读数\d*$/.test(h) && endKm == null && !isNaN(parseFloat(v))) endKm = parseFloat(v);
      }
      stops.push({ time, address, customer, note, km, endKm });
    });
    const startKmRaw = String(row[iStartKm] || "").trim();
    out.push({
      approvalId, user: String(row[iUser] || ""), userId: String(row[iUid] || ""),
      dept: String(row[iDept] || ""), createTime: String(row[iCreate] || ""),
      status: String(row[iStatus] || ""), tripType: String(row[iTrip] || ""),
      vehicle: String(row[iVehicle] || ""),
      startKm: startKmRaw && !isNaN(parseFloat(startKmRaw)) ? parseFloat(startKmRaw) : null,
      stops,
    });
  }
  return out;
}

function loadAll(): ExcelApproval[] {
  const seen = new Set<string>();
  const out: ExcelApproval[] = [];
  for (const fn of fs.readdirSync(DIR).filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$"))) {
    const wb = XLSX.readFile(path.join(DIR, fn));
    for (const sn of wb.SheetNames) {
      for (const r of parseSheet(wb.Sheets[sn])) {
        if (seen.has(r.approvalId)) continue;
        seen.add(r.approvalId);
        out.push(r);
      }
    }
  }
  return out;
}

const loadCache = (): Record<string, { lat: number; lng: number } | null> =>
  fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

async function main() {
  const mode = process.argv[2] || "--dry";
  const limit = parseInt(process.argv[3] || "0", 10);

  const approvals = loadAll().filter((a) => a.status !== "已撤销" && a.stops.length > 0);
  console.log(`有效审批单 ${approvals.length} 张（已排除撤销单与 0 打卡点单）`);

  if (mode === "--dry") {
    const stops = approvals.reduce((s, a) => s + a.stops.length, 0);
    console.log(`打卡点 ${stops}，唯一地址 ${new Set(approvals.flatMap((a) => a.stops.map((s) => s.address.trim()).filter(Boolean))).size}`);
    return;
  }

  const cache = loadCache();
  const addrs = Array.from(new Set(approvals.flatMap((a) => a.stops.map((s) => s.address.trim()).filter(Boolean))));

  if (mode === "--geocode") {
    const todo = addrs.filter((a) => !(a in cache)).slice(0, limit || undefined);
    console.log(`待编码 ${addrs.filter((a) => !(a in cache)).length}，本次限 ${todo.length}`);
    let ok = 0, fail = 0;
    for (let i = 0; i < todo.length; i++) {
      const geo = await geocodeAddressWithSimplification(todo[i]);
      cache[todo[i]] = geo ? { lat: geo.coords.lat, lng: geo.coords.lng } : null;
      geo ? ok++ : fail++;
      if ((i + 1) % 200 === 0) {
        console.log(`进度 ${i + 1}/${todo.length}（成功 ${ok} 失败 ${fail}）`);
        fs.writeFileSync(CACHE, JSON.stringify(cache));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    console.log(`编码完成：成功 ${ok} 失败 ${fail}，缓存累计 ${Object.keys(cache).length}`);
    return;
  }

  // --retry：对失败的短地名，借同一审批单里其他地址的「省+市」前缀补全后重试
  if (mode === "--retry") {
    // 每个审批单提取一个「省+市」前缀候选
    const prefixByApproval = new Map<string, string>();
    const addrToApprovals = new Map<string, string[]>();
    for (const a of approvals) {
      for (const s of a.stops) {
        const m = s.address.match(/([一-龥]{2,4}省[一-龥]{2,6}市)/);
        if (m && !prefixByApproval.has(a.approvalId)) prefixByApproval.set(a.approvalId, m[1]);
        const t = s.address.trim();
        if (t) {
          if (!addrToApprovals.has(t)) addrToApprovals.set(t, []);
          addrToApprovals.get(t)!.push(a.approvalId);
        }
      }
    }
    const failed = Object.keys(cache).filter((a) => cache[a] === null && !/省|市/.test(a));
    const todo = failed.slice(0, limit || undefined);
    console.log(`可重试的短地名 ${failed.length}，本次限 ${todo.length}`);
    let ok = 0, fail = 0, noPrefix = 0;
    for (let i = 0; i < todo.length; i++) {
      const a = todo[i];
      const appr = (addrToApprovals.get(a) || []).find((id) => prefixByApproval.has(id));
      const prefix = appr ? prefixByApproval.get(appr)! : null;
      if (!prefix) { noPrefix++; continue; }
      const geo = await geocodeAddressWithSimplification(`${prefix}${a}`);
      if (geo) {
        cache[a] = { lat: geo.coords.lat, lng: geo.coords.lng };
        ok++;
        console.log(`救回: ${a} → ${prefix}${a}`);
      } else {
        fail++;
      }
      if ((i + 1) % 100 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache));
      await new Promise((r) => setTimeout(r, 120));
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    console.log(`重试完成：救回 ${ok}，仍失败 ${fail}，无前缀可用 ${noPrefix}`);
    return;
  }

  // --redo：QPS 修正后的原地址直解重跑（400ms）。优先处理 --retry 救回过（可能跑偏）的地址，再处理失败地址。
  if (mode === "--redo") {
    const rescued = new Set<string>();
    const retryLog = path.resolve(__dirname, "../../tmp/geocode-retry.log");
    if (fs.existsSync(retryLog)) {
      for (const line of fs.readFileSync(retryLog, "utf8").split("\n")) {
        const m = line.match(/^救回: (.+?) → /);
        if (m) rescued.add(m[1]);
      }
    }
    const rescuedTodo = Array.from(rescued).filter((a) => a in cache);
    const failedTodo = Object.keys(cache).filter((a) => cache[a] === null && !rescued.has(a));
    const todo = [...rescuedTodo, ...failedTodo].slice(0, limit || undefined);
    console.log(`重跑队列：跑偏复核 ${rescuedTodo.length} + 失败重试 ${failedTodo.length}，本次限 ${todo.length}`);
    let ok = 0, fail = 0;
    for (let i = 0; i < todo.length; i++) {
      const a = todo[i];
      const geo = await geocodeAddressWithSimplification(a);
      cache[a] = geo ? { lat: geo.coords.lat, lng: geo.coords.lng } : null;
      geo ? ok++ : fail++;
      if (i === 49) console.log(`前 50 个成功率 ${ok}/50（失败率熔断检查）`);
      if ((i + 1) % 100 === 0) {
        console.log(`进度 ${i + 1}/${todo.length}（成功 ${ok} 失败 ${fail}）`);
        fs.writeFileSync(CACHE, JSON.stringify(cache));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    console.log(`重跑完成：成功 ${ok} 失败 ${fail}`);
    return;
  }

  if (mode === "--import") {
    // 组装 ParsedVisit（source_detail 标记 excel-export；坐标缺失的行 geocode_status 自动记 failed）
    const visits: ParsedVisit[] = [];
    for (const a of approvals) {
      a.stops.forEach((s, idx) => {
        const geo = cache[s.address.trim()] ?? null;
        visits.push({
          user_id: a.userId,
          user_name: a.user,
          department: a.dept || "销售部",
          time: s.time || a.createTime,
          location_name: s.address,
          address: s.address,
          customer_name: s.customer,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          approval_id: a.approvalId,
          approval_status: a.status === "审批中" ? "RUNNING" : "COMPLETED",
          sequence: idx + 1,
          trip_type: a.tripType,
          vehicle: a.vehicle || undefined,
          start_odometer: idx === 0 ? a.startKm ?? undefined : undefined,
          end_odometer: s.endKm ?? undefined,
          reported_distance_km: s.km ?? undefined,
          cumulative_mileage_km: s.km ?? undefined,
          visit_note: s.note || undefined,
          source_detail: "excel-export",
        });
      });
    }
    console.log(`待入库拜访 ${visits.length} 条，分批写入`);
    let inserted = 0, skipped = 0;
    for (let i = 0; i < visits.length; i += 500) {
      const chunk = visits.slice(i, i + 500);
      const r = await processParsedVisits(chunk, "dingtalk");
      inserted += r.normalizedInserted ?? 0;
      skipped += r.skipped ?? 0;
      console.log(`进度 ${Math.min(i + 500, visits.length)}/${visits.length}（新增 ${inserted}，跳过 ${skipped}）`);
    }
    console.log(`导入完成：新增 ${inserted}，跳过 ${skipped}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
