/**
 * 探迹 CRM MCP 只读客户端（streamable-http，JSON-RPC over SSE）。
 *
 * 边界：只封装 4 个只读工具（crm_list_forms / crm_search_records /
 * crm_aggregate_records / crm_get_customer_followups），不封装任何写工具。
 *
 * - 全局 fetch，POST 到 CRM_MCP_URL，头 Content-Type: application/json、
 *   Accept: application/json, text/event-stream、Authorization: Bearer <CRM_MCP_TOKEN>；
 * - 响应为 SSE 文本（event: message\ndata: {...}），解析 data: 行的 JSON-RPC result，
 *   业务结果在 result.content[0].text 里再 JSON.parse 一次；
 * - 限流：模块级节流，任意两次请求间隔 ≥ 300ms；
 * - 失败停止：连续 2 次请求失败（网络/HTTP/解析/JSON-RPC error）即抛 CrmMcpFatalError，
 *   调用方应整体停止，不做重试风暴；
 * - 日志红线：绝不打印 URL 查询串（图片签名参数）与 token；redactUrl() 截到 ? 之前。
 */

export function getCrmMcpUrl(): string {
  return process.env.CRM_MCP_URL || "https://dingcrm.eapps.dingtalkcloud.com/open/mcp/v1/";
}

export function isCrmMcpConfigured(): boolean {
  return !!process.env.CRM_MCP_TOKEN;
}

/** 日志安全化：截掉 URL 查询串（签名参数），绝不输出完整签名 URL */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

export class CrmMcpFatalError extends Error {}

const REQUEST_TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 300;
const MAX_CONSECUTIVE_FAILURES = 2;

let rpcId = 0;
let lastRequestAt = 0;
let consecutiveFailures = 0;

async function throttle(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function onRequestFailure(err: unknown): never {
  // 记录级权限拒绝（无查看权限/记录不存在）是预期内的逐条跳过，不计入全局连续失败
  const msg = err instanceof Error ? err.message : String(err);
  const benign = msg.includes("CRM_RECORD_NOT_FOUND") || msg.includes("无查看权限");
  if (benign) throw err instanceof Error ? err : new Error(msg);
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    throw new CrmMcpFatalError(
      `[crmMcp] 连续 ${consecutiveFailures} 次请求失败，整体停止（不重试）。最近错误: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** 调用 MCP 只读工具，返回 result.content[0].text JSON.parse 后的业务结果 */
async function callTool(name: string, args: Record<string, unknown>, isRetry = false): Promise<any> {
  const token = process.env.CRM_MCP_TOKEN;
  if (!token) throw new CrmMcpFatalError("[crmMcp] CRM_MCP_TOKEN 未配置");

  await throttle();
  lastRequestAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(getCrmMcpUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
        signal: controller.signal,
      });
      // 注意：streamable-http 服务端可能保持 SSE 长连接，body 读取也必须覆盖在超时内
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) {
      throw new Error(`响应无 SSE data 行: ${text.slice(0, 200)}`);
    }
    const rpc: JsonRpcResponse = JSON.parse(dataLine.slice(5).trim());
    if (rpc.error) {
      throw new Error(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
    }
    const content = rpc.result?.content?.[0]?.text;
    if (content == null) {
      throw new Error(`响应无 content text: ${JSON.stringify(rpc.result ?? null).slice(0, 200)}`);
    }
    try {
      const parsed = JSON.parse(content);
      consecutiveFailures = 0; // 成功后清零连续失败计数
      return parsed;
    } catch {
      // MCP 参数校验失败等场景直接返回纯文本错误
      throw new Error(`工具 ${name} 返回非 JSON: ${content.slice(0, 300)}`);
    }
  } catch (err) {
    // 超时/中止类瞬时错误先重试一次（间隔 1s），重试失败才计入连续失败
    const isAbort =
      (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) ||
      false;
    if (isAbort && !isRetry) {
      await new Promise((r) => setTimeout(r, 1000));
      return callTool(name, args, true);
    }
    onRequestFailure(err);
  }
}

function unwrap<T>(r: any, toolName: string): T {
  if (!r?.success) {
    throw new Error(`[crmMcp] ${toolName} 失败: ${JSON.stringify(r).slice(0, 300)}`);
  }
  return r.data as T;
}

// ---------- 4 个只读工具 ----------

export interface CrmFormInfo {
  form_ref: string;
  form_type: string;
  form_name: string;
  category: string;
  form_status: string;
}

export async function listForms(): Promise<CrmFormInfo[]> {
  const r = await callTool("crm_list_forms", { limit: 50 });
  return unwrap<{ items: CrmFormInfo[] }>(r, "crm_list_forms").items ?? [];
}

export interface CrmFilter {
  field: string;
  operator: "eq" | "ne" | "in" | "not_in" | "contains" | "gte" | "lte" | "empty" | "not_empty" | "exists";
  value?: unknown;
}

export interface CrmSearchItem {
  record_ref: string;
  data: Record<string, unknown>;
  /** 仅在请求里传了 fields 时返回，key 为字段 key（否则 data 只有中文显示名） */
  data_by_field?: Record<string, unknown>;
}

export interface CrmSearchPage {
  items: CrmSearchItem[];
  total: number;
  has_more: boolean;
  next_cursor: string | null;
}

export async function searchRecords(
  formRefOrType: string,
  opts: {
    byFormType?: boolean;
    filters?: CrmFilter[];
    sortField?: string;
    sortDirection?: "asc" | "desc";
    fields?: string[];
    keyword?: string;
    cursor?: string | null;
    limit?: number;
  } = {}
): Promise<CrmSearchPage> {
  const args: Record<string, unknown> = { limit: opts.limit ?? 50 };
  if (opts.byFormType) args.form_type = formRefOrType;
  else args.form_ref = formRefOrType;
  if (opts.filters?.length) args.filters = opts.filters;
  if (opts.sortField) args.sort = { field: opts.sortField, direction: opts.sortDirection ?? "asc" };
  if (opts.fields?.length) args.fields = opts.fields;
  if (opts.keyword) args.keyword = opts.keyword;
  if (opts.cursor) args.cursor = opts.cursor;
  const d = unwrap<any>(await callTool("crm_search_records", args), "crm_search_records");
  return {
    items: d?.items ?? [],
    total: d?.total ?? 0,
    has_more: !!d?.has_more,
    next_cursor: d?.next_cursor ?? null,
  };
}

/** 游标分页生成器（limit=50）：以 has_more/next_cursor 为准，透传截断语义 */
export async function* searchAll(
  formRefOrType: string,
  opts: Parameters<typeof searchRecords>[1] = {}
): AsyncGenerator<CrmSearchItem, void, unknown> {
  let cursor: string | null = opts.cursor ?? null;
  for (;;) {
    const page = await searchRecords(formRefOrType, { ...opts, limit: 50, cursor });
    for (const item of page.items) yield item;
    if (!page.has_more || !page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

export interface CrmAggregateMetric {
  operation: "count" | "sum" | "avg" | "min" | "max";
  field: string;
  name?: string;
}

export async function aggregateRecords(
  formRefOrType: string,
  metrics: CrmAggregateMetric[],
  opts: { byFormType?: boolean; filters?: CrmFilter[] } = {}
): Promise<any> {
  const args: Record<string, unknown> = { metrics };
  if (opts.byFormType) args.form_type = formRefOrType;
  else args.form_ref = formRefOrType;
  if (opts.filters?.length) args.filters = opts.filters;
  return unwrap<any>(await callTool("crm_aggregate_records", args), "crm_aggregate_records");
}

export interface CrmFollowupsPage {
  /** 每个元素对应一个跟进表单（当前观测为单「跟进记录」表单） */
  forms: Array<{ form_name: string; total: number; items: Array<{ data: Record<string, unknown> }> }>;
  next_form_cursors: Record<string, string> | null;
}

export async function getCustomerFollowups(
  customerRecordRef: string,
  opts: { limit?: number; formCursors?: Record<string, string> | null } = {}
): Promise<CrmFollowupsPage> {
  const args: Record<string, unknown> = {
    customer_record_ref: customerRecordRef,
    limit: opts.limit ?? 20,
  };
  if (opts.formCursors) args.form_cursors = opts.formCursors;
  const d = unwrap<any>(await callTool("crm_get_customer_followups", args), "crm_get_customer_followups");
  return { forms: d?.items ?? [], next_form_cursors: d?.next_form_cursors ?? null };
}

// ---------- record_ref 解码 ----------

let extractFailCount = 0;

export function getRecordIdExtractFailCount(): number {
  return extractFailCount;
}

/**
 * 从 record_ref 提取 24 位 hex CRM 记录 ID（与 OA relateId 解码的 instanceId 同源）。
 * 去 'crm_ref_v2_' 前缀 → base64url 解码；前缀是 JSON 数组字符串
 * （如 ["r","customer_enterprise","<form_id>","<24位hex记录ID>"]），后面可能跟签名二进制，
 * 所以只从 JSON 前缀文本里用正则取最后一个 24-hex 段。失败返回 null 并计数。
 */
export function extractRecordId(recordRef: string): string | null {
  try {
    const buf = Buffer.from(recordRef.replace(/^crm_ref_v2_/, ""), "base64url");
    const jsonEnd = buf.indexOf("]");
    const prefix = buf.toString("utf8", 0, jsonEnd >= 0 ? jsonEnd : Math.min(buf.length, 256));
    const matches = prefix.match(/[0-9a-f]{24}/g);
    if (matches && matches.length > 0) return matches[matches.length - 1];
  } catch {
    // fall through
  }
  extractFailCount++;
  return null;
}
