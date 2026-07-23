import { pool } from "../src/db";
import { parseApprovalInstance } from "../src/services/dingtalk";

/**
 * 一次性重刷脚本：重新解析所有钉钉审批单的 form_json，
 * 把 visits 表中的 customer_name 字段按正确规则覆盖更新。
 *
 * 覆盖模式：不做条件判断，直接用重新解析的值覆盖旧值，
 * 用于修正「客户名称错挂到上一个签到点」的历史数据。
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/backfillCustomerNames.ts          # 正式执行
 *   npx ts-node scripts/backfillCustomerNames.ts dry      # dry-run 预览差异，不更新
 */
async function main() {
  const dryRun = process.argv.includes("dry");
  const batchSize = 50;
  let offset = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalUnchanged = 0;
  const changes: string[] = [];

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
          const newName = visit.customer_name || "";

          // 先查出当前库里的值，对比是否有变化
          const current = await pool.query(
            `SELECT customer_name FROM visits
             WHERE approval_id = $1 AND sequence = $2`,
            [row.approval_id, visit.sequence]
          );

          if (current.rows.length === 0) {
            totalSkipped++;
            continue;
          }

          const oldName = current.rows[0].customer_name || "";

          if (oldName === newName) {
            totalUnchanged++;
            continue;
          }

          if (dryRun) {
            changes.push(
              `  approval=${row.approval_id} seq=${visit.sequence}: "${oldName}" -> "${newName}"`
            );
            totalUpdated++;
          } else {
            const updateResult = await pool.query(
              `UPDATE visits
               SET customer_name = $1
               WHERE approval_id = $2 AND sequence = $3
               RETURNING id`,
              [newName, row.approval_id, visit.sequence]
            );

            if (updateResult.rows.length > 0) {
              totalUpdated++;
            } else {
              totalSkipped++;
            }
          }
        }
      } catch (err) {
        console.error(`[backfillCustomerNames] failed for approval ${row.approval_id}:`, err);
      }
    }

    offset += batchSize;
    console.log(
      `[backfillCustomerNames] processed ${offset} approvals, ` +
      `${dryRun ? "would-update" : "updated"}=${totalUpdated}, unchanged=${totalUnchanged}`
    );
  }

  if (dryRun && changes.length > 0) {
    console.log(`\n[DRY-RUN] ${changes.length} visits would be updated:\n`);
    for (const c of changes) {
      console.log(c);
    }
    console.log("");
  }

  console.log(
    `[backfillCustomerNames] ${dryRun ? "DRY-RUN " : ""}completed: ` +
    `${dryRun ? "would-update" : "updated"}=${totalUpdated}, unchanged=${totalUnchanged}, skipped=${totalSkipped}`
  );
}

main().catch((err) => {
  console.error("[backfillCustomerNames] failed:", err);
  process.exit(1);
});
