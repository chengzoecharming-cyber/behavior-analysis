/**
 * 客户库（客户判断页）只读查询服务。
 *
 * 与 /crm-analytics 的聚合分析不同，这里面向「单个客户」：
 * - 列表：crm_customers 分页 + 关键词/类型/公私海/负责人/阶段筛选；
 * - 详情：客户基础信息 + 联系人 + CRM 跟进记录 + 实际拜访记录 + 派生判断信号。
 *
 * 关联口径：
 * - 联系人按 customer_name 与客户 name / name_norm 桥接（contacts 表无 customer_id，
 *   待 PRD-006 身份层落地后再改为 ID 关联，本次不做数据库迁移）；
 * - 跟进记录按 customer_name_norm 桥接，兼容历史行 customer_name_norm 为空时回退客户名匹配；
 * - 实际拜访复用 cross/stuck 的口径：visits 客户名 splitRealCustomerNames 拆占位名 →
 *   normalizeCustomerName → resolveCrmName 三层匹配到该客户的 name_norm，
 *   且排除 exclude_from_visit_count 的不计拜访行。
 *
 * 订单：接 OA 两张订单执行单（oa_orders，独立同步管线）。成交事实只认
 *   matched_by_verified_id（CRM instanceId 实证命中）与 matched_by_exact_name（名称精确命中，标注待复核）；
 *   ambiguous/unmatched 候选进入 unconfirmed_order_candidates 核查区块，不计成交。
 */

import { pool } from "../db";
import { splitRealCustomerNames, normalizeCustomerName } from "./normalization";
import { resolveCrmName } from "./customerMatch";
import { formatBeijingDate } from "../utils/timezone";

export interface CrmCustomerListParams {
  keyword?: string;
  customerType?: string;
  pool?: "pool" | "private";
  owner?: string;
  stage?: string;
  offset: number;
  limit: number;
}

export interface CrmCustomerListItem {
  id: string;
  name: string | null;
  customer_type: string | null;
  is_in_pool: boolean;
  follow_status: string | null;
  owner_name: string | null;
  region: string | null;
  channel: string | null;
  follow_times: number;
  latest_follow_up_time: string | null;
  process_status: string | null;
  created_time: string | null;
}

/** CRM 数据快照日期：最近一次手工导入批次时间（与 /crm-analytics/overview 同口径） */
async function loadSnapshotDate(): Promise<string | null> {
  const res = await pool.query<{ ts: Date | null }>(
    `SELECT MAX(created_at) AS ts FROM crm_import_batches`
  );
  return res.rows[0]?.ts ? formatBeijingDate(res.rows[0].ts) : null;
}

export async function listCustomers(params: CrmCustomerListParams) {
  const where: string[] = [`NOT COALESCE(is_deleted, false)`];
  const args: unknown[] = [];
  const push = (cond: string, val: unknown) => {
    args.push(val);
    where.push(cond.replace("?", `$${args.length}`));
  };

  if (params.keyword) {
    push(`name ILIKE '%' || ? || '%'`, params.keyword);
  }
  if (params.customerType) push(`customer_type = ?`, params.customerType);
  if (params.pool === "pool") where.push(`is_in_pool = true`);
  if (params.pool === "private") where.push(`is_in_pool = false`);
  if (params.owner) push(`owner_name = ?`, params.owner);
  if (params.stage) push(`follow_status = ?`, params.stage);

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const [countRes, listRes, snapshot, ownersRes, stagesRes] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_customers ${whereSql}`, args),
    pool.query(
      `SELECT id, name, customer_type, is_in_pool, follow_status, owner_name, region, channel,
              follow_times, latest_follow_up_time, process_status, created_time
       FROM crm_customers ${whereSql}
       ORDER BY COALESCE(latest_follow_up_time, created_time) DESC NULLS LAST, name
       OFFSET $${args.length + 1} LIMIT $${args.length + 2}`,
      [...args, params.offset, params.limit]
    ),
    loadSnapshotDate(),
    pool.query<{ owner_name: string }>(
      `SELECT DISTINCT owner_name FROM crm_customers WHERE NOT COALESCE(is_deleted, false) AND owner_name IS NOT NULL AND owner_name <> '' ORDER BY owner_name`
    ),
    pool.query<{ follow_status: string }>(
      `SELECT DISTINCT follow_status FROM crm_customers WHERE NOT COALESCE(is_deleted, false) AND follow_status IS NOT NULL AND follow_status <> '' ORDER BY follow_status`
    ),
  ]);

  return {
    total: parseInt(countRes.rows[0].n, 10),
    list: listRes.rows as CrmCustomerListItem[],
    snapshot_date: snapshot,
    owner_options: ownersRes.rows.map((r) => r.owner_name),
    stage_options: stagesRes.rows.map((r) => r.follow_status),
  };
}

interface CustomerRow {
  id: string;
  customer_type: string | null;
  is_in_pool: boolean;
  name: string | null;
  name_norm: string | null;
  legal_person: string | null;
  address: string | null;
  install_address: string | null;
  region: string | null;
  tags: string[] | null;
  follow_status: string | null;
  channel: string | null;
  competitor: string | null;
  owner_name: string | null;
  follow_times: number;
  latest_follow_up_time: Date | null;
  recycle_time: Date | null;
  process_status: string | null;
  process_result: string | null;
  last_owner: string | null;
  return_pool_time: Date | null;
  return_pool_reason: string | null;
  return_pool_times: number | null;
  extra: Record<string, unknown> | null;
  created_time: Date | null;
  updated_time: Date | null;
}

export interface CustomerVisitItem {
  visit_id: number;
  time: string;
  user_name: string;
  matched_name: string;
  address: string | null;
  location_name: string | null;
}

export async function getCustomerDetail(id: string) {
  const custRes = await pool.query<CustomerRow>(
    `SELECT * FROM crm_customers WHERE id = $1`,
    [id]
  );
  const customer = custRes.rows[0];
  if (!customer) return null;

  const nameNorm = customer.name_norm || normalizeCustomerName(customer.name);

  // 联系人：contacts 只有 customer_name 文本字段；取同一 name_norm 下全部 CRM 名称变体桥接，
  // 避免同一客户在代理商/企业客户等多条 CRM 记录间漏取联系人
  const nameVariantsRes = await pool.query<{ name: string | null }>(
    `SELECT DISTINCT name FROM crm_customers
     WHERE name_norm = $1 AND NOT COALESCE(is_deleted, false) AND name IS NOT NULL AND name <> ''`,
    [nameNorm]
  );
  const contactNames = Array.from(
    new Set(
      [customer.name, ...nameVariantsRes.rows.map((r) => r.name)].filter(
        (v): v is string => !!v
      )
    )
  );
  const contactsPromise =
    contactNames.length > 0
      ? pool.query(
          `SELECT id, customer_name, name, phone, position, is_decision_maker, owner_name, created_time
           FROM crm_contacts
           WHERE customer_name = ANY($1)
           ORDER BY created_time DESC NULLS LAST`,
          [contactNames]
        )
      : Promise.resolve({ rows: [] });

  // 跟进记录：优先 customer_name_norm 桥接，空值行回退客户名归一化比较
  const followsPromise = pool.query(
    `SELECT id, customer_name, follow_type, content, picture, create_user_name, create_time
     FROM crm_follow_records
     WHERE (customer_name_norm IS NOT NULL AND customer_name_norm <> '' AND customer_name_norm = $1)
        OR ((customer_name_norm IS NULL OR customer_name_norm = '') AND customer_name = $2)
     ORDER BY create_time DESC NULLS LAST
     LIMIT 200`,
    [nameNorm, customer.name]
  );

  // 实际拜访：全表扫描 visits 客户名，拆分归一化后用 resolveCrmName 归并到本客户 name_norm。
  // 与 /crm-analytics/cross、stuck 同一套口径，排除占位名与不计拜访行。
  const visitsPromise = (async (): Promise<CustomerVisitItem[]> => {
    const allCrm = await pool.query<{ name_norm: string }>(
      `SELECT DISTINCT name_norm FROM crm_customers WHERE NOT COALESCE(is_deleted, false) AND name_norm IS NOT NULL AND name_norm <> ''`
    );
    const crmNorms = allCrm.rows.map((r) => r.name_norm);
    const crmNormSet = new Set(crmNorms);

    const res = await pool.query<{
      id: number; ts: Date; user_name: string; customer_name: string;
      address: string | null; location_name: string | null;
    }>(
      `SELECT id, "timestamp" AS ts, user_name, customer_name, address, location_name
       FROM visits
       WHERE customer_name IS NOT NULL AND NOT exclude_from_visit_count
       ORDER BY "timestamp" DESC`
    );
    const out: CustomerVisitItem[] = [];
    for (const row of res.rows) {
      for (const name of splitRealCustomerNames(row.customer_name)) {
        const norm = normalizeCustomerName(name);
        if (!norm) continue;
        if (resolveCrmName(norm, crmNormSet, crmNorms) !== nameNorm) continue;
        out.push({
          visit_id: row.id,
          time: row.ts.toISOString(),
          user_name: row.user_name,
          matched_name: name,
          address: row.address,
          location_name: row.location_name,
        });
        break; // 同一行只计一次到本客户
      }
      if (out.length >= 200) break;
    }
    return out;
  })();

  const [contacts, follows, visits, snapshot, orderBlock] = await Promise.all([
    contactsPromise,
    followsPromise,
    visitsPromise,
    loadSnapshotDate(),
    loadCustomerOrders(id, customer.name),
  ]);

  const now = Date.now();
  const DAY = 86400 * 1000;
  const followCount = follows.rows.length;
  const visitCount = visits.length;
  const lastFollowTime = follows.rows[0]?.create_time
    ? (follows.rows[0].create_time as Date).toISOString()
    : customer.latest_follow_up_time?.toISOString() ?? null;
  const lastVisitTime = visits[0]?.time ?? null;

  const relation =
    followCount > 0 && visitCount > 0
      ? "both"
      : followCount > 0
      ? "follow_only"
      : visitCount > 0
      ? "visit_only"
      : "none";

  const insights = {
    follow_count: followCount,
    visit_count: visitCount,
    last_follow_time: lastFollowTime,
    last_visit_time: lastVisitTime,
    relation,
    no_follow_30d: !lastFollowTime || now - new Date(lastFollowTime).getTime() > 30 * DAY,
    no_visit_30d: !lastVisitTime || now - new Date(lastVisitTime).getTime() > 30 * DAY,
    approving: customer.process_status === "审批中",
  };

  return {
    customer,
    contacts: contacts.rows,
    follow_records: follows.rows,
    visits,
    insights,
    orders: orderBlock.orders,
    orders_status: orderBlock.status,
    unconfirmed_order_candidates: orderBlock.unconfirmedCandidates,
    orders_history_since: orderBlock.historySince,
    snapshot_date: snapshot,
  };
}

export type OrdersStatus =
  | "pending_oa_sync" // 订单同步未配置/未接入
  | "synced_with_orders" // 已同步且当前客户有可靠关联订单
  | "synced_no_orders" // 已同步但当前客户无可靠关联订单
  | "has_unconfirmed_candidates"; // 存在无法确认关联的候选订单（优先展示此态）

interface OrderRow {
  id: number;
  process_instance_id: string;
  order_type: "direct" | "agent";
  role: "customer" | "agent";
  contract_entity: string | null;
  contract_no_raw: string | null;
  contract_nos: string[] | null;
  demand_type: string | null;
  order_note: string | null;
  agent_name_raw: string | null;
  agent_delivery_progress: string | null;
  factory_region: string | null;
  delivery_address_raw: string | null;
  logistics_note: string | null;
  installer_name: string | null;
  delivery_date: string | null;
  delivery_service_note: string | null;
  oa_status: string;
  oa_result: string | null;
  delivery_status: string;
  delivery_status_basis: string | null;
  crm_status_snapshot: string | null;
  customer_name_raw: string | null;
  customer_match_status: string;
  originator_name: string | null;
  originator_dept: string | null;
  oa_create_time: string | null;
  oa_finish_time: string | null;
  synced_at: string;
  contract_attachments: unknown;
  requirement_attachments: unknown;
  delivery_photos: unknown;
  acceptance_attachments: unknown;
  items: unknown;
}

/** 订单块：可靠关联订单 + 未确认候选（admin-only 页面；成交事实只认 verified/exact） */
async function loadCustomerOrders(customerId: string, customerName: string | null): Promise<{
  orders: OrderRow[];
  status: OrdersStatus;
  unconfirmedCandidates: unknown[];
  historySince: string | null;
}> {
  // 订单同步未配置（未接入）时保持原占位状态
  const { getOrderProcessCodes } = await import("./dingtalk");
  if (getOrderProcessCodes().length === 0) {
    return { orders: [], status: "pending_oa_sync", unconfirmedCandidates: [], historySince: null };
  }

  // 历史回拉上限（钉钉 listids 365 天硬限制）
  const syncInfo = await pool.query<{ min_create: Date | null }>(
    `SELECT MIN(oa_create_time) AS min_create FROM oa_orders`
  );
  const historySince = syncInfo.rows[0]?.min_create
    ? formatBeijingDate(syncInfo.rows[0].min_create)
    : null;

  // 可靠关联：该客户作为终端客户或代理商，且匹配套路为 verified/exact
  const ordersRes = await pool.query(
    `SELECT o.*,
       CASE WHEN o.customer_id = $1 THEN 'customer' ELSE 'agent' END AS role,
       COALESCE(
         (SELECT json_agg(json_build_object(
            'product_category', i.product_category,
            'product_key', i.product_key,
            'quantity', i.quantity,
            'extra', i.extra
          ) ORDER BY i.id) FROM oa_order_items i WHERE i.order_id = o.id),
         '[]'::json
       ) AS items
     FROM oa_orders o
     WHERE (o.customer_id = $1 AND o.customer_match_status IN ('matched_by_verified_id', 'matched_by_exact_name'))
        OR (o.agent_customer_id = $1 AND o.agent_match_status = 'matched_by_exact_name')
     ORDER BY o.oa_create_time DESC NULLS LAST`,
    [customerId]
  );

  // 未确认候选：ambiguous/unmatched 单中名称模糊命中该客户的（供核查，不计成交）
  const nameNorm = normalizeCustomerName(customerName);
  let unconfirmedCandidates: unknown[] = [];
  if (nameNorm) {
    const cand = await pool.query(
      `SELECT id, process_instance_id, order_type, customer_name_raw, agent_name_raw,
              customer_match_status, customer_match_candidates, agent_match_candidates,
              contract_no_raw, oa_status, oa_create_time, originator_name
       FROM oa_orders
       WHERE customer_id IS NULL
         AND customer_match_status IN ('ambiguous', 'unmatched')
         AND customer_name_raw IS NOT NULL AND customer_name_raw <> ''
         AND (customer_name_raw ILIKE '%' || $1 || '%' OR POSITION(customer_name_raw IN $1) > 0)
       ORDER BY oa_create_time DESC NULLS LAST
       LIMIT 50`,
      [customerName]
    );
    // 过滤掉过短的包含误配（名称 < 4 字不做包含候选）
    unconfirmedCandidates = cand.rows.filter(
      (r: any) => (r.customer_name_raw || "").length >= 4 && nameNorm.length >= 4
    );
  }

  const status: OrdersStatus =
    unconfirmedCandidates.length > 0
      ? "has_unconfirmed_candidates"
      : ordersRes.rows.length > 0
      ? "synced_with_orders"
      : "synced_no_orders";

  return {
    orders: ordersRes.rows as OrderRow[],
    status,
    unconfirmedCandidates,
    historySince,
  };
}
