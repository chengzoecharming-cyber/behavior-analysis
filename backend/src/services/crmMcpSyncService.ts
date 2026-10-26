/**
 * 探迹 CRM MCP 正式同步服务（2026-10-23 接入，替换 Excel 手工导入的主数据源）。
 *
 * - 客户：4 张表单（与 customer_type 四枚举一一对应），字段 key 各表不同（见 FORM_CONFIGS），
 *   增量 = update_time >= 水位线-2min（重叠防边界漏），sort update_time asc 游标翻页；
 *   upsert 只更新 MCP 提供的列，Excel 时代独有列（last_owner/return_pool_reason/
 *   return_pool_times/follow_times）保留旧值；record_ref 存 extra.record_ref。
 * - 僵尸客户：仅全量轮，对「本地有但该 customer_type 远端全量 id 集合没有」的行打
 *   is_deleted=true（不物理删，保留历史关联）；远端重新出现的行由 upsert 自动复活
 *   （ON CONFLICT 置 is_deleted=false）。读路径统一 NOT COALESCE(is_deleted,false) 过滤。
 * - 联系人：customer_contact 单表增量，upsert crm_contacts（手机号对象取 value）。
 * - 跟进：crm_get_customer_followups 的 item 无 record_ref（实测），无法提取记录 ID，
 *   用 md5(客户ID|创建时间|跟进类型|内容) 生成幂等 id upsert；create_user_name 不写
 *   （MCP 无创建人字段），ON CONFLICT 不覆盖已有值；编辑跟进会产生新行（该租户编辑极少，
 *   实测口径见 docs/crm-mcp-audit-2026-10-23.md 第 9 条）。
 * - 图片：create_time 近 6 个月的跟进「上传图片」下载到 backend/uploads/crm-images/
 *   （<跟进ID>_<原始文件名>，已存在跳过）；picture 列存 JSON 数组——下载成功存相对路径
 *   crm-images/xxx，失败/过期/超 6 个月存脱敏 host+path（不含签名查询串）。客户截图不下载。
 * - 每日回补兜底：每轮结束后对 latest_follow_up_time 近 30 天的客户重拉跟进
 *   （最多 200 个/轮，超出记日志），兜底「编辑跟进不 bump 客户 update_time」的漏刷。
 * - 对账：每表单远端 total vs 本地 count 差值 + 跟进表远端 total vs 本地 count，
 *   全部记入 crm_sync_logs.stats。
 * - 完成后写 crm_import_batches（batch_id='mcp:'+run_id，维持 snapshot_date 口径），
 *   调 invalidateCrmCache()。进程内互斥锁，单实体失败不中断其他实体。
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { pool } from "../db";
import { normalizeCustomerName } from "./normalization";
import { parseDateTimeAsBeijing } from "../utils/timezone";
import { invalidateCrmCache } from "./orderCustomerMatch";
import {
  CrmMcpFatalError,
  CrmSearchItem,
  CrmSearchPage,
  extractRecordId,
  getCustomerFollowups,
  getRecordIdExtractFailCount,
  isCrmMcpConfigured,
  redactUrl,
  searchRecords,
} from "./crmMcpClient";

// ---------- 表单配置 ----------

interface CustomerFormConfig {
  customerType: string;
  formRef: string;
  /** 字段 key → crm_customers 列/extra 键；各表单结构不同（2026-10-23 实测 available_fields） */
  fields: {
    legalPerson?: string;
    address?: string;
    installAddress?: string;
    region?: string;
    channel?: string;
    competitor?: string;
    screenshots?: string;
    /** 其余需要保留进 extra 的字段（key → extra 键名） */
    extraFields?: Record<string, string>;
  };
}

const CUSTOMER_FORMS: CustomerFormConfig[] = [
  {
    customerType: "enterprise_domestic",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfZW50ZXJwcmlzZSIsIjY4MDBlMTZiODJiNTBhMzBiMmIyMWIwMCIsbnVsbF2b_fA832O8gJRLGvqSdzIe",
    fields: {
      legalPerson: "text_0",
      address: "text_3",
      installAddress: "text_5",
      region: "keyword_4",
      channel: "keyword_2",
      competitor: "text_6",
      screenshots: "keyword_3",
      extraFields: { text_8: "large_company_report" },
    },
  },
  {
    customerType: "agent_domestic",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjY4MjE5NGIzYzUzOTI0MzlkY2Y3ZjUwOCIsbnVsbF0Z8ia-IgwKbxe5Qjvqej1e",
    fields: {
      region: "keyword_0",
      extraFields: {
        industry: "industry",
        keyword_1: "has_entity_authorization",
        remarks: "remarks",
        keyword_2: "has_special_business",
        text_0: "business_note",
        keyword_3: "is_oem",
        long_0: "cooperation_start",
        long_1: "cooperation_end",
        text_1: "large_company_report",
      },
    },
  },
  {
    customerType: "agent_overseas",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjZhMTdhZGQyNWQyZTRkMWFiNTNjNjJiZiIsbnVsbF163eQ8CDyYeteHE0I2rGJa",
    fields: {
      address: "address",
      legalPerson: "text_0",
      region: "keyword_0",
      channel: "source",
      extraFields: {
        text_1: "email",
        text_2: "cooperation_background",
        remarks: "remarks",
      },
    },
  },
  {
    customerType: "terminal_overseas",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjZhMTc5Y2NhNGJlNmMyMjRkMmM3MTY1ZCIsbnVsbF12huwOxchOXjE_pEQ-2ggr",
    fields: {
      address: "address",
      legalPerson: "text_0",
      region: "keyword_0",
      channel: "source",
      extraFields: {
        text_9: "email",
        text_7: "cooperation_background",
        remarks: "remarks",
      },
    },
  },
];

const CONTACT_FIELDS = [
  "customer_related",
  "name",
  "phone",
  "position",
  "is_decision_maker",
  "principal_id_list",
  "create_time",
  "update_time",
];

const IMAGE_DIR = path.resolve(__dirname, "../../uploads/crm-images");
const IMAGE_RECENT_MONTHS = 6;
const MAX_FOLLOWS_PER_CUSTOMER = 50;
const BACKSTOP_CUSTOMER_LIMIT = 200;
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

// ---------- 小工具 ----------

function asStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.length > 0 ? v.map(String).join(", ") : null;
  if (typeof v === "object") {
    // phone/address 等对象类型取 value 或整体序列化
    const o = v as Record<string, unknown>;
    if (typeof o.value === "string") return o.value || null;
    return JSON.stringify(v);
  }
  return String(v);
}

function asStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (v == null || v === "") return [];
  return [String(v)];
}

function asTime(v: unknown): Date | null {
  const s = asStr(v);
  if (!s) return null;
  const d = parseDateTimeAsBeijing(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 北京时间 YYYY-MM-DD HH:mm:ss（MCP 筛选值的格式） */
function fmtBeijingDateTime(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * 带 INVALID_FIELD 兜底的搜索：某字段不可投影时从错误消息解析字段名，移除后重试。
 * （代理商各表字段结构不同，text_3 等在企业表可用、代理商表报错。）
 */
async function searchWithFieldFallback(
  formRefOrType: string,
  opts: NonNullable<Parameters<typeof searchRecords>[1]>
): Promise<CrmSearchPage> {
  let fields = opts.fields ? [...opts.fields] : undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await searchRecords(formRefOrType, { ...opts, fields });
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      const m = msg.match(/字段“([^”]+)”不可用于返回字段投影/);
      if (!m || !fields) throw err;
      fields = fields.filter((f) => f !== m[1]);
      console.warn(`[crmMcpSync] 字段 ${m[1]} 不可投影，移除后重试（剩余 ${fields.length} 个字段）`);
    }
  }
  throw new Error("INVALID_FIELD 兜底重试次数耗尽");
}

// ---------- 统计结构 ----------

interface EntityStats {
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
  marked_deleted?: number;
  remote_total?: number;
  local_count?: number;
  drift?: number;
}

export interface CrmSyncResult {
  skipped?: boolean;
  runId: string;
  full: boolean;
  dryRun: boolean;
  status: "success" | "partial" | "failed";
  customers: Record<string, EntityStats>;
  contacts: EntityStats;
  follows: EntityStats & { customers_refreshed: number; backstop_customers: number };
  images: { downloaded: number; failed: number; skipped_old: number };
  error?: string;
  durationMs: number;
}

// ---------- 图片下载 ----------

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-一-鿿]/g, "_").slice(-120);
}

/** 下载一张图到 IMAGE_DIR，已存在跳过；返回相对路径 crm-images/xxx，失败返回 null */
async function downloadImage(url: string, fileName: string): Promise<string | null> {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const rel = `crm-images/${fileName}`;
  const abs = path.join(IMAGE_DIR, fileName);
  if (fs.existsSync(abs)) return rel;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > DOWNLOAD_MAX_BYTES) return null;
    fs.writeFileSync(abs, buf);
    return rel;
  } catch {
    return null;
  }
}

/** 处理一条跟进的图片字段，返回 picture 列应存的 JSON 数组字符串 */
async function processPictures(
  rawPicture: unknown,
  followId: string,
  createTime: Date | null,
  counters: { downloaded: number; failed: number; skipped_old: number }
): Promise<string | null> {
  const urls = asStrArr(rawPicture).filter((u) => /^https?:\/\//.test(u));
  if (urls.length === 0) return null;
  const sixMonthsAgo = Date.now() - IMAGE_RECENT_MONTHS * 30.5 * 24 * 3600 * 1000;
  const recent = createTime != null && createTime.getTime() >= sixMonthsAgo;
  const out: string[] = [];
  for (const url of urls) {
    const redacted = redactUrl(url);
    if (!recent) {
      counters.skipped_old++;
      out.push(redacted);
      continue;
    }
    let base = "image.jpg";
    try {
      base = sanitizeFilename(decodeURIComponent(new URL(redacted).pathname.split("/").pop() || "image.jpg"));
    } catch {
      // 保留默认文件名
    }
    const local = await downloadImage(url, `${followId}_${base}`);
    if (local) {
      counters.downloaded++;
      out.push(local);
    } else {
      counters.failed++;
      out.push(redacted);
    }
  }
  return JSON.stringify(out);
}

// ---------- 水位线 ----------

async function loadWatermark(formKey: string): Promise<Date | null> {
  const res = await pool.query<{ last_update_time: Date | null }>(
    `SELECT last_update_time FROM crm_mcp_sync_state WHERE form_key = $1`,
    [formKey]
  );
  return res.rows[0]?.last_update_time ?? null;
}

async function saveWatermark(
  formKey: string,
  lastUpdateTime: Date | null,
  total: number | null,
  status: string
): Promise<void> {
  await pool.query(
    `INSERT INTO crm_mcp_sync_state (form_key, last_update_time, last_run_at, last_total, last_status)
     VALUES ($1, $2, NOW(), $3, $4)
     ON CONFLICT (form_key) DO UPDATE SET
       last_update_time = COALESCE(EXCLUDED.last_update_time, crm_mcp_sync_state.last_update_time),
       last_run_at = NOW(),
       last_total = EXCLUDED.last_total,
       last_status = EXCLUDED.last_status`,
    [formKey, lastUpdateTime, total, status]
  );
}

// ---------- 客户 ----------

function customerFieldList(cfg: CustomerFormConfig): string[] {
  const f = cfg.fields;
  return [
    "customer_name", "principal_id_list", "cooperator_id_list", "tags", "follow_status",
    "latest_pool_take_time", "latest_follow_up_time", "latest_recycle_time",
    "latest_return_pool_time", "acquire_customer_time", "process_status", "process_result",
    "create_time", "update_time",
    f.legalPerson, f.address, f.installAddress, f.region, f.channel, f.competitor, f.screenshots,
    ...Object.keys(f.extraFields ?? {}),
  ].filter((x): x is string => !!x);
}

async function upsertCustomer(cfg: CustomerFormConfig, item: CrmSearchItem): Promise<"inserted" | "updated"> {
  const id = extractRecordId(item.record_ref);
  if (!id) throw new Error("record_ref 提取记录 ID 失败");
  const f = item.data_by_field ?? {};
  const cf = cfg.fields;
  const name = asStr(f.customer_name);
  const owners = asStrArr(f.principal_id_list);
  const cooperators = asStrArr(f.cooperator_id_list);

  const extra: Record<string, unknown> = { record_ref: item.record_ref };
  const screenshots = cf.screenshots ? asStrArr(f[cf.screenshots]).filter((u) => /^https?:\/\//.test(u)) : [];
  if (screenshots.length > 0) extra.screenshot_urls = screenshots;
  if (cooperators.length > 0) extra.cooperators = cooperators;
  const poolTakeTime = asStr(f.latest_pool_take_time);
  if (poolTakeTime) extra.pool_take_time = poolTakeTime;
  const acquireTime = asStr(f.acquire_customer_time);
  if (acquireTime) extra.acquire_customer_time = acquireTime;
  for (const [key, extraKey] of Object.entries(cf.extraFields ?? {})) {
    const v = asStr(f[key]);
    if (v) extra[extraKey] = v;
  }

  const res = await pool.query(
    `INSERT INTO crm_customers (
       id, customer_type, is_in_pool, name, name_norm, legal_person, address, install_address,
       region, tags, follow_status, channel, competitor, owner_name,
       latest_follow_up_time, recycle_time, process_status, process_result,
       return_pool_time, extra, created_time, updated_time, is_deleted
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,false)
     ON CONFLICT (id) DO UPDATE SET
       customer_type = EXCLUDED.customer_type,
       is_in_pool = EXCLUDED.is_in_pool,
       name = EXCLUDED.name,
       name_norm = EXCLUDED.name_norm,
       legal_person = EXCLUDED.legal_person,
       address = EXCLUDED.address,
       install_address = EXCLUDED.install_address,
       region = EXCLUDED.region,
       tags = EXCLUDED.tags,
       follow_status = EXCLUDED.follow_status,
       channel = EXCLUDED.channel,
       competitor = EXCLUDED.competitor,
       owner_name = EXCLUDED.owner_name,
       latest_follow_up_time = EXCLUDED.latest_follow_up_time,
       recycle_time = EXCLUDED.recycle_time,
       process_status = EXCLUDED.process_status,
       process_result = EXCLUDED.process_result,
       return_pool_time = EXCLUDED.return_pool_time,
       extra = COALESCE(crm_customers.extra, '{}'::jsonb) || EXCLUDED.extra,
       created_time = EXCLUDED.created_time,
       updated_time = EXCLUDED.updated_time,
       is_deleted = false
     RETURNING (xmax = 0) AS inserted`,
    [
      id,
      cfg.customerType,
      owners.length === 0,
      name,
      normalizeCustomerName(name),
      cf.legalPerson ? asStr(f[cf.legalPerson]) : null,
      cf.address ? asStr(f[cf.address]) : null,
      cf.installAddress ? asStr(f[cf.installAddress]) : null,
      cf.region ? asStr(f[cf.region]) : null,
      asStrArr(f.tags),
      asStr(f.follow_status),
      cf.channel ? asStr(f[cf.channel]) : null,
      cf.competitor ? asStr(f[cf.competitor]) : null,
      owners.length > 0 ? owners.join(", ") : null,
      asTime(f.latest_follow_up_time),
      asTime(f.latest_recycle_time),
      asStr(f.process_status),
      asStr(f.process_result),
      asTime(f.latest_return_pool_time),
      JSON.stringify(extra),
      asTime(f.create_time),
      asTime(f.update_time),
    ]
  );
  return res.rows[0]?.inserted ? "inserted" : "updated";
}

interface ChangedCustomer {
  id: string;
  name: string | null;
  recordRef: string;
}

async function syncCustomerForm(
  cfg: CustomerFormConfig,
  full: boolean,
  dryRun: boolean,
  changedCustomers: ChangedCustomer[]
): Promise<EntityStats> {
  const formKey = `customer:${cfg.customerType}`;
  const stats: EntityStats = { fetched: 0, inserted: 0, updated: 0, failed: 0, marked_deleted: 0 };
  const watermark = full ? null : await loadWatermark(formKey);
  const filters =
    watermark != null
      ? [{ field: "update_time", operator: "gte" as const, value: fmtBeijingDateTime(new Date(watermark.getTime() - WATERMARK_OVERLAP_MS)) }]
      : undefined;

  const firstPage = await searchWithFieldFallback(cfg.formRef, {
    filters,
    sortField: "update_time",
    sortDirection: "asc",
    fields: customerFieldList(cfg),
    limit: 50,
  });
  stats.remote_total = firstPage.total;

  if (dryRun) {
    const local = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM crm_customers WHERE customer_type = $1 AND NOT COALESCE(is_deleted, false)`,
      [cfg.customerType]
    );
    stats.local_count = parseInt(local.rows[0]?.n ?? "0", 10);
    stats.drift = (stats.remote_total ?? 0) - stats.local_count;
    return stats;
  }

  // 处理第一页，再继续翻页
  const remoteIds: string[] = [];
  let maxUpdateTime: Date | null = null;
  let cursor: string | null = null;
  for (;;) {
    const page: CrmSearchPage =
      cursor === null
        ? firstPage
        : await searchWithFieldFallback(cfg.formRef, {
            filters,
            sortField: "update_time",
            sortDirection: "asc",
            fields: customerFieldList(cfg),
            limit: 50,
            cursor,
          });
    for (const item of page.items) {
      stats.fetched++;
      try {
        const r = await upsertCustomer(cfg, item);
        if (r === "inserted") stats.inserted++;
        else stats.updated++;
        const id = extractRecordId(item.record_ref);
        if (id) {
          remoteIds.push(id);
          changedCustomers.push({ id, name: asStr(item.data_by_field?.customer_name), recordRef: item.record_ref });
        }
        const ut = asTime(item.data_by_field?.update_time);
        if (ut && (!maxUpdateTime || ut > maxUpdateTime)) maxUpdateTime = ut;
      } catch (err: any) {
        stats.failed++;
        console.error(`[crmMcpSync] 客户 upsert 失败（${cfg.customerType}）:`, err?.message || err);
      }
    }
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  // 僵尸打标：仅全量轮。本地有而远端全量 id 集合没有 → is_deleted=true
  if (full) {
    const marked = await pool.query(
      `UPDATE crm_customers SET is_deleted = true
       WHERE customer_type = $1 AND NOT COALESCE(is_deleted, false) AND NOT (id = ANY($2))`,
      [cfg.customerType, remoteIds]
    );
    stats.marked_deleted = marked.rowCount ?? 0;
  }

  const local = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM crm_customers WHERE customer_type = $1 AND NOT COALESCE(is_deleted, false)`,
    [cfg.customerType]
  );
  stats.local_count = parseInt(local.rows[0]?.n ?? "0", 10);
  stats.drift = (stats.remote_total ?? 0) - stats.local_count;

  await saveWatermark(
    formKey,
    maxUpdateTime ?? watermark,
    stats.remote_total ?? null,
    stats.failed > 0 ? "partial" : "success"
  );
  console.log(
    `[crmMcpSync] 客户 ${cfg.customerType}: fetched=${stats.fetched} inserted=${stats.inserted} ` +
      `updated=${stats.updated} failed=${stats.failed} marked_deleted=${stats.marked_deleted} drift=${stats.drift}`
  );
  return stats;
}

// ---------- 联系人 ----------

async function upsertContact(item: CrmSearchItem): Promise<"inserted" | "updated"> {
  const id = extractRecordId(item.record_ref);
  if (!id) throw new Error("record_ref 提取记录 ID 失败");
  const f = item.data_by_field ?? {};
  const owners = asStrArr(f.principal_id_list);
  const res = await pool.query(
    `INSERT INTO crm_contacts (id, customer_name, name, phone, position, is_decision_maker, owner_name, created_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       customer_name = EXCLUDED.customer_name,
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       position = EXCLUDED.position,
       is_decision_maker = EXCLUDED.is_decision_maker,
       owner_name = EXCLUDED.owner_name,
       created_time = EXCLUDED.created_time
     RETURNING (xmax = 0) AS inserted`,
    [
      id,
      asStr(f.customer_related),
      asStr(f.name),
      asStr(f.phone),
      asStr(f.position),
      asStr(f.is_decision_maker),
      owners.length > 0 ? owners.join(", ") : null,
      asTime(f.create_time),
    ]
  );
  return res.rows[0]?.inserted ? "inserted" : "updated";
}

async function syncContacts(full: boolean, dryRun: boolean): Promise<EntityStats> {
  const formKey = "contacts";
  const stats: EntityStats = { fetched: 0, inserted: 0, updated: 0, failed: 0 };
  const watermark = full ? null : await loadWatermark(formKey);
  const filters =
    watermark != null
      ? [{ field: "update_time", operator: "gte" as const, value: fmtBeijingDateTime(new Date(watermark.getTime() - WATERMARK_OVERLAP_MS)) }]
      : undefined;

  const firstPage = await searchWithFieldFallback("customer_contact", {
    byFormType: true,
    filters,
    sortField: "update_time",
    sortDirection: "asc",
    fields: CONTACT_FIELDS,
    limit: 50,
  });
  stats.remote_total = firstPage.total;

  if (dryRun) {
    const local = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_contacts`);
    stats.local_count = parseInt(local.rows[0]?.n ?? "0", 10);
    stats.drift = (stats.remote_total ?? 0) - stats.local_count;
    return stats;
  }

  let maxUpdateTime: Date | null = null;
  let cursor: string | null = null;
  for (;;) {
    const page: CrmSearchPage =
      cursor === null
        ? firstPage
        : await searchWithFieldFallback("customer_contact", {
            byFormType: true,
            filters,
            sortField: "update_time",
            sortDirection: "asc",
            fields: CONTACT_FIELDS,
            limit: 50,
            cursor,
          });
    for (const item of page.items) {
      stats.fetched++;
      try {
        const r = await upsertContact(item);
        if (r === "inserted") stats.inserted++;
        else stats.updated++;
        const ut = asTime(item.data_by_field?.update_time);
        if (ut && (!maxUpdateTime || ut > maxUpdateTime)) maxUpdateTime = ut;
      } catch (err: any) {
        stats.failed++;
        console.error(`[crmMcpSync] 联系人 upsert 失败:`, err?.message || err);
      }
    }
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  const local = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_contacts`);
  stats.local_count = parseInt(local.rows[0]?.n ?? "0", 10);
  stats.drift = (stats.remote_total ?? 0) - stats.local_count;

  await saveWatermark(formKey, maxUpdateTime ?? watermark, stats.remote_total ?? null, stats.failed > 0 ? "partial" : "success");
  console.log(
    `[crmMcpSync] 联系人: fetched=${stats.fetched} inserted=${stats.inserted} updated=${stats.updated} failed=${stats.failed} drift=${stats.drift}`
  );
  return stats;
}

// ---------- 跟进记录 ----------

function followRecordId(customerId: string, createTimeRaw: string, followType: string, content: string): string {
  return crypto.createHash("md5").update(`${customerId}|${createTimeRaw}|${followType}|${content}`).digest("hex");
}

async function refreshCustomerFollows(
  customer: ChangedCustomer,
  dryRun: boolean,
  followStats: EntityStats,
  imageCounters: { downloaded: number; failed: number; skipped_old: number }
): Promise<void> {
  let formCursors: Record<string, string> | null = null;
  let processed = 0;
  for (;;) {
    const page = await getCustomerFollowups(customer.recordRef, { limit: 50, formCursors });
    for (const form of page.forms) {
      for (const item of form.items) {
        if (processed >= MAX_FOLLOWS_PER_CUSTOMER) {
          console.warn(`[crmMcpSync] 客户 ${customer.name ?? customer.id} 跟进超过 ${MAX_FOLLOWS_PER_CUSTOMER} 条，本轮截断`);
          return;
        }
        processed++;
        const d = item.data ?? {};
        const createTimeRaw = String(d["创建时间"] ?? "");
        const followType = asStr(d["跟进类型"]) ?? "";
        const content = asStr(d["跟进内容"]) ?? "";
        const customerName = asStr(d["关联客户"]) ?? customer.name;
        const id = followRecordId(customer.id, createTimeRaw, followType, content);
        followStats.fetched++;
        if (dryRun) continue;
        try {
          const createTime = createTimeRaw ? asTime(createTimeRaw) : null;
          const picture = await processPictures(d["上传图片"], id, createTime, imageCounters);
          const res = await pool.query(
            `INSERT INTO crm_follow_records (id, customer_name, customer_name_norm, follow_type, content, picture, create_user_name, create_time, update_time)
             VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)
             ON CONFLICT (id) DO UPDATE SET
               customer_name = EXCLUDED.customer_name,
               customer_name_norm = EXCLUDED.customer_name_norm,
               follow_type = EXCLUDED.follow_type,
               content = EXCLUDED.content,
               picture = EXCLUDED.picture,
               update_time = EXCLUDED.update_time
             RETURNING (xmax = 0) AS inserted`,
            [
              id,
              customerName,
              normalizeCustomerName(customerName),
              followType || null,
              content || null,
              picture,
              createTime,
              asTime(d["更新时间"]),
            ]
          );
          if (res.rows[0]?.inserted) followStats.inserted++;
          else followStats.updated++;
        } catch (err: any) {
          followStats.failed++;
          console.error(`[crmMcpSync] 跟进 upsert 失败（客户 ${customer.name ?? customer.id}）:`, err?.message || err);
        }
      }
    }
    if (!page.next_form_cursors || Object.keys(page.next_form_cursors).length === 0) return;
    formCursors = page.next_form_cursors;
  }
}

/** 每日回补兜底：latest_follow_up_time 近 30 天的客户重拉跟进（兜底编辑跟进不 bump 客户 update_time 的漏刷） */
async function backstopRecentFollowCustomers(
  alreadyRefreshed: Set<string>,
  dryRun: boolean,
  followStats: EntityStats,
  imageCounters: { downloaded: number; failed: number; skipped_old: number }
): Promise<number> {
  const res = await pool.query<{ id: string; name: string | null; record_ref: string | null }>(
    `SELECT id, name, extra->>'record_ref' AS record_ref
     FROM crm_customers
     WHERE NOT COALESCE(is_deleted, false)
       AND latest_follow_up_time >= NOW() - INTERVAL '30 days'
     ORDER BY latest_follow_up_time DESC`
  );
  let count = 0;
  for (const row of res.rows) {
    if (count >= BACKSTOP_CUSTOMER_LIMIT) {
      console.warn(`[crmMcpSync] 回补兜底达到 ${BACKSTOP_CUSTOMER_LIMIT} 个客户上限，剩余 ${res.rows.length - count} 个留到下轮`);
      break;
    }
    if (alreadyRefreshed.has(row.id) || !row.record_ref) continue;
    count++;
    try {
      await refreshCustomerFollows({ id: row.id, name: row.name, recordRef: row.record_ref }, dryRun, followStats, imageCounters);
    } catch (err: any) {
      console.error(`[crmMcpSync] 回补客户 ${row.name ?? row.id} 跟进失败:`, err?.message || err);
    }
  }
  return count;
}

// ---------- 主入口 ----------

let syncRunning = false;

export async function syncCrmFromMcp(opts: {
  full?: boolean;
  dryRun?: boolean;
  triggerSource?: string;
}): Promise<CrmSyncResult> {
  if (syncRunning) {
    console.log("[crmMcpSync] 上一次 CRM 同步未完成，跳过");
    return {
      skipped: true,
      runId: "",
      full: !!opts.full,
      dryRun: !!opts.dryRun,
      status: "failed",
      customers: {},
      contacts: { fetched: 0, inserted: 0, updated: 0, failed: 0 },
      follows: { fetched: 0, inserted: 0, updated: 0, failed: 0, customers_refreshed: 0, backstop_customers: 0 },
      images: { downloaded: 0, failed: 0, skipped_old: 0 },
      error: "上一次同步未完成",
      durationMs: 0,
    };
  }
  if (!isCrmMcpConfigured()) {
    throw new Error("CRM_MCP_TOKEN 未配置");
  }
  syncRunning = true;

  const full = !!opts.full;
  const dryRun = !!opts.dryRun;
  const runId = `${full ? "full" : "inc"}-${Date.now()}`;
  const startedAt = Date.now();
  const triggerSource = opts.triggerSource ?? "manual";

  const result: CrmSyncResult = {
    runId,
    full,
    dryRun,
    status: "success",
    customers: {},
    contacts: { fetched: 0, inserted: 0, updated: 0, failed: 0 },
    follows: { fetched: 0, inserted: 0, updated: 0, failed: 0, customers_refreshed: 0, backstop_customers: 0 },
    images: { downloaded: 0, failed: 0, skipped_old: 0 },
    durationMs: 0,
  };

  if (!dryRun) {
    await pool.query(
      `INSERT INTO crm_sync_logs (run_id, trigger_source, status, full_sync, started_at)
       VALUES ($1, $2, 'running', $3, NOW())`,
      [runId, triggerSource, full]
    );
  }

  const changedCustomers: ChangedCustomer[] = [];
  try {
    // 1. 客户 4 表单
    for (const cfg of CUSTOMER_FORMS) {
      try {
        result.customers[cfg.customerType] = await syncCustomerForm(cfg, full, dryRun, changedCustomers);
      } catch (err: any) {
        result.status = "partial";
        result.customers[cfg.customerType] = { fetched: 0, inserted: 0, updated: 0, failed: -1 };
        console.error(`[crmMcpSync] 客户表单 ${cfg.customerType} 同步失败（不影响其他实体）:`, err?.message || err);
        await saveWatermark(`customer:${cfg.customerType}`, null, null, "failed").catch(() => {});
        if (err instanceof CrmMcpFatalError) throw err;
      }
    }

    // 2. 联系人（2026-10-23 产品决策：价值低，默认不同步；CRM_MCP_SYNC_CONTACTS=true 才开启）
    if (process.env.CRM_MCP_SYNC_CONTACTS === "true") {
      try {
        result.contacts = await syncContacts(full, dryRun);
      } catch (err: any) {
        result.status = "partial";
        console.error(`[crmMcpSync] 联系人同步失败（不影响其他实体）:`, err?.message || err);
        await saveWatermark("contacts", null, null, "failed").catch(() => {});
        if (err instanceof CrmMcpFatalError) throw err;
      }
    } else {
      console.log("[crmMcpSync] 联系人同步已跳过（CRM_MCP_SYNC_CONTACTS 未开启）");
    }

    // 3. 跟进：本轮变更客户逐个全量刷该客户名下跟进
    const refreshed = new Set<string>();
    for (const c of changedCustomers) {
      if (refreshed.has(c.id)) continue;
      refreshed.add(c.id);
      try {
        await refreshCustomerFollows(c, dryRun, result.follows, result.images);
      } catch (err: any) {
        result.status = "partial";
        console.error(`[crmMcpSync] 客户 ${c.name ?? c.id} 跟进刷新失败:`, err?.message || err);
        if (err instanceof CrmMcpFatalError) throw err;
      }
    }
    result.follows.customers_refreshed = refreshed.size;

    // 4. 回补兜底：近 30 天有跟进的客户重拉（限 200 个/轮）
    try {
      result.follows.backstop_customers = await backstopRecentFollowCustomers(refreshed, dryRun, result.follows, result.images);
    } catch (err: any) {
      result.status = "partial";
      console.error(`[crmMcpSync] 跟进回补兜底失败:`, err?.message || err);
    }

    // 5. 跟进表对账：远端 total vs 本地 count，漂移记入日志
    try {
      const remoteFollows = await searchRecords("follow_record", { byFormType: true, limit: 1 });
      result.follows.remote_total = remoteFollows.total;
      const local = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_follow_records`);
      result.follows.local_count = parseInt(local.rows[0]?.n ?? "0", 10);
      result.follows.drift = remoteFollows.total - result.follows.local_count;
      if (result.follows.drift !== 0) {
        console.warn(`[crmMcpSync] 跟进对账漂移: remote=${remoteFollows.total} local=${result.follows.local_count} drift=${result.follows.drift}`);
      }
    } catch (err: any) {
      console.error(`[crmMcpSync] 跟进对账失败:`, err?.message || err);
    }

    // 6. 批次记录（维持 snapshot_date 口径）+ 缓存失效
    if (!dryRun) {
      const totalFetched =
        Object.values(result.customers).reduce((a, s) => a + s.fetched, 0) + result.contacts.fetched;
      const totalInserted =
        Object.values(result.customers).reduce((a, s) => a + s.inserted, 0) + result.contacts.inserted;
      await pool.query(
        `INSERT INTO crm_import_batches (batch_id, source_file, file_hash, total, success, dropped, drop_reasons)
         VALUES ($1, $2, NULL, $3, $4, 0, '{}')
         ON CONFLICT (batch_id) DO UPDATE SET
           total = EXCLUDED.total, success = EXCLUDED.success`,
        [`mcp:${runId}`, `mcp://${full ? "full" : "incremental"}`, totalFetched, totalInserted]
      );
      invalidateCrmCache();
    }
  } catch (err: any) {
    result.status = "failed";
    result.error = err?.message || String(err);
    console.error(`[crmMcpSync] 同步失败:`, result.error);
  } finally {
    result.durationMs = Date.now() - startedAt;
    if (!dryRun) {
      await pool
        .query(
          `UPDATE crm_sync_logs SET status = $1, stats = $2, error_message = $3, finished_at = NOW()
           WHERE run_id = $4`,
          [
            result.status,
            JSON.stringify({
              customers: result.customers,
              contacts: result.contacts,
              follows: result.follows,
              images: result.images,
              duration_ms: result.durationMs,
              record_id_extract_failures: getRecordIdExtractFailCount(),
            }),
            result.error ?? null,
            runId,
          ]
        )
        .catch((e) => console.error("[crmMcpSync] 写同步日志失败:", e));
    }
    syncRunning = false;
  }

  console.log(
    `[crmMcpSync] 完成 run=${runId} status=${result.status} 耗时=${Math.round(result.durationMs / 1000)}s ` +
      `图片下载=${result.images.downloaded} 失败=${result.images.failed}`
  );
  return result;
}
