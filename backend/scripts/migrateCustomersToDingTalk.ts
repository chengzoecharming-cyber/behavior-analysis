/**
 * 迁移旧 CRM 客户数据到钉钉「客户新增登记」审批单（PROC-C20D9C1D-...）
 *
 * 用法：
 *   npx ts-node scripts/migrateCustomersToDingTalk.ts --dry          # 打印前10条映射，不调API
 *   npx ts-node scripts/migrateCustomersToDingTalk.ts --limit=10     # 实跑10条（试点）
 *   npx ts-node scripts/migrateCustomersToDingTalk.ts                # 全量（断点续跑）
 *
 * 断点文件：scripts/.migrate-customers-progress.json（旧数据ID → instanceId），重跑自动跳过已创建。
 * 失败记录：scripts/.migrate-customers-failed.json
 */
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { pool } from "../src/db";
import { getAccessToken, getUserDetail } from "../src/services/dingtalk";

const PROCESS_CODE = "PROC-C20D9C1D-0D64-4F44-88FC-72103F36D29D";
const XLSX_PATH = "/Users/chenglimin/Documents/作业/丹弗/地图/CRM/客户合并数据_14166.xlsx";
const PROGRESS_FILE = path.join(__dirname, ".migrate-customers-progress.json");
const FAILED_FILE = path.join(__dirname, ".migrate-customers-failed.json");
const SLEEP_MS = 150;

// ---------- 组件 ID（来自测试实例） ----------
const C = {
  功能: "DDSelectField_2397GW47JBMO0",
  客户类型: "DDSelectField_13UHMPJJYT9C0",
  公司名称: "TextField_4ZI0H7G8WOG0",
  法定代表人: "TextField_CQUJAI3ZJS00",
  公司地址: "TextField_VUR7TZC9XDS0",
  刀具柜安装地址: "TextField_AKGGIXSIGS40",
  所属区域_国内: "DDSelectField_1ZC21CF4JY000",
  标签_产品意向: "DDSelectField_1GMXGDV6A4ZK0",
  标签_客户类型: "DDSelectField_175BLGY57XUO0",
  标签_意向: "DDSelectField_1JHSHMA2OBK00",
  跟进状态_国内: "DDSelectField_1EYOS9Y00P280",
  客户获取渠道_国内: "DDSelectField_1G0L3P393JPC0",
  竞争对手: "TextField_13CMNSHOR2800",
  负责人: "InnerContactField_GOL8HTHTNOG0",
  协同人: "InnerContactField_VCK4WZ9VTMO0",
  大型公司报备: "TextField_Y2C8380BD6O0",
  联系人姓名: "TextField_4C7755Q5RW80",
  联系人手机号: "PhoneField_PK2PUBGROSG0",
  跟进阶段_代理商: "DDSelectField_1Z9FPINVSKJK0",
  所属区域_代理商: "DDSelectField_HOD583YLY5K0",
  所属行业: "DDSelectField_1BACEOCPE65C0",
  是否制作实体授权书: "DDSelectField_LRM5GNM8I740",
  合作开始时间: "DDDateField_BWH6WABRUE00",
  合作结束时间: "DDDateField_O0B4VAJBNM80",
  是否有特殊商务: "DDSelectField_1KEXVFLF9FDS0",
  是否OEM: "DDSelectField_5A6M3BQE20C0",
  商务说明: "TextField_Q3VAV6HTUDS0",
  联系邮箱: "TextField_1MS7L4O8OTUO0",
  合作背景简介: "TextField_GF8OP29JG0W0",
  所属区域_海外: "DDSelectField_183WRSS4VYN40",
  客户获取渠道_海外: "DDSelectField_1YAQEB8K19NK0",
  whatsapp: "TextField_19FCJ5C6FXR40",
  wechat: "TextField_O6ZVO5H3J000",
  其他账号: "TextField_JDZMYD1MCTC0",
  跟进状态_海外: "DDSelectField_1USF8BVCU85C0",
};

// ---------- 归一化映射 ----------
const PRODUCT_TAGS = ["刀具柜","机加云","工具柜","数字仓库","工单宝","刀摆仪","称重柜","旋转柜"];
const TYPE_TAGS = ["国内终端客户","国外终端","国内代理商客户","国外渠道","国内合作伙伴客户","龙头企业"];
const INTENT_MAP: Record<string,string> = { "高意向":"高", "中意向":"中", "低意向":"低", "无意向":"无" };

const CHANNEL_MAP: Record<string,string> = {
  "市场推广平台获取": "市场推广平台获客",
  "展会、活动获取": "展会、活动获客",
  "个人渠道开发": "个人渠道获客",
  "代理商的客户": "代理商客户（代理选此项）",
  "公司内部渠道获客（领导/同事介绍）": "公司其他渠道获客（陈总、同事介绍）",
  "公司内部介绍获取（领导/同事介绍）": "公司其他渠道获客（陈总、同事介绍）",
  "社交媒体获取": "其他活动",
  "社交媒体获客": "其他活动",
  "smartbee官网": "其他活动",
  "客户/渠道转介绍": "客户转介绍",
};

const OVERSEAS_REGION_MAP: Record<string,string> = { "韩国": "亚洲", "中国特区": "港澳台" };

function normRegion(region: string): string {
  return region.replace(/^(华南|华东|华北)-/, "");
}

function splitTags(tags: string): { products: string[]; types: string[]; intent: string } {
  const parts = tags.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  return {
    products: parts.filter(p => PRODUCT_TAGS.includes(p)),
    types: parts.filter(p => TYPE_TAGS.includes(p)),
    intent: INTENT_MAP[parts.find(p => INTENT_MAP[p]) || ""] || "",
  };
}

interface Row { [k: string]: string }

async function buildUserMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const r1 = await pool.query(`SELECT user_name, user_id FROM users WHERE user_name IS NOT NULL`);
  const r2 = await pool.query(`SELECT name, user_id FROM dingtalk_users WHERE name IS NOT NULL`).catch(() => ({ rows: [] as any[] }));
  for (const r of [...r2.rows, ...r1.rows]) {
    const name = (r.user_name || r.name || "").trim();
    if (!name || /^\d+$/.test(name)) continue;
    if (!map.has(name)) map.set(name, r.user_id);
  }
  return map;
}

function buildFormValues(row: Row, userMap: Map<string,string>, logs: string[]): { id: string; name: string; value: string }[] {
  const vals: { id: string; name: string; value: string }[] = [];
  const put = (id: string, name: string, v?: string) => {
    const val = (v || "").trim();
    if (val) vals.push({ id, name, value: val });
  };
  const cat = row["客户分类"] || "";
  const isAgent = cat.includes("代理商");
  const isOverseas = cat.startsWith("海外");

  put(C.功能, "功能", "新建客户");
  put(C.客户类型, "客户类型", cat);
  put(C.公司名称, "公司名称", row["公司名称"]);
  put(C.法定代表人, "法定代表人", row["法定代表人"]);
  put(C.公司地址, "公司地址", row["公司地址"]);

  const region = normRegion(row["所属区域"] || "");
  if (isOverseas) {
    put(C.所属区域_海外, "客户所属区域", OVERSEAS_REGION_MAP[region] || region);
    put(C.联系邮箱, "联系邮箱", row["联系邮箱"]);
    put(C.whatsapp, "whatsapp账号", row["WhatsApp账号"]);
    put(C.wechat, "wechat账号", row["WeChat账号"]);
    put(C.合作背景简介, "客户合作背景简介", row["合作背景简介"]);
  } else if (isAgent) {
    put(C.所属区域_代理商, "所属区域", region);
    put(C.跟进阶段_代理商, "跟进阶段", row["跟进状态"]);
    put(C.所属行业, "所属行业", row["所属行业"]);
    put(C.合作开始时间, "合作开始时间（合作协议日期）", row["合作开始时间"]);
    put(C.合作结束时间, "合作协议结束时间", row["合作协议结束时间"]);
    put(C.是否OEM, "是否OEM", row["是否OEM"]);
    if (!isOverseas) put(C.刀具柜安装地址, "客户刀具柜安装地址", row["客户刀具柜安装地址"]);
  } else {
    put(C.所属区域_国内, "客户所属区域", region);
    put(C.刀具柜安装地址, "客户刀具柜安装地址", row["客户刀具柜安装地址"]);
    put(C.跟进状态_国内, "客户跟进状态", (row["跟进状态"] || "").replace(/\\/g, "/"));
  }

  const t = splitTags(row["客户标签"] || "");
  if (t.products.length) put(C.标签_产品意向, "标签 - 产品类型意向", t.products.join(","));
  if (t.types.length) put(C.标签_客户类型, "标签 - 客户类型", t.types.join(","));
  put(C.标签_意向, "标签 - 意向", t.intent);

  const channel = row["客户获取渠道"] || "";
  const ch = CHANNEL_MAP[channel] || channel;
  put(isOverseas ? C.客户获取渠道_海外 : C.客户获取渠道_国内, "客户获取渠道", ch);
  if (channel && ch !== channel) logs.push(`渠道归一: ${channel} -> ${ch}`);

  put(C.竞争对手, "竞争对手", row["竞争对手"]);
  put(C.大型公司报备, "大型公司报备", row["大型公司报备"]);

  // 负责人/协同人：姓名 → userid（先精确，再去掉“-部门”后缀匹配）
  const lookup = (n: string): string | undefined => {
    if (userMap.get(n)) return userMap.get(n);
    const base = n.split("-")[0].trim();
    return userMap.get(base);
  };
  const owners = (row["负责人"] || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const ownerIds = owners.map(n => lookup(n)).filter(Boolean) as string[];
  const missOwners = owners.filter(n => !lookup(n));
  if (missOwners.length) logs.push(`负责人未匹配: ${missOwners.join(",")}`);
  if (ownerIds.length) put(C.负责人, "负责人", ownerIds.join(","));
  const collabs = (row["协同人"] || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const collabIds = collabs.map(n => userMap.get(n)).filter(Boolean) as string[];
  if (collabIds.length) put(C.协同人, "协同人", collabIds.join(","));

  return vals;
}

async function createInstance(originator: string, deptId: number, formValues: any[]): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://oapi.dingtalk.com/topapi/processinstance/create?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        process_code: PROCESS_CODE,
        originator_user_id: originator,
        dept_id: deptId,
        form_component_values: formValues,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  const data: any = await res.json();
  if (data.errcode !== 0) throw new Error(`${data.errcode}: ${data.errmsg}`);
  return data.process_instance_id;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]) : Infinity;

  const wb = XLSX.readFile(XLSX_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: "" });
  console.log(`共 ${rows.length} 条客户数据`);

  console.log("连接数据库...");
  const userMap = await buildUserMap();
  console.log(`姓名→userid 映射 ${userMap.size} 条`);

  const progress: Record<string, string> = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) : {};
  const failed: any[] = fs.existsSync(FAILED_FILE)
    ? JSON.parse(fs.readFileSync(FAILED_FILE, "utf8")) : [];

  const operator = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operator && !dry) throw new Error("缺少 DINGTALK_OPERATOR_USERID");
  let deptId = 1;
  if (!dry) {
    console.log("获取操作员部门信息...");
    const detail = await getUserDetail(operator);
    deptId = detail?.dept_id_list?.[0] || detail?.deptIdList?.[0] || 1;
    console.log(`发起人 ${operator}, 部门 ${deptId}`);
  }

  let done = 0, skipped = 0, failedCount = 0, attempted = 0;
  const dryStats = { ownersTotal: 0, ownersMiss: 0, missNames: new Set<string>() };
  for (const row of rows) {
    if (done >= limit || attempted >= limit) break;
    const oldId = String(row["旧数据ID"] || "");
    if (!oldId || progress[oldId]) { skipped++; continue; }

    const logs: string[] = [];
    const vals = buildFormValues(row, userMap, logs);
    if (dry) {
      if (done < 10) {
        console.log(`\n=== ${row["公司名称"]} [${row["客户分类"]}/${row["客户状态"]}] ===`);
        for (const v of vals) console.log(`  ${v.name} = ${v.value.slice(0, 50)}`);
        for (const l of logs) console.log(`  ⚠ ${l}`);
      }
      for (const l of logs) {
        const m = l.match(/^负责人未匹配: (.+)/);
        if (m) { dryStats.ownersMiss++; m[1].split(",").forEach(n => dryStats.missNames.add(n)); }
      }
      if ((row["负责人"] || "").trim()) dryStats.ownersTotal++;
      done++;
      continue;
    }

    try {
      console.log(`→ 创建 ${row["公司名称"]} ...`);
      const instanceId = await createInstance(operator, deptId, vals);
      console.log(`✓ ${row["公司名称"]} -> ${instanceId}`);
      progress[oldId] = instanceId;
      done++;
      if (done % 100 === 0) {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
        console.log(`进度 ${done}（跳过 ${skipped}，失败 ${failedCount}）`);
      }
      await new Promise(r => setTimeout(r, SLEEP_MS));
    } catch (e: any) {
      failedCount++;
      failed.push({ oldId, name: row["公司名称"], error: e.message });
      console.error(`✗ ${row["公司名称"]}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!dry) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failed, null, 2));
  }
  console.log(`\n完成：成功 ${done}，跳过 ${skipped}，失败 ${failedCount}`);
  if (dry) {
    console.log(`负责人匹配：有负责人 ${dryStats.ownersTotal} 条，未匹配 ${dryStats.ownersMiss} 条，涉及 ${dryStats.missNames.size} 个人名`);
    if (dryStats.missNames.size) console.log([...dryStats.missNames].join("、"));
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
