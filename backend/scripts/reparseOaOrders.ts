/**
 * OA 订单重解析（解析器口径修复后的存量刷新）。
 *
 * 背景：旧版订单表单（约 2026-03 前）无 OpenDataField「客户名称」，客户名在
 * FormRelateField「客户」（JSON 数组）。解析器已加兼容回退，本脚本从 raw_approvals
 * 重放全部订单单（不调用钉钉 API），重新解析 + 重新匹配 + upsert。
 *
 * 用法：
 *   npx ts-node scripts/reparseOaOrders.ts            # 全量重放
 *   npx ts-node scripts/reparseOaOrders.ts -- --dry   # 只统计差异，不写库
 */
import { pool } from "../src/db";
import { parseOrderExecution } from "../src/services/orderExecutionParser";
import { upsertOrder } from "../src/services/orderSyncService";

const DRY_RUN = process.argv.includes("--dry");

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** timestamptz → 钉钉风格的北京时间字符串（解析器按 +08:00 解释） */
function toBeijingString(d: Date | null): string | null {
  if (!d) return null;
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}`;
}

async function main(): Promise<void> {
  const res = await pool.query(
    `SELECT r.approval_id, r.process_instance_id, r.process_code, r.title,
            r.originator_userid, r.originator_dept_name,
            r.create_time, r.finish_time, r.form_json, r.status, r.result,
            o.customer_name_raw AS old_name, o.customer_match_status AS old_status
     FROM raw_approvals r
     JOIN oa_orders o ON o.process_instance_id = r.process_instance_id
     WHERE r.process_code = ANY($1)
     ORDER BY r.create_time`,
    [[process.env.DINGTALK_PROCESS_CODE_ORDER || "", process.env.DINGTALK_PROCESS_CODE_ORDER_AGENT || ""]]
  );
  console.log(`待重放订单单 ${res.rows.length} 条（dry=${DRY_RUN}）`);

  let recovered = 0, changed = 0, failed = 0;
  for (const row of res.rows) {
    try {
      const instance = {
        business_id: row.approval_id,
        process_instance_id: row.process_instance_id,
        title: row.title,
        originator_userid: row.originator_userid,
        originator_dept_name: row.originator_dept_name,
        create_time: toBeijingString(row.create_time),
        finish_time: toBeijingString(row.finish_time),
        status: row.status,
        result: row.result,
        form_component_values: row.form_json,
      };
      const parsed = parseOrderExecution(instance, row.process_code);
      if (!parsed.processInstanceId) parsed.processInstanceId = row.process_instance_id;
      if (!row.old_name && parsed.customerNameRaw) recovered++;
      if (DRY_RUN) {
        if (parsed.customerNameRaw !== (row.old_name || "")) changed++;
      } else {
        const r = await upsertOrder(parsed);
        if (r.changed) changed++;
      }
    } catch (err: any) {
      failed++;
      console.error(`单 ${row.process_instance_id} 重解析失败:`, err?.message || err);
    }
  }
  console.log(`完成：重放 ${res.rows.length}，客户名恢复 ${recovered}，写库变更 ${changed}，失败 ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
