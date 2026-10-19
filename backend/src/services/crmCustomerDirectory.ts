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
 * 订单：第一版不接 OA 订单同步，详情固定返回 orders: [] + orders_status: "pending_oa_sync"，
 * 让前端结构先稳定，不展示假订单。
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
  const where: string[] = [];
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
      `SELECT DISTINCT owner_name FROM crm_customers WHERE owner_name IS NOT NULL AND owner_name <> '' ORDER BY owner_name`
    ),
    pool.query<{ follow_status: string }>(
      `SELECT DISTINCT follow_status FROM crm_customers WHERE follow_status IS NOT NULL AND follow_status <> '' ORDER BY follow_status`
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
     WHERE name_norm = $1 AND name IS NOT NULL AND name <> ''`,
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
      `SELECT DISTINCT name_norm FROM crm_customers WHERE name_norm IS NOT NULL AND name_norm <> ''`
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

  const [contacts, follows, visits, snapshot] = await Promise.all([
    contactsPromise,
    followsPromise,
    visitsPromise,
    loadSnapshotDate(),
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
    // 订单预留：OA 订单同步接入前固定为空数组
    orders: [] as unknown[],
    orders_status: "pending_oa_sync" as const,
    snapshot_date: snapshot,
  };
}
