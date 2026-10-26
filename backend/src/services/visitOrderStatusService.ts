/**
 * 外勤拜访 → OA 订单状态速览（admin-only，控制台时间线/地图详情卡的订单 Tag 数据源）。
 *
 * 关联口径（不建第二套订单判断体系，复用 orderCustomerMatch 的四态结论）：
 * - 可靠订单：oa_orders.customer_match_status IN (matched_by_verified_id, matched_by_exact_name)，
 *   且 customer_id 命中「拜访客户名 normalize 后精确命中的 CRM 客户」，
 *   或订单原始客户名 normalize 后与拜访客户名精确相等（仅限已 confirmed 的订单，不做模糊包含）。
 * - CRM 阶段/公海/负责人展示：拜访名 → CRM 客户走三层归并（精确 → 剥分支后缀 → 双向包含，
 *   与 cross/stuck 同口径，resolveCrmName），歧义不归并、维持「无 CRM」。
 * - 待核查：ambiguous / unmatched 订单的原始客户名 normalize 后与拜访客户名精确相等
 *   （只给中性「关联待核查」状态，不产生确定结论）。
 * - 占位客户名（虚拟客户/住址/公司等）直接跳过，不出现结果中。
 *
 * 语义红线：不使用「已成交/已交付/已回款」类文案；delivery_status=delivered 仅表示
 * 「交付资料较完整（待核实）」。OA 订单历史仅覆盖近 365 天，响应中给出 coverage_from。
 */

import { pool } from "../db";
import { normalizeCustomerName, splitRealCustomerNames } from "./normalization";
import { resolveCrmName } from "./customerMatch";

export interface OrderStatusOrderItem {
  process_instance_id: string;
  order_type: "direct" | "agent";
  match_status: string;
  oa_status: string;
  oa_result: string | null;
  delivery_status: string;
  oa_create_time: string | null;
  contract_received_at: string | null;
  erp_entered_at: string | null;
  erp_pushed_at: string | null;
  erp_closed_at: string | null;
}

export interface VisitOrderStatus {
  status: "has_orders" | "pending_review" | "no_orders";
  customer_id: string | null;
  customer_name: string | null;
  reliable_count: number;
  direct_count: number;
  agent_count: number;
  has_exact_name_match: boolean;
  candidate_count: number;
  orders: OrderStatusOrderItem[];
  // CRM 侧状态（2026-10-23 新增）：阶段为 CRM 原始值，可能与 OA 事实脱节
  crm_stage: string | null;
  crm_in_pool: boolean | null;
  crm_owner: string | null;
  // OA 有可靠订单但 CRM 阶段仍停留在早期（未更新）时置 true，仅提示不覆盖 CRM 原值
  stage_maybe_outdated: boolean;
}

interface OrderRow {
  process_instance_id: string;
  order_type: string;
  customer_name_raw: string | null;
  customer_id: string | null;
  customer_match_status: string;
  oa_status: string;
  oa_result: string | null;
  delivery_status: string;
  oa_create_time: Date | null;
  milestones: any;
}

interface CrmRow {
  id: string;
  name: string;
  name_norm: string;
  follow_status: string | null;
  is_in_pool: boolean;
  owner_name: string | null;
}

let cache: { loadedAt: number; orders: OrderRow[]; crm: CrmRow[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadData(): Promise<{ orders: OrderRow[]; crm: CrmRow[] }> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const [orderRes, crmRes] = await Promise.all([
    pool.query<OrderRow>(
      `SELECT process_instance_id, order_type, customer_name_raw, customer_id,
              customer_match_status, oa_status, oa_result, delivery_status,
              oa_create_time, milestones
       FROM oa_orders`
    ),
    pool.query<CrmRow>(`SELECT id, name, COALESCE(name_norm, '') AS name_norm, follow_status, is_in_pool, owner_name FROM crm_customers WHERE NOT COALESCE(is_deleted, false)`),
  ]);
  cache = { loadedAt: Date.now(), orders: orderRes.rows, crm: crmRes.rows };
  return cache;
}

const RELIABLE_STATUSES = new Set(["matched_by_verified_id", "matched_by_exact_name"]);
const MAX_ORDERS_PER_NAME = 10;

// CRM 阶段已到「有订单事实」的后期阶段；不在此列且有可靠订单时视为阶段可能滞后
const LATE_STAGES = new Set(["已发合同", "合同回传", "付款", "发货", "已经交付"]);

function milestoneAt(milestones: any, key: string): string | null {
  const entry = milestones?.items?.[key];
  return entry?.at || null;
}

function toOrderItem(o: OrderRow): OrderStatusOrderItem {
  return {
    process_instance_id: o.process_instance_id,
    order_type: o.order_type === "agent" ? "agent" : "direct",
    match_status: o.customer_match_status,
    oa_status: o.oa_status,
    oa_result: o.oa_result,
    delivery_status: o.delivery_status,
    oa_create_time: o.oa_create_time ? o.oa_create_time.toISOString() : null,
    contract_received_at: milestoneAt(o.milestones, "contract_received"),
    erp_entered_at: milestoneAt(o.milestones, "erp_entered"),
    erp_pushed_at: milestoneAt(o.milestones, "erp_pushed"),
    erp_closed_at: milestoneAt(o.milestones, "erp_closed"),
  };
}

export async function resolveVisitOrderStatus(
  rawNames: string[]
): Promise<{ results: Record<string, VisitOrderStatus>; coverage_from: string }> {
  // 与 splitRealCustomerNames 同口径：拆分 + 过滤占位名
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawNames.slice(0, 50)) {
    for (const n of splitRealCustomerNames(raw)) {
      if (!seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    }
  }

  const coverageFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const coverage_from = `${coverageFrom.getUTCFullYear()}-${String(coverageFrom.getUTCMonth() + 1).padStart(2, "0")}`;

  const results: Record<string, VisitOrderStatus> = {};
  if (names.length === 0) return { results, coverage_from };

  const { orders, crm } = await loadData();

  // CRM 精确命中索引：name_norm -> customers
  const crmByNorm = new Map<string, CrmRow[]>();
  for (const c of crm) {
    const norm = c.name_norm || normalizeCustomerName(c.name);
    if (!norm) continue;
    const arr = crmByNorm.get(norm) || [];
    arr.push(c);
    crmByNorm.set(norm, arr);
  }
  // 三层归并用的候选集（精确 → 剥分支后缀 → 双向包含，口径与 cross/stuck 一致）
  const crmNormCandidates = [...crmByNorm.keys()];

  // 订单按归一化客户名索引（仅精确相等，不做包含模糊）
  const ordersByNorm = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const norm = normalizeCustomerName(o.customer_name_raw);
    if (!norm) continue;
    const arr = ordersByNorm.get(norm) || [];
    arr.push(o);
    ordersByNorm.set(norm, arr);
  }

  for (const name of names) {
    const norm = normalizeCustomerName(name);
    // CRM 侧三层归并：精确落空再走剥后缀/双向包含；歧义（resolveCrmName 返回 null）维持无 CRM。
    // 注意：归并只影响 CRM 阶段/公海/负责人展示，订单关联仍按下方精确口径，不做模糊命中。
    const resolvedNorm = crmByNorm.has(norm) ? norm : resolveCrmName(norm, new Set(), crmNormCandidates);
    const crmHits = resolvedNorm ? crmByNorm.get(resolvedNorm) || [] : [];
    const crmIds = new Set(crmHits.map((c) => c.id));
    const nameOrders = ordersByNorm.get(norm) || [];

    // 可靠订单：已 confirmed（verified/exact）且 customer_id 命中精确 CRM 客户，
    // 或订单客户名与拜访名精确相等
    const reliable = orders.filter(
      (o) =>
        RELIABLE_STATUSES.has(o.customer_match_status) &&
        ((o.customer_id && crmIds.has(o.customer_id)) ||
          normalizeCustomerName(o.customer_name_raw) === norm)
    );
    const candidates = nameOrders.filter(
      (o) => !RELIABLE_STATUSES.has(o.customer_match_status)
    );

    const verifiedOrder = reliable.find((o) => o.customer_match_status === "matched_by_verified_id");
    const customerId =
      verifiedOrder?.customer_id || reliable.find((o) => o.customer_id)?.customer_id || crmHits[0]?.id || null;
    const customerName =
      (customerId && crm.find((c) => c.id === customerId)?.name) || crmHits[0]?.name || null;

    const status: VisitOrderStatus["status"] =
      reliable.length > 0 ? "has_orders" : candidates.length > 0 ? "pending_review" : "no_orders";

    const crmHit = (customerId && crm.find((c) => c.id === customerId)) || crmHits[0] || null;
    const crmStage = crmHit?.follow_status || null;
    const stageMaybeOutdated =
      reliable.length > 0 && (!crmStage || !LATE_STAGES.has(crmStage));

    results[name] = {
      status,
      customer_id: status === "has_orders" ? customerId : null,
      customer_name: customerName,
      reliable_count: reliable.length,
      direct_count: reliable.filter((o) => o.order_type !== "agent").length,
      agent_count: reliable.filter((o) => o.order_type === "agent").length,
      has_exact_name_match: reliable.some((o) => o.customer_match_status === "matched_by_exact_name"),
      candidate_count: candidates.length,
      orders: reliable.slice(0, MAX_ORDERS_PER_NAME).map(toOrderItem),
      crm_stage: crmStage,
      crm_in_pool: crmHit ? crmHit.is_in_pool : null,
      crm_owner: crmHit?.owner_name || null,
      stage_maybe_outdated: stageMaybeOutdated,
    };
  }

  return { results, coverage_from };
}
