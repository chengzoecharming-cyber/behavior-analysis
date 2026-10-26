/**
 * OA 订单 → CRM 客户关联状态机（计划 E 节，2026-10-20 实测验证）。
 *
 * 四态：
 * - matched_by_verified_id：OA OpenDataField 内嵌 CRM instanceId 精确命中 crm_customers.id。
 *   唯一自动确认通道（已抽样实证同源，40 单 0 冲突）。
 * - matched_by_exact_name：instanceId 未命中时，normalizeCustomerName 后精确唯一命中。
 *   写入 customer_id 但页面标注「名称匹配待复核」，CRM 快照更新后可被 ID 通道升级。
 * - ambiguous：规则归并（去分支后缀/双向包含）产生候选。不写 customer_id，不计成交，
 *   候选依据存 customer_match_candidates 供人工核查。
 * - unmatched：无任何候选。
 *
 * 重匹配只升级不降级：matched_by_verified_id 行永不被名称匹配改写。
 *
 * 代理商（agent_name_raw）走同套逻辑但无 instanceId 通道（表单里代理商是纯文本，
 * 且存在简称「楚联」「四川博尔特」——模糊匹配一律 ambiguous，保留候选依据）。
 */

import { Pool } from "pg";
import { normalizeCustomerName } from "./normalization";
import { stripBranchSuffix, findContainmentMatch } from "./customerMatch";

export type MatchStatus = "matched_by_verified_id" | "matched_by_exact_name" | "ambiguous" | "unmatched";

export interface MatchCandidate {
  id: string;
  name: string;
  rule: "branch_stripped" | "containment";
}

export interface MatchResult {
  status: MatchStatus;
  customerId: string | null;
  candidates: MatchCandidate[] | null;
}

interface CrmCustomerRow {
  id: string;
  name: string;
  name_norm: string;
}

let cache: { loadedAt: number; rows: CrmCustomerRow[]; byNorm: Map<string, CrmCustomerRow> } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 加载 CRM 客户快照（10 分钟缓存；CRM Excel 导入后调用 invalidateCrmCache） */
async function loadCrmCustomers(pool: Pool): Promise<{ rows: CrmCustomerRow[]; byNorm: Map<string, CrmCustomerRow> }> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const res = await pool.query(`SELECT id, name, COALESCE(name_norm, '') AS name_norm FROM crm_customers WHERE NOT COALESCE(is_deleted, false)`);
  const rows: CrmCustomerRow[] = res.rows;
  const byNorm = new Map<string, CrmCustomerRow>();
  for (const r of rows) {
    const norm = r.name_norm || normalizeCustomerName(r.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, r);
  }
  cache = { loadedAt: Date.now(), rows, byNorm };
  return cache;
}

export function invalidateCrmCache(): void {
  cache = null;
}

/**
 * 匹配一个名称到 CRM 客户。
 * @param instanceId OA 内嵌 CRM instanceId（代理商名无此通道，传 null）
 */
export async function matchCustomer(
  pool: Pool,
  rawName: string | null,
  instanceId: string | null
): Promise<MatchResult> {
  // 1. ID 通道（已实证同源，直接确认）
  if (instanceId) {
    const hit = await pool.query(`SELECT id FROM crm_customers WHERE id = $1 AND NOT COALESCE(is_deleted, false)`, [instanceId]);
    if (hit.rows.length > 0) {
      return { status: "matched_by_verified_id", customerId: hit.rows[0].id, candidates: null };
    }
  }

  const norm = normalizeCustomerName(rawName);
  if (!norm) return { status: "unmatched", customerId: null, candidates: null };

  const { rows, byNorm } = await loadCrmCustomers(pool);

  // 2. 名称精确唯一命中
  const exact = byNorm.get(norm);
  if (exact) {
    return { status: "matched_by_exact_name", customerId: exact.id, candidates: null };
  }

  // 3. 规则归并 → 只产出候选，一律 ambiguous，不自动确认
  const candidates: MatchCandidate[] = [];
  const seen = new Set<string>();

  const stripped = stripBranchSuffix(norm);
  if (stripped !== norm) {
    const hit = byNorm.get(stripped);
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      candidates.push({ id: hit.id, name: hit.name, rule: "branch_stripped" });
    }
  }

  const allNorms = rows.map((r) => r.name_norm || normalizeCustomerName(r.name));
  const containmentNorm = findContainmentMatch(norm, allNorms);
  if (containmentNorm) {
    const hit = byNorm.get(containmentNorm);
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      candidates.push({ id: hit.id, name: hit.name, rule: "containment" });
    }
  } else {
    // findContainmentMatch 对并列最长返回 null，这里补充收集所有等长包含候选作为歧义依据
    for (const r of rows) {
      const cNorm = r.name_norm || normalizeCustomerName(r.name);
      if (!cNorm || cNorm === norm || seen.has(r.id)) continue;
      const short = norm.length <= cNorm.length ? norm : cNorm;
      const long = norm.length <= cNorm.length ? cNorm : norm;
      if (short.length >= 4 && long.includes(short)) {
        seen.add(r.id);
        candidates.push({ id: r.id, name: r.name, rule: "containment" });
        if (candidates.length >= 5) break;
      }
    }
  }

  if (candidates.length > 0) {
    return { status: "ambiguous", customerId: null, candidates };
  }
  return { status: "unmatched", customerId: null, candidates: null };
}
