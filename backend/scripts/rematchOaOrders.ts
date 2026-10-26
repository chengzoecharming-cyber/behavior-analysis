/**
 * OA 订单客户重匹配（存量升级）。
 *
 * 触发时机：CRM Excel 导入后（快照更新），对 matched_by_exact_name / ambiguous / unmatched
 * 的存量订单重跑匹配。只升级不降级：matched_by_verified_id 行跳过；
 * exact_name 行若被 ID 通道命中则升级，名称结果不变则不动。
 *
 * 用法：
 *   npx ts-node scripts/rematchOaOrders.ts        # 实际执行
 *   npx ts-node scripts/rematchOaOrders.ts --dry  # 只预览统计
 */
import { pool } from "../src/db";
import { matchCustomer, invalidateCrmCache } from "../src/services/orderCustomerMatch";

const DRY_RUN = process.argv.includes("--dry");

async function main(): Promise<void> {
  invalidateCrmCache();
  const res = await pool.query(
    `SELECT id, customer_name_raw, crm_instance_id, customer_match_status, agent_name_raw, agent_match_status, order_type
     FROM oa_orders
     WHERE customer_match_status IN ('matched_by_exact_name', 'ambiguous', 'unmatched')
        OR (order_type = 'agent' AND COALESCE(agent_match_status, 'unmatched') IN ('ambiguous', 'unmatched'))
     ORDER BY id`
  );
  console.log(`待重匹配订单 ${res.rows.length} 条（dry=${DRY_RUN}）`);

  let upgraded = 0, agentUpgraded = 0, unchanged = 0;
  for (const row of res.rows) {
    const m = await matchCustomer(pool, row.customer_name_raw, row.crm_instance_id);
    const changed =
      m.status !== row.customer_match_status &&
      // 只允许升级：verified > exact > ambiguous > unmatched
      rank(m.status) > rank(row.customer_match_status);
    if (changed) {
      upgraded++;
      console.log(`订单 ${row.id} 客户「${row.customer_name_raw}」: ${row.customer_match_status} → ${m.status}`);
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE oa_orders SET customer_match_status = $2, customer_id = $3, customer_match_candidates = $4, customer_matched_at = now(), updated_at = now()
           WHERE id = $1`,
          [row.id, m.status, m.customerId, m.candidates ? JSON.stringify(m.candidates) : null]
        );
      }
    } else {
      unchanged++;
    }

    if (row.order_type === "agent" && row.agent_name_raw) {
      const am = await matchCustomer(pool, row.agent_name_raw, null);
      const agentChanged = am.status !== row.agent_match_status && rank(am.status) > rank(row.agent_match_status || "unmatched");
      if (agentChanged) {
        agentUpgraded++;
        console.log(`订单 ${row.id} 代理商「${row.agent_name_raw}」: ${row.agent_match_status} → ${am.status}`);
        if (!DRY_RUN) {
          await pool.query(
            `UPDATE oa_orders SET agent_match_status = $2, agent_customer_id = $3, agent_match_candidates = $4, updated_at = now()
             WHERE id = $1`,
            [row.id, am.status, am.customerId, am.candidates ? JSON.stringify(am.candidates) : null]
          );
        }
      }
    }
  }
  console.log(`完成：客户升级 ${upgraded}，代理商升级 ${agentUpgraded}，不变 ${unchanged}`);
  await pool.end();
}

function rank(status: string): number {
  switch (status) {
    case "matched_by_verified_id": return 3;
    case "matched_by_exact_name": return 2;
    case "ambiguous": return 1;
    default: return 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
