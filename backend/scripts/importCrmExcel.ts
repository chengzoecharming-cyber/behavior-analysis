/**
 * 探迹 CRM Excel 导入脚本（幂等，可重复执行）
 *
 * ⚠️ 已停用（2026-10-26 起）：CRM 主数据源已切换为探迹 MCP 同步
 * （crmMcpSyncService，手动 POST /crm-mcp/sync 或 CRM_MCP_SYNC_ENABLED=true 定时增量）。
 * Excel 快照是过期数据，直接跑会覆盖 MCP 同步结果。确需导入历史 Excel 时，
 * 显式加 --force-deprecated-excel 参数才会执行。
 *
 * 用法：cd backend && npm run import:crm -- --force-deprecated-excel
 *
 * - RAW 层：raw_crm_rows 按 (batch_id, row_index) 唯一去重，batch_id = 文件名:md5，
 *   同一文件重跑不会产生重复原始行；
 * - NORMALIZED 层：crm_customers / crm_contacts / crm_follow_records 按 数据ID upsert；
 * - 每文件一个 batch，写 crm_import_batches（total/success/dropped/drop_reasons）；
 * - 清洗规则：联系人丢弃「姓名与客户名相同且手机号为空」的脏行（计入 dropped）；
 *   跟进记录内容 trim；时间字符串按北京时间解析（utils/timezone.ts）。
 */

import * as XLSX from "xlsx";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { pool, initDB } from "../src/db";
import { normalizeTimestamp, normalizeCustomerName } from "../src/services/normalization";

const CRM_DIR = process.env.CRM_DIR || path.join(process.env.HOME || "~", "Documents/作业/丹弗/地图/CRM");

const CUSTOMER_TYPES = [
  "enterprise_domestic",
  "agent_domestic",
  "terminal_overseas",
  "agent_overseas",
] as const;
type CustomerType = (typeof CUSTOMER_TYPES)[number];

interface FileConfig {
  file: string;
  kind: "customer" | "contact" | "follow";
  customerType?: CustomerType;
  isInPool?: boolean;
}

const FILES: FileConfig[] = [
  { file: "客户管理_国内企业客户导出_1788418842833.xlsx", kind: "customer", customerType: "enterprise_domestic", isInPool: false },
  { file: "客户管理_公海客户导出_1788419979545.xlsx", kind: "customer", customerType: "enterprise_domestic", isInPool: true },
  { file: "客户管理_国内代理商导出_1788320869309.xlsx", kind: "customer", customerType: "agent_domestic", isInPool: false },
  { file: "客户管理_海外终端客户导出_1788320843743.xlsx", kind: "customer", customerType: "terminal_overseas", isInPool: false },
  { file: "客户管理_海外代理商导出_1788320854749.xlsx", kind: "customer", customerType: "agent_overseas", isInPool: false },
  { file: "联系人/客户管理_联系人导出_1788429174103_1-10000.xlsx", kind: "contact" },
  { file: "联系人/客户管理_联系人导出_1788429174110_10001-20000.xlsx", kind: "contact" },
  { file: "联系人/客户管理_联系人导出_1788429174110_20001-29387.xlsx", kind: "contact" },
  { file: "全公司跟进记录.xlsx", kind: "follow" },
];

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function intOrNull(v: unknown): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 按北京时间解析时间字符串；空值/纯数字天数/解析失败返回 null */
function timeOrNull(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // 整数小数值大概率是「天数」而不是 Excel 日期序列号，不当时间处理
    if (Number.isInteger(v) && v < 1000) return null;
    const d = normalizeTimestamp(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = normalizeTimestamp(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function splitTags(v: unknown): string[] | null {
  const s = str(v);
  if (!s) return null;
  const parts = s.split(/[,，、]/).map((t) => t.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function fileHash(buf: Buffer): string {
  return crypto.createHash("md5").update(buf).digest("hex");
}

/** 通用多行 upsert，按 chunk 分批 */
async function batchUpsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictTarget: string,
  updateColumns: string[]
): Promise<number> {
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const valuesSql = chunk
      .map((r) => {
        const ph = r.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      })
      .join(",");
    const setSql = updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await pool.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${valuesSql}
       ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setSql}`,
      params
    );
    written += chunk.length;
  }
  return written;
}

async function writeBatchSummary(
  batchId: string,
  sourceFile: string,
  hash: string,
  total: number,
  success: number,
  dropped: number,
  dropReasons: Record<string, number>
): Promise<void> {
  await pool.query(
    `INSERT INTO crm_import_batches (batch_id, source_file, file_hash, total, success, dropped, drop_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (batch_id) DO UPDATE SET
       total = EXCLUDED.total, success = EXCLUDED.success,
       dropped = EXCLUDED.dropped, drop_reasons = EXCLUDED.drop_reasons`,
    [batchId, sourceFile, hash, total, success, dropped, JSON.stringify(dropReasons)]
  );
}

/** RAW 层写入：按 (batch_id, row_index) 去重，重复行跳过 */
async function insertRawRows(
  batchId: string,
  sourceFile: string,
  hash: string,
  rows: Row[]
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const valuesSql = chunk
      .map((r, j) => {
        params.push(batchId, sourceFile, hash, i + j, JSON.stringify(r));
        const base = params.length;
        return `($${base - 4}, $${base - 3}, $${base - 2}, $${base - 1}, $${base})`;
      })
      .join(",");
    await pool.query(
      `INSERT INTO raw_crm_rows (batch_id, source_file, file_hash, row_index, row_json)
       VALUES ${valuesSql}
       ON CONFLICT (batch_id, row_index) DO NOTHING`,
      params
    );
  }
}

/** 已映射的标准列不再进 extra */
function buildExtra(row: Row, usedKeys: string[]): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!usedKeys.includes(k)) {
      const s = str(v);
      if (s !== null) extra[k] = s;
    }
  }
  return extra;
}

interface CustomerRow extends Array<unknown> {
  [k: number]: unknown;
}

function mapCustomerRow(row: Row, cfg: FileConfig): CustomerRow {
  const t = cfg.customerType!;
  const isAgentDomestic = t === "agent_domestic";
  const isOverseas = t === "terminal_overseas" || t === "agent_overseas";

  // 国内代理商导出的列名与其他客户表不同
  const name = isAgentDomestic ? str(row["客户名称"]) : str(row["公司名称"]);
  const followStatus = isAgentDomestic ? str(row["跟进阶段"]) : str(row["客户跟进状态"]);
  const region = isAgentDomestic
    ? str(row["所属区域"])
    : str(row[isOverseas && t === "agent_overseas" ? "代理商所属区域" : "客户所属区域"] ?? row["客户所属区域"]);
  const channel = isAgentDomestic
    ? null
    : str(row[t === "agent_overseas" ? "代理商获取渠道" : "客户获取渠道"]);

  const usedKeys = isAgentDomestic
    ? ["数据ID", "客户名称", "跟进阶段", "跟进记录次数", "所属区域", "负责人", "最近跟进时间", "掉保时间", "创建时间", "更新时间"]
    : [
        "数据ID", "公司名称", "法定代表人", "公司地址", "客户刀具柜安装地址", "客户所属区域", "代理商所属区域",
        "客户标签", "客户跟进状态", "客户获取渠道", "代理商获取渠道", "竞争对手", "负责人", "跟进记录次数",
        "最近跟进时间", "掉保时间", "审批状态", "审批结果", "最后负责人", "退回公海时间", "退回公海原因",
        "退回公海次数", "创建时间", "更新时间",
      ];

  return [
    str(row["数据ID"]),
    t,
    cfg.isInPool ?? false,
    name,
    normalizeCustomerName(name),
    str(row["法定代表人"]),
    str(row["公司地址"]),
    str(row["客户刀具柜安装地址"]),
    region,
    splitTags(row["客户标签"]),
    followStatus,
    channel,
    str(row["竞争对手"]),
    str(row["负责人"]),
    intOrNull(row["跟进记录次数"]) ?? 0,
    timeOrNull(row["最近跟进时间"]),
    timeOrNull(row["掉保时间"]),
    str(row["审批状态"]),
    str(row["审批结果"]),
    str(row["最后负责人"]),
    timeOrNull(row["退回公海时间"]),
    str(row["退回公海原因"]),
    intOrNull(row["退回公海次数"]),
    JSON.stringify(buildExtra(row, usedKeys)),
    timeOrNull(row["创建时间"]),
    timeOrNull(row["更新时间"]),
  ];
}

const CUSTOMER_COLUMNS = [
  "id", "customer_type", "is_in_pool", "name", "name_norm", "legal_person", "address",
  "install_address", "region", "tags", "follow_status", "channel", "competitor",
  "owner_name", "follow_times", "latest_follow_up_time", "recycle_time",
  "process_status", "process_result", "last_owner", "return_pool_time",
  "return_pool_reason", "return_pool_times", "extra", "created_time", "updated_time",
];

async function importCustomerFile(cfg: FileConfig, rows: Row[]): Promise<{ success: number }> {
  const mapped = rows
    .filter((r) => str(r["数据ID"]))
    .map((r) => mapCustomerRow(r, cfg));
  const success = await batchUpsert(
    "crm_customers",
    CUSTOMER_COLUMNS,
    mapped,
    "id",
    CUSTOMER_COLUMNS.filter((c) => c !== "id")
  );
  return { success };
}

async function importContactFile(rows: Row[]): Promise<{ success: number; dropped: number; reasons: Record<string, number> }> {
  const reasons: Record<string, number> = {};
  let dropped = 0;
  const kept: unknown[][] = [];
  for (const r of rows) {
    const id = str(r["数据ID"]);
    if (!id) {
      dropped++;
      reasons["missing_id"] = (reasons["missing_id"] ?? 0) + 1;
      continue;
    }
    const customerName = str(r["客户"]);
    const name = str(r["姓名"]);
    const phone = str(r["手机号"]);
    // 脏行清洗：姓名与客户名相同 且 手机号为空 → 丢弃
    if (name && customerName && name === customerName && !phone) {
      dropped++;
      reasons["name_eq_customer_no_phone"] = (reasons["name_eq_customer_no_phone"] ?? 0) + 1;
      continue;
    }
    kept.push([
      id,
      customerName,
      name,
      phone,
      str(r["职位"]),
      str(r["是否关键决策人"]),
      str(r["负责人"]),
      timeOrNull(r["创建时间"]),
    ]);
  }
  const cols = ["id", "customer_name", "name", "phone", "position", "is_decision_maker", "owner_name", "created_time"];
  const success = await batchUpsert("crm_contacts", cols, kept, "id", cols.filter((c) => c !== "id"));
  return { success, dropped, reasons };
}

async function importFollowFile(rows: Row[]): Promise<{ success: number }> {
  const mapped = rows
    .filter((r) => str(r["数据ID"]))
    .map((r) => {
      const customerName = str(r["跟进对象"]);
      return [
        str(r["数据ID"]),
        customerName,
        normalizeCustomerName(customerName),
        str(r["跟进类型"]),
        str(r["跟进内容"]), // str() 已 trim
        str(r["上传图片"]),
        str(r["创建人"]),
        timeOrNull(r["创建时间"]),
      ];
    });
  const cols = ["id", "customer_name", "customer_name_norm", "follow_type", "content", "picture", "create_user_name", "create_time"];
  const success = await batchUpsert(
    "crm_follow_records",
    cols,
    mapped,
    "id",
    cols.filter((c) => c !== "id")
  );
  return { success };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--force-deprecated-excel")) {
    console.error(
      "[import:crm] Excel 导入已停用：CRM 主数据源为探迹 MCP 同步" +
        "（POST /crm-mcp/sync 或 CRM_MCP_SYNC_ENABLED=true 定时增量）。\n" +
        "Excel 快照是过期数据，直接导入会覆盖 MCP 同步结果。\n" +
        "确需导入历史 Excel 时，显式加 --force-deprecated-excel 再执行。"
    );
    process.exit(1);
  }
  await initDB();

  for (const cfg of FILES) {
    const filePath = path.join(CRM_DIR, cfg.file);
    const buf = fs.readFileSync(filePath) as Buffer;
    const hash = fileHash(buf);
    const batchId = `${path.basename(cfg.file)}:${hash}`;

    const workbook = XLSX.read(buf, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: "" });

    console.log(`\n[import:crm] ${cfg.file}: ${rows.length} 行, batch=${batchId}`);

    await insertRawRows(batchId, path.basename(cfg.file), hash, rows);

    let success = 0;
    let dropped = 0;
    let reasons: Record<string, number> = {};
    if (cfg.kind === "customer") {
      ({ success } = await importCustomerFile(cfg, rows));
    } else if (cfg.kind === "contact") {
      const r = await importContactFile(rows);
      success = r.success;
      dropped = r.dropped;
      reasons = r.reasons;
    } else {
      ({ success } = await importFollowFile(rows));
    }

    await writeBatchSummary(batchId, path.basename(cfg.file), hash, rows.length, success, dropped, reasons);
    console.log(`[import:crm]   total=${rows.length} success=${success} dropped=${dropped} reasons=${JSON.stringify(reasons)}`);
  }

  const counts = await pool.query(`
    SELECT 'crm_customers' AS t, COUNT(*)::int AS n FROM crm_customers
    UNION ALL SELECT 'crm_contacts', COUNT(*)::int FROM crm_contacts
    UNION ALL SELECT 'crm_follow_records', COUNT(*)::int FROM crm_follow_records
    UNION ALL SELECT 'raw_crm_rows', COUNT(*)::int FROM raw_crm_rows`);
  console.log("\n[import:crm] 库内总量:", counts.rows);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[import:crm] 失败:", err);
    pool.end().finally(() => process.exit(1));
  });
