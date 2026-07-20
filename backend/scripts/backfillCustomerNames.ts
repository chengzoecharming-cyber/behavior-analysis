import { pool } from "../src/db";
import { parseApprovalInstance } from "../src/services/dingtalk";

/**
 * 一次性补全脚本：重新解析所有钉钉审批单的 form_json，
 * 把 visits 表中的 customer_name 字段按正确规则补齐。
 *
 * 适用场景：
 * - 修复了客户名称解析逻辑后，需要把历史数据中的 customer_name 补齐
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/backfillCustomerNames.ts
 */
async function main() {
  const batchSize = 50;
  let offset = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  while (true) {
    const result = await pool.query(
      `SELECT id, approval_id, title, form_json
       FROM raw_approvals
       WHERE source = 'dingtalk'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [batchSize, offset]
    );

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      try {
        const instance = {
          form_component_values: row.form_json,
          business_id: row.approval_id,
          title: row.title,
          originator_userid: "",
          originator_user_name: "",
        };

        const visits = await parseApprovalInstance(instance);
        if (visits.length === 0) continue;

        for (const visit of visits) {
          if (!visit.customer_name) continue;

          const updateResult = await pool.query(
            `UPDATE visits
             SET customer_name = $1
             WHERE approval_id = $2 AND sequence = $3
               AND (customer_name IS NULL OR customer_name = '')
             RETURNING id`,
            [visit.customer_name, row.approval_id, visit.sequence]
          );

          if (updateResult.rows.length > 0) {
            totalUpdated++;
          } else {
            totalSkipped++;
          }
        }
      } catch (err) {
        console.error(`[backfillCustomerNames] failed for approval ${row.approval_id}:`, err);
      }
    }

    offset += batchSize;
    console.log(`[backfillCustomerNames] processed ${offset} approvals, updated ${totalUpdated} visits`);
  }

  console.log(
    `[backfillCustomerNames] completed: updated=${totalUpdated}, skipped=${totalSkipped}`
  );
}

main().catch((err) => {
  console.error("[backfillCustomerNames] failed:", err);
  process.exit(1);
});
