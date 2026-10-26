/**
 * 探迹 CRM MCP 只读对账脚本（--dry 是默认且唯一模式）。
 *
 * 边界：对远端只调用只读工具（list/search/aggregate/followups），
 * 对本地库只 SELECT（不调用 initDB，不写任何表）。
 *
 * 对账内容：
 *  a. 客户 4 表单：远端 total vs 本地 crm_customers 按 customer_type count；
 *     每类抽 30 条按 keyword 搜索 + extractRecordId 匹配，对比
 *     owner_name/follow_status/is_in_pool/name_norm（Excel 快照滞后差异单列，不算错误）。
 *  b. 跟进记录增量机制：follow_record 表 create_time gte 筛选 + asc 排序 + 游标翻页验证；
 *     belong_to_type 字段是否返回（已知会被丢弃，记录实测）；按客户维度
 *     crm_get_customer_followups 拉取条数 vs 本地该客户跟进数。
 *  c. 联系人：远端 total vs 本地 count；抽 20 条验证「客户」字段值是客户名。
 *  d. 图片可访问性：对 2-3 张抽样图片发 HEAD（日志只打 redactUrl 后的路径）。
 *
 * 用法：cd backend && npm run audit:crm-mcp
 * 报告落盘：../tmp/crm-mcp-audit/audit-<ts>.json / .md
 */

import * as fs from "fs";
import * as path from "path";
import { pool } from "../src/db";
import { normalizeCustomerName } from "../src/services/normalization";
import {
  CrmMcpFatalError,
  extractRecordId,
  getCustomerFollowups,
  getRecordIdExtractFailCount,
  isCrmMcpConfigured,
  redactUrl,
  searchAll,
  searchRecords,
} from "../src/services/crmMcpClient";

const CUSTOMER_FORMS: Array<{ customerType: string; formRef: string }> = [
  {
    customerType: "enterprise_domestic",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfZW50ZXJwcmlzZSIsIjY4MDBlMTZiODJiNTBhMzBiMmIyMWIwMCIsbnVsbF2b_fA832O8gJRLGvqSdzIe",
  },
  {
    customerType: "agent_domestic",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjY4MjE5NGIzYzUzOTI0MzlkY2Y3ZjUwOCIsbnVsbF0Z8ia-IgwKbxe5Qjvqej1e",
  },
  {
    customerType: "agent_overseas",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjZhMTdhZGQyNWQyZTRkMWFiNTNjNjJiZiIsbnVsbF163eQ8CDyYeteHE0I2rGJa",
  },
  {
    customerType: "terminal_overseas",
    formRef:
      "crm_ref_v2_WyJmIiwiY3VzdG9tZXJfY3VzdG9taXplZCIsIjZhMTc5Y2NhNGJlNmMyMjRkMmM3MTY1ZCIsbnVsbF12huwOxchOXjE_pEQ-2ggr",
  },
];

const CUSTOMER_SAMPLE_SIZE = 30;
const CONTACT_SAMPLE_SIZE = 20;
const IMAGE_PROBE_COUNT = 3;

const CUSTOMER_PROBE_FIELDS = [
  "customer_name",
  "principal_id_list",
  "follow_status",
  "keyword_3",
  "update_time",
];

interface FieldDiff {
  id: string;
  name: string;
  field: string;
  local: string;
  remote: string;
}

interface CustomerFormAudit {
  customerType: string;
  remoteTotal: number;
  localCount: number;
  sampled: number;
  found: number;
  notFound: number;
  /** Excel 快照早于 MCP 实时数据，这些差异是预期内的快照滞后，不算错误 */
  snapshotLagDiffs: FieldDiff[];
  /** name_norm 不一致属于真错误（口径问题） */
  nameNormMismatches: FieldDiff[];
}

interface LocalCustomerRow {
  id: string;
  name: string | null;
  name_norm: string | null;
  owner_name: string | null;
  follow_status: string | null;
  is_in_pool: boolean;
}

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null || v === "") return [];
  return [String(v)];
}

function strOrEmpty(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

async function auditCustomerForm(
  customerType: string,
  formRef: string,
  followupProbeRefs: Array<{ id: string; name: string; recordRef: string }>,
  imageUrls: string[]
): Promise<CustomerFormAudit> {
  const firstPage = await searchRecords(formRef, { limit: 1 });
  const remoteTotal = firstPage.total;

  const localCountRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM crm_customers WHERE customer_type = $1`,
    [customerType]
  );
  const localCount = parseInt(localCountRes.rows[0]?.n ?? "0", 10);

  const sampleRes = await pool.query<LocalCustomerRow>(
    `SELECT id, name, name_norm, owner_name, follow_status, is_in_pool
     FROM crm_customers WHERE customer_type = $1 ORDER BY random() LIMIT $2`,
    [customerType, CUSTOMER_SAMPLE_SIZE]
  );

  const result: CustomerFormAudit = {
    customerType,
    remoteTotal,
    localCount,
    sampled: sampleRes.rows.length,
    found: 0,
    notFound: 0,
    snapshotLagDiffs: [],
    nameNormMismatches: [],
  };

  for (const local of sampleRes.rows) {
    if (!local.name) {
      result.notFound++;
      continue;
    }
    let page;
    try {
      page = await searchRecords(formRef, {
        filters: [{ field: "customer_name", operator: "contains", value: local.name }],
        fields: CUSTOMER_PROBE_FIELDS,
        limit: 10,
      });
    } catch (err) {
      // 代理商表单个别字段（keyword_3 截图）不可投影，降级为最小字段集
      if (err instanceof Error && err.message.includes("INVALID_FIELD")) {
        page = await searchRecords(formRef, {
          filters: [{ field: "customer_name", operator: "contains", value: local.name }],
          fields: CUSTOMER_PROBE_FIELDS.filter((f) => f !== "keyword_3"),
          limit: 10,
        });
      } else {
        throw err;
      }
    }
    const remote = page.items.find((it) => extractRecordId(it.record_ref) === local.id);
    if (!remote) {
      result.notFound++;
      continue;
    }
    result.found++;
    const f = remote.data_by_field ?? {};

    const remoteName = strOrEmpty(f.customer_name);
    const remoteNameNorm = normalizeCustomerName(remoteName);
    const localNameNorm = local.name_norm ?? normalizeCustomerName(local.name);
    if (remoteNameNorm !== localNameNorm) {
      result.nameNormMismatches.push({
        id: local.id,
        name: local.name,
        field: "name_norm",
        local: localNameNorm,
        remote: remoteNameNorm,
      });
    }

    const owners = arr(f.principal_id_list);
    const remoteOwner = owners.join(", ");
    if (remoteOwner !== (local.owner_name ?? "")) {
      result.snapshotLagDiffs.push({
        id: local.id,
        name: local.name,
        field: "owner_name",
        local: local.owner_name ?? "",
        remote: remoteOwner,
      });
    }
    const remoteFollowStatus = strOrEmpty(f.follow_status);
    if (remoteFollowStatus !== (local.follow_status ?? "")) {
      result.snapshotLagDiffs.push({
        id: local.id,
        name: local.name,
        field: "follow_status",
        local: local.follow_status ?? "",
        remote: remoteFollowStatus,
      });
    }
    const remoteIsInPool = owners.length === 0;
    if (remoteIsInPool !== local.is_in_pool) {
      result.snapshotLagDiffs.push({
        id: local.id,
        name: local.name,
        field: "is_in_pool",
        local: String(local.is_in_pool),
        remote: String(remoteIsInPool),
      });
    }

    // 收集跟进验证候选（每表单最多 1 个，避免请求量过大）
    if (followupProbeRefs.length < 3 && !followupProbeRefs.some((r) => r.id === local.id)) {
      followupProbeRefs.push({ id: local.id, name: remoteName, recordRef: remote.record_ref });
    }
    // 收集客户截图 URL（只存 redact 前的原始串在内存，日志只打 redact 后路径）
    for (const u of arr(f.keyword_3)) {
      if (imageUrls.length < IMAGE_PROBE_COUNT && /^https?:\/\//.test(u)) imageUrls.push(u);
    }
  }
  return result;
}

interface FollowupMechanismAudit {
  filterSortPaginationOk: boolean;
  totalStableAcrossPages: boolean;
  pageSizes: number[];
  remoteTotalInWindow: number;
  belongToTypeRequested: boolean;
  belongToTypeReturned: boolean;
  chineseDataHasCustomerLabel: boolean;
  perCustomerProbes: Array<{
    customerId: string;
    customerName: string;
    remoteTotal: number;
    localCount: number;
    match: boolean;
  }>;
  conclusion: string;
}

async function auditFollowupMechanism(
  probeRefs: Array<{ id: string; name: string; recordRef: string }>,
  imageUrls: string[]
): Promise<FollowupMechanismAudit> {
  const result: FollowupMechanismAudit = {
    filterSortPaginationOk: false,
    totalStableAcrossPages: true,
    pageSizes: [],
    remoteTotalInWindow: 0,
    belongToTypeRequested: true,
    belongToTypeReturned: false,
    chineseDataHasCustomerLabel: false,
    perCustomerProbes: [],
    conclusion: "",
  };

  // 1) create_time gte 筛选 + asc 排序 + 游标翻 3 页，验证游标稳定、total 一致
  const since = "2026-10-01 00:00:00";
  let cursor: string | null = null;
  let firstTotal: number | null = null;
  let sawCreateTimeOrdered = true;
  let prevCreateTime = "";
  for (let pageIdx = 0; pageIdx < 3; pageIdx++) {
    const page = await searchRecords("follow_record", {
      byFormType: true,
      filters: [{ field: "create_time", operator: "gte", value: since }],
      sortField: "create_time",
      sortDirection: "asc",
      fields: ["belong_to_type", "content", "create_time", "update_time"],
      limit: 50,
      cursor,
    });
    result.pageSizes.push(page.items.length);
    if (firstTotal === null) {
      firstTotal = page.total;
      result.remoteTotalInWindow = page.total;
    } else if (page.total !== firstTotal) {
      result.totalStableAcrossPages = false;
    }
    for (const it of page.items) {
      const ct = String(it.data?.["创建时间"] ?? "");
      if (ct && prevCreateTime && ct < prevCreateTime) sawCreateTimeOrdered = false;
      if (ct) prevCreateTime = ct;
      // belong_to_type 实测：请求了 fields 后 data_by_field 是否含该 key 且有值
      const dbf = it.data_by_field ?? {};
      if (dbf.belong_to_type != null && dbf.belong_to_type !== "") result.belongToTypeReturned = true;
      if (it.data?.["关联客户"] || it.data?.["跟进对象"]) result.chineseDataHasCustomerLabel = true;
    }
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  result.filterSortPaginationOk = sawCreateTimeOrdered && result.pageSizes.length > 0;

  // 2) 按客户维度拉跟进，对比本地该客户跟进条数
  for (const probe of probeRefs) {
    const fp = await getCustomerFollowups(probe.recordRef, { limit: 20 });
    let remoteTotal = 0;
    for (const form of fp.forms) {
      remoteTotal += form.total ?? form.items.length;
      for (const item of form.items) {
        const pic = item.data?.["上传图片"];
        for (const u of arr(pic)) {
          if (imageUrls.length < IMAGE_PROBE_COUNT && /^https?:\/\//.test(u)) imageUrls.push(u);
        }
      }
    }
    const localRes = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM crm_follow_records WHERE customer_name_norm = $1`,
      [normalizeCustomerName(probe.name)]
    );
    const localCount = parseInt(localRes.rows[0]?.n ?? "0", 10);
    result.perCustomerProbes.push({
      customerId: probe.id,
      customerName: probe.name,
      remoteTotal,
      localCount,
      match: remoteTotal === localCount,
    });
  }

  result.conclusion = result.belongToTypeReturned
    ? "follow_record 表级增量可关联客户（belong_to_type 有返回值）——可按跟进表直接增量"
    : "follow_record 表级增量无法关联客户（belong_to_type 被静默丢弃）——只能按客户维度增量（crm_get_customer_followups）";
  return result;
}

interface ContactAudit {
  remoteTotal: number;
  localCount: number;
  sampled: number;
  customerNameResolvable: number;
  samples: Array<{ name: string; customer: string; customerExistsLocally: boolean }>;
}

async function auditContacts(): Promise<ContactAudit> {
  const firstPage = await searchRecords("customer_contact", { byFormType: true, limit: 1 });
  const remoteTotal = firstPage.total;
  const localRes = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_contacts`);
  const localCount = parseInt(localRes.rows[0]?.n ?? "0", 10);

  const result: ContactAudit = {
    remoteTotal,
    localCount,
    sampled: 0,
    customerNameResolvable: 0,
    samples: [],
  };

  let cursor: string | null = null;
  while (result.sampled < CONTACT_SAMPLE_SIZE) {
    const page = await searchRecords("customer_contact", { byFormType: true, limit: 50, cursor });
    for (const it of page.items) {
      if (result.sampled >= CONTACT_SAMPLE_SIZE) break;
      result.sampled++;
      const customer = strOrEmpty(it.data?.["客户"]);
      const name = strOrEmpty(it.data?.["姓名"]);
      let exists = false;
      if (customer) {
        const r = await pool.query(`SELECT 1 FROM crm_customers WHERE name = $1 LIMIT 1`, [customer]);
        exists = r.rows.length > 0;
      }
      if (exists) result.customerNameResolvable++;
      result.samples.push({ name, customer, customerExistsLocally: exists });
    }
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return result;
}

interface ImageProbe {
  urlPath: string; // redact 后的路径（无查询串）
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  signatureExpiresInSeconds: number | null;
  error: string | null;
}

async function probeImage(url: string): Promise<ImageProbe> {
  const probe: ImageProbe = {
    urlPath: redactUrl(url),
    httpStatus: null,
    contentType: null,
    contentLength: null,
    signatureExpiresInSeconds: null,
    error: null,
  };
  try {
    const expires = new URL(url).searchParams.get("Expires");
    if (expires) {
      probe.signatureExpiresInSeconds = parseInt(expires, 10) - Math.floor(Date.now() / 1000);
    }
  } catch {
    // 非标准 URL，忽略
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    probe.httpStatus = res.status;
    probe.contentType = res.headers.get("content-type");
    const len = res.headers.get("content-length");
    probe.contentLength = len ? parseInt(len, 10) : null;
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
  }
  return probe;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function main(): Promise<void> {
  if (!isCrmMcpConfigured()) {
    throw new Error("CRM_MCP_TOKEN 未配置，无法对账");
  }
  const startedAt = new Date();
  console.log(`[audit] 开始 CRM MCP 只读对账 ${startedAt.toISOString()}`);

  // a. 客户 4 表单
  const customerAudits: CustomerFormAudit[] = [];
  const followupProbeRefs: Array<{ id: string; name: string; recordRef: string }> = [];
  const imageUrls: string[] = [];
  for (const { customerType, formRef } of CUSTOMER_FORMS) {
    console.log(`[audit] 客户表单 ${customerType} ...`);
    const audit = await auditCustomerForm(customerType, formRef, followupProbeRefs, imageUrls);
    customerAudits.push(audit);
    console.log(
      `[audit]   remote=${fmt(audit.remoteTotal)} local=${fmt(audit.localCount)} ` +
        `抽样=${audit.sampled} 命中=${audit.found} 未命中=${audit.notFound} ` +
        `快照滞后差异=${audit.snapshotLagDiffs.length} nameNorm错误=${audit.nameNormMismatches.length}`
    );
  }

  // b. 跟进增量机制
  console.log(`[audit] 跟进记录增量机制验证 ...`);
  const followupAudit = await auditFollowupMechanism(followupProbeRefs, imageUrls);
  console.log(`[audit]   ${followupAudit.conclusion}`);

  // c. 联系人
  console.log(`[audit] 联系人 ...`);
  const contactAudit = await auditContacts();
  console.log(
    `[audit]   remote=${fmt(contactAudit.remoteTotal)} local=${fmt(contactAudit.localCount)} ` +
      `抽样=${contactAudit.sampled} 客户名可解析=${contactAudit.customerNameResolvable}`
  );

  // d. 图片可访问性
  console.log(`[audit] 图片可访问性（${imageUrls.length} 张抽样）...`);
  const imageProbes: ImageProbe[] = [];
  for (const u of imageUrls.slice(0, IMAGE_PROBE_COUNT)) {
    const p = await probeImage(u);
    imageProbes.push(p);
    console.log(
      `[audit]   ${p.urlPath.slice(-60)} -> ${p.httpStatus ?? p.error} ` +
        `${p.contentType ?? "-"} ${p.contentLength ?? "-"}B ` +
        `签名剩余=${p.signatureExpiresInSeconds ?? "-"}s`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    recordIdExtractFailures: getRecordIdExtractFailCount(),
    customers: customerAudits,
    followupMechanism: followupAudit,
    contacts: contactAudit,
    imageProbes,
  };

  const outDir = path.resolve(__dirname, "../../tmp/crm-mcp-audit");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `audit-${stamp}.json`);
  const mdPath = path.join(outDir, `audit-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));
  console.log(`[audit] 报告已写入 ${jsonPath} / ${mdPath}`);
}

function renderMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push(`# CRM MCP 只读对账报告`);
  lines.push(``);
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push(`- 耗时: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- record_ref 提取 ID 失败次数: ${report.recordIdExtractFailures}`);
  lines.push(``);
  lines.push(`## 客户表单 total 对比`);
  lines.push(``);
  lines.push(`| customer_type | 远端 total | 本地 count | 差值 | 抽样 | 命中 | 快照滞后差异 | name_norm 错误 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const c of report.customers) {
    lines.push(
      `| ${c.customerType} | ${c.remoteTotal} | ${c.localCount} | ${c.remoteTotal - c.localCount} | ${c.sampled} | ${c.found} | ${c.snapshotLagDiffs.length} | ${c.nameNormMismatches.length} |`
    );
  }
  lines.push(``);
  lines.push(`> Excel 快照早于 MCP 实时数据，owner_name / follow_status / is_in_pool 差异属预期内快照滞后，不算错误；name_norm 不一致是真错误。`);
  lines.push(``);
  for (const c of report.customers) {
    if (c.nameNormMismatches.length > 0) {
      lines.push(`### ${c.customerType} name_norm 不一致明细`);
      for (const d of c.nameNormMismatches) {
        lines.push(`- ${d.name} (${d.id}): 本地 \`${d.local}\` vs 远端 \`${d.remote}\``);
      }
      lines.push(``);
    }
    if (c.snapshotLagDiffs.length > 0) {
      lines.push(`### ${c.customerType} 快照滞后差异（${c.snapshotLagDiffs.length} 条，预期内）`);
      for (const d of c.snapshotLagDiffs.slice(0, 20)) {
        lines.push(`- ${d.name} (${d.id}) ${d.field}: 本地 \`${d.local}\` → 远端 \`${d.remote}\``);
      }
      if (c.snapshotLagDiffs.length > 20) lines.push(`- ... 其余 ${c.snapshotLagDiffs.length - 20} 条略`);
      lines.push(``);
    }
  }
  const f = report.followupMechanism;
  lines.push(`## 跟进记录增量机制`);
  lines.push(``);
  lines.push(`- create_time gte 筛选 + asc 排序 + 游标翻页: ${f.filterSortPaginationOk ? "OK" : "FAIL"}（页大小 ${f.pageSizes.join("/")}，窗口内 total=${f.remoteTotalInWindow}，total 跨页稳定=${f.totalStableAcrossPages}）`);
  lines.push(`- belong_to_type 已请求: ${f.belongToTypeRequested}，实际返回: ${f.belongToTypeReturned}（中文 data 含客户标识: ${f.chineseDataHasCustomerLabel}）`);
  lines.push(`- 按客户维度拉取（crm_get_customer_followups）:`);
  for (const p of f.perCustomerProbes) {
    lines.push(`  - ${p.customerName}: 远端 ${p.remoteTotal} vs 本地 ${p.localCount} ${p.match ? "✅" : "⚠️ 不一致"}`);
  }
  lines.push(`- **结论**: ${f.conclusion}`);
  lines.push(``);
  lines.push(`## 联系人`);
  lines.push(``);
  lines.push(`- 远端 total=${f0(report.contacts.remoteTotal)}，本地 count=${f0(report.contacts.localCount)}`);
  lines.push(`- 抽样 ${report.contacts.sampled} 条，「客户」字段值可在本地 crm_customers 按名称命中 ${report.contacts.customerNameResolvable} 条`);
  lines.push(``);
  lines.push(`## 图片可访问性`);
  lines.push(``);
  for (const p of report.imageProbes) {
    lines.push(
      `- ${p.urlPath.slice(-80)}: HTTP ${p.httpStatus ?? "ERR"}, ${p.contentType ?? "-"}, ${p.contentLength ?? "-"}B, 签名剩余 ${p.signatureExpiresInSeconds ?? "-"}s${p.error ? `, error=${p.error}` : ""}`
    );
  }
  lines.push(``);
  return lines.join("\n");
}

function f0(n: number): string {
  return fmt(n);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    if (err instanceof CrmMcpFatalError) {
      console.error(`[audit] 熔断停止: ${err.message}`);
    } else {
      console.error("[audit] 失败:", err);
    }
    pool.end().finally(() => process.exit(1));
  });
