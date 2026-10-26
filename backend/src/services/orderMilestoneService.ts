/**
 * OA 订单业务里程碑 V1（证据驱动）。
 *
 * 证据来源：新版钉钉 API（api.dingtalk.com/v1.0/workflow/processInstances）的
 * operationRecords + tasks。节点名取 operationRecords.showName（原文保留），
 * activityId 仅用于当次实例内关联 task，不作为跨版本稳定标识（模板编辑会换 id）。
 *
 * 识别规则（milestone-v1）：
 * - contract_received：节点「确认收到合同」最后一次执行为 AGREE；
 *   评论含「未回传合同」类否定时 confidence 降为 comment_negated（合同未回传特例）。
 * - erp_entered：任一 EXECUTE_TASK_NORMAL + AGREE 评论命中 ERP 规则 C
 *   （窄确认句式 + 子句级否定，不做整条评论全局否定过滤）。
 * - erp_pushed：节点「ERP下推发货单」/「ERP下推出发货单」最后一次执行为 AGREE。
 * - erp_closed：节点「关闭ERP订单」最后一次执行为 AGREE（仅老流程/部分流程有）。
 *
 * 有效性：OA 单最终状态为 TERMINATED 或 refuse 时，里程碑保留但 valid=false；
 * 节点重跑/转交时按该节点最后一次 EXECUTE_TASK_NORMAL 结果判定。
 *
 * 语义红线（展示层必须遵守）：
 * 合同接收 ≠ 盖章归档；ERP 录入确认 ≠ ERP 系统校验；下推 ≠ 实物出库；关闭 ≠ 履约完成。
 */

import { pool } from "../db";

export const MILESTONE_RULE_VERSION = "milestone-v1";

const NEW_API_BASE = "https://api.dingtalk.com";
let newTokenCache: { token: string; expiresAt: number } | null = null;

async function getNewApiToken(): Promise<string> {
  if (newTokenCache && newTokenCache.expiresAt > Date.now() + 60 * 1000) return newTokenCache.token;
  const res = await fetch(`${NEW_API_BASE}/v1.0/oauth2/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appKey: process.env.DINGTALK_APP_KEY,
      appSecret: process.env.DINGTALK_APP_SECRET,
    }),
  });
  const data: any = await res.json();
  if (!data.accessToken) throw new Error(`新版 API token 获取失败: ${JSON.stringify(data).slice(0, 120)}`);
  newTokenCache = { token: data.accessToken, expiresAt: Date.now() + (data.expireIn || 7200) * 1000 };
  return data.accessToken;
}

export interface OperationRecord {
  activityId?: string;
  showName?: string;
  type?: string;
  result?: string;
  userId?: string;
  date?: string; // ISO
  remark?: string;
  images?: unknown;
  [key: string]: unknown;
}

/** 新版 API 拉取单实例操作记录（含节点名 showName 与 activityId） */
export async function fetchOperationRecords(processInstanceId: string): Promise<OperationRecord[]> {
  const token = await getNewApiToken();
  const res = await fetch(
    `${NEW_API_BASE}/v1.0/workflow/processInstances?processInstanceId=${encodeURIComponent(processInstanceId)}`,
    { headers: { "x-acs-dingtalk-access-token": token } }
  );
  const data: any = await res.json();
  if (!data.result) {
    throw new Error(`workflow/processInstances 失败: ${JSON.stringify(data).slice(0, 120)}`);
  }
  return data.result.operationRecords || [];
}

// ERP 规则 C：窄确认句式 + 子句级否定（2026-10-20 标注 180 条样本 P=1.0 R=1.0）
const ERP_POS = /(已|已录|已入|已录入)\s*ERP|ERP\s*已(入|录|录入)/;
function erpClauseNegated(remark: string): boolean {
  const segs = remark.split(/[\n，。；;]/);
  return segs.some(
    (s) => /ERP/i.test(s) && /(未|没|还没|尚未|待).{0,4}录|录.{0,2}(失败|错)|重新录/.test(s)
  );
}
export function isErpConfirmedRemark(remark: string): boolean {
  return ERP_POS.test(remark) && !erpClauseNegated(remark);
}

// 合同否定子句（独立于 ERP 判定）
const CONTRACT_NEG = /未回传|没回传|未签|未收到合同|合同未/;

function parseOpTime(date?: string): Date | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface MilestoneEntry {
  at: string | null;
  node: string | null;
  operator_userid: string | null;
  remark_excerpt: string | null; // 脱敏摘要
  confidence: "node_confirmed" | "comment_confirmed" | "comment_negated";
}

export interface OrderMilestones {
  rule_version: string;
  final_status: { oa_status: string; oa_result: string | null; valid: boolean };
  items: {
    contract_received: MilestoneEntry | null;
    erp_entered: MilestoneEntry | null;
    erp_pushed: MilestoneEntry | null;
    erp_closed: MilestoneEntry | null;
  };
}

/** 数字脱敏（手机号/长编号），用于里程碑摘要展示 */
export function maskDigits(s: string): string {
  return s.replace(/1[0-9]{10}/g, "[手机号]").replace(/\d{5,}/g, (m) => m.slice(0, 2) + "***");
}

function lastExecAtNode(events: OperationRecord[], nodeNames: string[]): OperationRecord | null {
  const hits = events
    .filter((e) => e.type === "EXECUTE_TASK_NORMAL" && e.showName && nodeNames.includes(e.showName))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  return hits.length > 0 ? hits[hits.length - 1] : null;
}

/** 里程碑推导（纯函数，可重放） */
export function deriveMilestones(
  events: OperationRecord[],
  oaStatus: string,
  oaResult: string | null
): OrderMilestones {
  const finalValid = oaStatus !== "TERMINATED" && oaResult !== "refuse";
  const items: OrderMilestones["items"] = {
    contract_received: null,
    erp_entered: null,
    erp_pushed: null,
    erp_closed: null,
  };

  // contract_received：节点「确认收到合同」最后执行为 AGREE
  const contractNode = lastExecAtNode(events, ["确认收到合同"]);
  if (contractNode && contractNode.result === "AGREE") {
    const remark = String(contractNode.remark || "");
    items.contract_received = {
      at: contractNode.date || null,
      node: contractNode.showName || null,
      operator_userid: contractNode.userId || null,
      remark_excerpt: remark ? maskDigits(remark).slice(0, 80) : null,
      confidence: CONTRACT_NEG.test(remark) ? "comment_negated" : "node_confirmed",
    };
  }

  // erp_entered：最早的规则 C 命中（审批载体限定）
  const erpHits = events
    .filter(
      (e) =>
        e.type === "EXECUTE_TASK_NORMAL" &&
        e.result === "AGREE" &&
        e.remark &&
        isErpConfirmedRemark(String(e.remark))
    )
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  if (erpHits.length > 0) {
    const h = erpHits[0];
    items.erp_entered = {
      at: h.date || null,
      node: h.showName || null,
      operator_userid: h.userId || null,
      remark_excerpt: maskDigits(String(h.remark)).slice(0, 80),
      confidence: "comment_confirmed",
    };
  }

  // erp_pushed / erp_closed：节点最后一次执行为 AGREE
  const pushed = lastExecAtNode(events, ["ERP下推发货单", "ERP下推出发货单"]);
  if (pushed && pushed.result === "AGREE") {
    items.erp_pushed = {
      at: pushed.date || null,
      node: pushed.showName || null,
      operator_userid: pushed.userId || null,
      remark_excerpt: pushed.remark ? maskDigits(String(pushed.remark)).slice(0, 80) : null,
      confidence: "node_confirmed",
    };
  }
  const closed = lastExecAtNode(events, ["关闭ERP订单"]);
  if (closed && closed.result === "AGREE") {
    items.erp_closed = {
      at: closed.date || null,
      node: closed.showName || null,
      operator_userid: closed.userId || null,
      remark_excerpt: closed.remark ? maskDigits(String(closed.remark)).slice(0, 80) : null,
      confidence: "node_confirmed",
    };
  }

  return {
    rule_version: MILESTONE_RULE_VERSION,
    final_status: { oa_status: oaStatus, oa_result: oaResult, valid: finalValid },
    items,
  };
}

/** 事件落库（幂等）+ 里程碑派生回写 oa_orders.milestones */
export async function syncOrderEvents(processInstanceId: string): Promise<{ inserted: number; total: number }> {
  const records = await fetchOperationRecords(processInstanceId);
  const crypto = await import("crypto");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const r of records) {
      const idemKey = crypto
        .createHash("md5")
        .update(`${r.type || ""}|${r.date || ""}|${r.remark || ""}`)
        .digest("hex");
      const res = await client.query(
        `INSERT INTO oa_order_events
           (process_instance_id, idem_key, activity_id, node_name, operation_type, operation_result,
            operator_userid, operation_time, remark, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT ON CONSTRAINT uq_oa_order_events_idem DO NOTHING`,
        [
          processInstanceId,
          idemKey,
          r.activityId || null,
          r.showName || null,
          r.type || "UNKNOWN",
          r.result || null,
          r.userId || null,
          parseOpTime(r.date),
          r.remark || null,
          JSON.stringify(r),
        ]
      );
      inserted += res.rowCount || 0;
    }

    // 派生里程碑（规则升级时重放本函数即可，不删原始事件）
    const orderRes = await client.query(
      `SELECT oa_status, oa_result FROM oa_orders WHERE process_instance_id = $1`,
      [processInstanceId]
    );
    if (orderRes.rows.length > 0) {
      const milestones = deriveMilestones(records, orderRes.rows[0].oa_status, orderRes.rows[0].oa_result);
      // 事件行回写 milestone 归属（先清后标，重放幂等）
      await client.query(
        `UPDATE oa_order_events SET milestone = NULL, milestone_rule_version = NULL, confidence = NULL
         WHERE process_instance_id = $1`,
        [processInstanceId]
      );
      for (const [milestone, entry] of Object.entries(milestones.items)) {
        if (!entry) continue;
        // 同一事件可佐证多个里程碑（如评论确认 ERP 录入的那次 AGREE 同时是下推节点的完成动作），
        // milestone 列用逗号累加，不互相覆盖
        await client.query(
          `UPDATE oa_order_events
           SET milestone = CASE WHEN milestone IS NULL THEN $2
                                WHEN strpos(milestone, $2) > 0 THEN milestone
                                ELSE milestone || ',' || $2 END,
               milestone_rule_version = $3,
               confidence = CASE WHEN milestone IS NULL THEN $4
                                 WHEN strpos(milestone, $2) > 0 THEN confidence
                                 ELSE COALESCE(confidence || ',', '') || $4 END
           WHERE process_instance_id = $1
             AND node_name IS NOT DISTINCT FROM $5
             AND operation_time IS NOT DISTINCT FROM $6
             AND operation_type = 'EXECUTE_TASK_NORMAL'`,
          [processInstanceId, milestone, MILESTONE_RULE_VERSION, entry.confidence, entry.node, entry.at ? new Date(entry.at) : null]
        );
      }
      await client.query(
        `UPDATE oa_orders SET milestones = $2 WHERE process_instance_id = $1`,
        [processInstanceId, JSON.stringify(milestones)]
      );
    }
    await client.query("COMMIT");
    return { inserted, total: records.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
