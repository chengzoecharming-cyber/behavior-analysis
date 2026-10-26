/**
 * 事件里程碑归属修复（不调钉钉 API）。
 *
 * 背景：milestone-v1 首版同一事件佐证多个里程碑时互相覆盖（后写覆盖先写），
 * 导致 oa_order_events.milestone 与 oa_orders.milestones 不一致。
 * 本脚本从 oa_orders.milestones（正确）回标事件行（逗号累加），幂等可重跑。
 */
import { pool } from "../src/db";

async function main(): Promise<void> {
  const orders = await pool.query(
    `SELECT process_instance_id, milestones FROM oa_orders WHERE milestones IS NOT NULL`
  );
  console.log(`待回标订单 ${orders.rows.length} 张`);

  await pool.query(`UPDATE oa_order_events SET milestone = NULL, milestone_rule_version = NULL, confidence = NULL`);

  let marked = 0;
  for (const row of orders.rows) {
    const items = row.milestones?.items || {};
    for (const [milestone, entry] of Object.entries<any>(items)) {
      if (!entry) continue;
      const res = await pool.query(
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
        [row.process_instance_id, milestone, row.milestones.rule_version, entry.confidence, entry.node, entry.at ? new Date(entry.at) : null]
      );
      marked += res.rowCount || 0;
    }
  }
  console.log(`回标完成，事件行更新 ${marked} 行`);

  // 一致性校验
  const check = await pool.query(`
    SELECT count(*) AS ms_but_no_event
    FROM oa_orders o
    WHERE (o.milestones->'items'->>'erp_entered') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oa_order_events e WHERE e.process_instance_id=o.process_instance_id AND e.milestone LIKE '%erp_entered%')
  `);
  console.log(`校验：里程碑 erp_entered 无对应事件标记的订单数 = ${check.rows[0].ms_but_no_event}（应为 0）`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
