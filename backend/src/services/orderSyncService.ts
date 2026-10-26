/**
 * OA 订单执行单同步管线（与拜访同步严格隔离）。
 *
 * - 独立入口 syncOrders，复用 getApprovalInstances / getApprovalDetail / saveRawApproval；
 * - 订单解析产物只进 oa_orders / oa_order_items，绝不进 visits，不触发派生数据重算；
 * - locked_approvals 同样生效；
 * - 解析失败的单降级最小落库（不丢单、可重解析），计入窗口 detail_fail；
 * - 每个时间窗口写 oa_order_sync_windows 对账（listed vs detail_ok/fail）。
 */

import { pool } from "../db";
import { getApprovalInstances, getApprovalDetail, saveRawApproval } from "./dingtalk";
import { parseOrderExecution, ParsedOrder, ORDER_PARSE_VERSION } from "./orderExecutionParser";
import { matchCustomer } from "./orderCustomerMatch";

const DETAIL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLockedApprovalIds(): Promise<Set<string>> {
  try {
    const result = await pool.query(`SELECT approval_id FROM locked_approvals`);
    return new Set(result.rows.map((r: any) => r.approval_id));
  } catch {
    return new Set();
  }
}

export async function upsertOrder(parsed: ParsedOrder): Promise<{ orderId: number; changed: boolean }> {
  const match = await matchCustomer(pool, parsed.customerNameRaw, parsed.crmInstanceId);
  let agentMatch: { status: string; customerId: string | null; candidates: any } = {
    status: "unmatched",
    customerId: null,
    candidates: null,
  };
  if (parsed.orderType === "agent" && parsed.agentNameRaw) {
    // 代理商无 instanceId 通道，只能名称匹配；模糊候选一律 ambiguous
    agentMatch = await matchCustomer(pool, parsed.agentNameRaw, null);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `INSERT INTO oa_orders (
        process_instance_id, business_id, process_code, order_type,
        customer_name_raw, crm_instance_id, customer_id, customer_match_status,
        customer_match_candidates, customer_matched_at,
        agent_name_raw, agent_customer_id, agent_match_status, agent_match_candidates,
        contract_entity, contract_no_raw, contract_nos, factory_region, demand_type,
        radio_module_removed, order_note, agent_delivery_progress, custom_review_ref,
        delivery_address_raw, logistics_note, installer_name, installer_userid,
        delivery_date, delivery_service_note,
        contract_attachments, requirement_attachments, jjy_attachments, delivery_photos, acceptance_attachments,
        oa_status, oa_result, delivery_status, delivery_status_basis, crm_status_snapshot,
        originator_userid, originator_name, originator_dept, oa_create_time, oa_finish_time,
        form_json, parse_version, synced_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,now(),
        $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
        $29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,now()
      )
      ON CONFLICT (process_instance_id) DO UPDATE SET
        business_id = EXCLUDED.business_id,
        process_code = EXCLUDED.process_code,
        order_type = EXCLUDED.order_type,
        customer_name_raw = EXCLUDED.customer_name_raw,
        crm_instance_id = EXCLUDED.crm_instance_id,
        customer_id = EXCLUDED.customer_id,
        customer_match_status = EXCLUDED.customer_match_status,
        customer_match_candidates = EXCLUDED.customer_match_candidates,
        customer_matched_at = EXCLUDED.customer_matched_at,
        agent_name_raw = EXCLUDED.agent_name_raw,
        agent_customer_id = EXCLUDED.agent_customer_id,
        agent_match_status = EXCLUDED.agent_match_status,
        agent_match_candidates = EXCLUDED.agent_match_candidates,
        contract_entity = EXCLUDED.contract_entity,
        contract_no_raw = EXCLUDED.contract_no_raw,
        contract_nos = EXCLUDED.contract_nos,
        factory_region = EXCLUDED.factory_region,
        demand_type = EXCLUDED.demand_type,
        radio_module_removed = EXCLUDED.radio_module_removed,
        order_note = EXCLUDED.order_note,
        agent_delivery_progress = EXCLUDED.agent_delivery_progress,
        custom_review_ref = EXCLUDED.custom_review_ref,
        delivery_address_raw = EXCLUDED.delivery_address_raw,
        logistics_note = EXCLUDED.logistics_note,
        installer_name = EXCLUDED.installer_name,
        installer_userid = EXCLUDED.installer_userid,
        delivery_date = EXCLUDED.delivery_date,
        delivery_service_note = EXCLUDED.delivery_service_note,
        contract_attachments = EXCLUDED.contract_attachments,
        requirement_attachments = EXCLUDED.requirement_attachments,
        jjy_attachments = EXCLUDED.jjy_attachments,
        delivery_photos = EXCLUDED.delivery_photos,
        acceptance_attachments = EXCLUDED.acceptance_attachments,
        oa_status = EXCLUDED.oa_status,
        oa_result = EXCLUDED.oa_result,
        delivery_status = EXCLUDED.delivery_status,
        delivery_status_basis = EXCLUDED.delivery_status_basis,
        crm_status_snapshot = EXCLUDED.crm_status_snapshot,
        originator_userid = EXCLUDED.originator_userid,
        originator_name = EXCLUDED.originator_name,
        originator_dept = EXCLUDED.originator_dept,
        oa_create_time = EXCLUDED.oa_create_time,
        oa_finish_time = EXCLUDED.oa_finish_time,
        form_json = EXCLUDED.form_json,
        parse_version = EXCLUDED.parse_version,
        synced_at = now(),
        updated_at = now()
      WHERE oa_orders.form_json IS DISTINCT FROM EXCLUDED.form_json
         OR oa_orders.oa_status IS DISTINCT FROM EXCLUDED.oa_status
         OR oa_orders.customer_match_status IS DISTINCT FROM EXCLUDED.customer_match_status
         OR oa_orders.delivery_status IS DISTINCT FROM EXCLUDED.delivery_status
         OR oa_orders.parse_version IS DISTINCT FROM EXCLUDED.parse_version
      RETURNING id`,
      [
        parsed.processInstanceId, parsed.businessId, parsed.processCode, parsed.orderType,
        parsed.customerNameRaw, parsed.crmInstanceId, match.customerId, match.status,
        match.candidates ? JSON.stringify(match.candidates) : null,
        parsed.agentNameRaw, agentMatch.customerId, agentMatch.status,
        agentMatch.candidates ? JSON.stringify(agentMatch.candidates) : null,
        parsed.contractEntity, parsed.contractNoRaw, parsed.contractNos, parsed.factoryRegion, parsed.demandType,
        parsed.radioModuleRemoved, parsed.orderNote, parsed.agentDeliveryProgress, parsed.customReviewRef,
        parsed.deliveryAddressRaw, parsed.logisticsNote, parsed.installerName, parsed.installerUserid,
        parsed.deliveryDate, parsed.deliveryServiceNote,
        parsed.contractAttachments ? JSON.stringify(parsed.contractAttachments) : null,
        parsed.requirementAttachments ? JSON.stringify(parsed.requirementAttachments) : null,
        parsed.jjyAttachments ? JSON.stringify(parsed.jjyAttachments) : null,
        parsed.deliveryPhotos ? JSON.stringify(parsed.deliveryPhotos) : null,
        parsed.acceptanceAttachments ? JSON.stringify(parsed.acceptanceAttachments) : null,
        parsed.oaStatus, parsed.oaResult, parsed.deliveryStatus, parsed.deliveryStatusBasis, parsed.crmStatusSnapshot,
        parsed.originatorUserid, parsed.originatorName, parsed.originatorDept,
        parsed.oaCreateTime, parsed.oaFinishTime,
        JSON.stringify(parsed.formJson), ORDER_PARSE_VERSION,
      ]
    );

    // upsert 未命中更新（无变化）时 RETURNING 为空，需要回查 id
    let orderId: number;
    let changed: boolean;
    if (res.rows.length > 0) {
      orderId = res.rows[0].id;
      changed = true;
    } else {
      const existing = await client.query(`SELECT id FROM oa_orders WHERE process_instance_id = $1`, [parsed.processInstanceId]);
      orderId = existing.rows[0].id;
      changed = false;
    }

    if (changed) {
      // 明细按 (order_id, row_number) upsert，并删除本次解析已不存在的行
      const keepRowNumbers: string[] = [];
      for (const item of parsed.items) {
        keepRowNumbers.push(item.rowNumber);
        await client.query(
          `INSERT INTO oa_order_items (order_id, row_number, product_category, product_key, quantity, extra)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (order_id, row_number) DO UPDATE SET
             product_category = EXCLUDED.product_category,
             product_key = EXCLUDED.product_key,
             quantity = EXCLUDED.quantity,
             extra = EXCLUDED.extra`,
          [orderId, item.rowNumber, item.productCategory, item.productKey, item.quantity, JSON.stringify(item.extra)]
        );
      }
      await client.query(
        `DELETE FROM oa_order_items WHERE order_id = $1 AND NOT (row_number = ANY($2))`,
        [orderId, keepRowNumbers]
      );
    }

    await client.query("COMMIT");
    return { orderId, changed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** 解析失败时的最小落库：不丢单、保留原文，可后续重解析 */
async function upsertOrderFallback(instance: any, processCode: string, processInstanceId: string): Promise<void> {
  const { getDingTalkConfig } = await import("./dingtalk");
  const orderType = processCode === getDingTalkConfig().processCodeOrderAgent ? "agent" : "direct";
  await pool.query(
    `INSERT INTO oa_orders (process_instance_id, process_code, order_type, oa_status, form_json, parse_version, customer_match_status, synced_at)
     VALUES ($1, $2, $3, $4, $5, 'parse-failed', 'unmatched', now())
     ON CONFLICT (process_instance_id) DO NOTHING`,
    [
      processInstanceId,
      processCode,
      orderType,
      instance?.status || "UNKNOWN",
      JSON.stringify(instance?.form_component_values || []),
    ]
  );
}

export interface OrderSyncResult {
  listedCount: number;
  detailOk: number;
  detailFail: number;
  changed: number;
  skippedLocked: number;
}

/** 同步指定订单 process_code 在一个时间窗口内的所有实例（幂等 upsert） */
export async function syncOrders(
  processCode: string,
  startMs: number,
  endMs: number,
  runId: string
): Promise<OrderSyncResult> {
  const result: OrderSyncResult = { listedCount: 0, detailOk: 0, detailFail: 0, changed: 0, skippedLocked: 0 };

  // 1. listids 分页收集（去重）
  const ids = new Set<string>();
  let cursor = 0;
  for (;;) {
    const page = await getApprovalInstances(startMs, endMs, cursor, 20, processCode);
    page.list.forEach((id) => ids.add(id));
    if (page.nextCursor === undefined || page.list.length === 0) break;
    cursor = page.nextCursor;
  }
  result.listedCount = ids.size;

  const lockedIds = await getLockedApprovalIds();

  // 2. 逐单拉详情、解析、落库（串行 + 限流）
  for (const id of ids) {
    if (lockedIds.has(id)) {
      result.skippedLocked++;
      continue;
    }
    try {
      const instance = await getApprovalDetail(id);
      await saveRawApproval(instance, id, processCode);
      const parsed = parseOrderExecution(instance, processCode);
      if (!parsed.processInstanceId) parsed.processInstanceId = id;
      const r = await upsertOrder(parsed);
      if (r.changed) {
        result.changed++;
        // 订单内容变化时刷新操作证据（新版 API）；失败不影响订单本体
        try {
          const { syncOrderEvents } = await import("./orderMilestoneService");
          await syncOrderEvents(id);
        } catch (e: any) {
          console.error(`[orderSync] 单 ${id} 操作证据刷新失败（不影响订单）:`, e?.message || e);
        }
      }
      result.detailOk++;
    } catch (err: any) {
      result.detailFail++;
      console.error(`[orderSync] 单 ${id} 处理失败:`, err?.message || err);
      try {
        const instance = await getApprovalDetail(id).catch(() => null);
        if (instance) await upsertOrderFallback(instance, processCode, id);
      } catch {
        // 兜底落库失败只记日志
      }
    }
    await sleep(DETAIL_INTERVAL_MS);
  }

  return result;
}

/** 记录窗口同步结果（对账） */
export async function recordSyncWindow(
  processCode: string,
  windowStart: Date,
  windowEnd: Date,
  status: "done" | "failed",
  runId: string,
  counts: { listedCount: number; detailOk: number; detailFail: number },
  error?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO oa_order_sync_windows (process_code, window_start, window_end, status, listed_count, detail_ok, detail_fail, error, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (process_code, window_start, window_end) DO UPDATE SET
       status = EXCLUDED.status,
       listed_count = EXCLUDED.listed_count,
       detail_ok = EXCLUDED.detail_ok,
       detail_fail = EXCLUDED.detail_fail,
       error = EXCLUDED.error,
       run_id = EXCLUDED.run_id,
       updated_at = now()`,
    [processCode, windowStart, windowEnd, status, counts.listedCount, counts.detailOk, counts.detailFail, error || null, runId]
  );
}

/** 增量同步入口：近 N 天一个窗口，带独立互斥锁（失败不影响拜访任务） */let orderSyncRunning = false;
export async function syncRecentOrders(days: number): Promise<void> {
  if (orderSyncRunning) {
    console.log("[orderSync] 上一次订单同步未完成，跳过");
    return;
  }
  orderSyncRunning = true;
  try {
    const { getOrderProcessCodes } = await import("./dingtalk");
    const codes = getOrderProcessCodes();
    if (codes.length === 0) return;
    const endMs = Date.now();
    const startMs = endMs - days * 86400000;
    const runId = `inc-${Date.now()}`;
    for (const code of codes) {
      try {
        const r = await syncOrders(code, startMs, endMs, runId);
        await recordSyncWindow(
          code,
          new Date(startMs),
          new Date(endMs),
          r.detailFail > 0 ? "failed" : "done",
          runId,
          r,
          r.detailFail > 0 ? `${r.detailFail} 单解析失败` : undefined
        );
        console.log(
          `[orderSync] code=${code.slice(5, 13)} days=${days} listed=${r.listedCount} ok=${r.detailOk} fail=${r.detailFail} changed=${r.changed} locked=${r.skippedLocked}`
        );
      } catch (err: any) {
        console.error(`[orderSync] code=${code} 同步失败（不影响其他任务）:`, err?.message || err);
        await recordSyncWindow(
          code,
          new Date(startMs),
          new Date(endMs),
          "failed",
          runId,
          { listedCount: 0, detailOk: 0, detailFail: 0 },
          err?.message || String(err)
        ).catch(() => {});
      }
    }
  } finally {
    orderSyncRunning = false;
  }
}

/**
 * RUNNING 长单补偿通道（A2）。
 *
 * 背景：listids 按创建时间检索，创建超过 90 天仍在 RUNNING 的订单会滑出每日 90 天窗口。
 * 按 id 拉详情（getApprovalDetail）无时间窗口限制，因此对库内全部 RUNNING 单逐条重拉 upsert。
 * 幂等（同一 upsert 路径），不触碰 visits，不会重复创建订单（process_instance_id 唯一约束）。
 */
export async function syncRunningOrders(): Promise<{ checked: number; updated: number; failed: number }> {
  const { getOrderProcessCodes } = await import("./dingtalk");
  const codes = new Set(getOrderProcessCodes());
  const res = await pool.query(
    `SELECT process_instance_id, process_code FROM oa_orders WHERE oa_status = 'RUNNING' ORDER BY oa_create_time`
  );
  const lockedIds = await getLockedApprovalIds();
  let updated = 0, failed = 0;
  for (const row of res.rows) {
    const id: string = row.process_instance_id;
    if (!codes.has(row.process_code) || lockedIds.has(id)) continue;
    try {
      const instance = await getApprovalDetail(id);
      await saveRawApproval(instance, id, row.process_code);
      const parsed = parseOrderExecution(instance, row.process_code);
      if (!parsed.processInstanceId) parsed.processInstanceId = id;
      const r = await upsertOrder(parsed);
      if (r.changed) {
        updated++;
        try {
          const { syncOrderEvents } = await import("./orderMilestoneService");
          await syncOrderEvents(id);
        } catch (e: any) {
          console.error(`[orderSync] RUNNING 单 ${id} 操作证据刷新失败（不影响订单）:`, e?.message || e);
        }
      }
    } catch (err: any) {
      failed++;
      console.error(`[orderSync] RUNNING 单 ${id} 补偿更新失败:`, err?.message || err);
    }
    await sleep(DETAIL_INTERVAL_MS);
  }
  console.log(`[orderSync] RUNNING 补偿：checked=${res.rows.length} updated=${updated} failed=${failed}`);
  return { checked: res.rows.length, updated, failed };
}
