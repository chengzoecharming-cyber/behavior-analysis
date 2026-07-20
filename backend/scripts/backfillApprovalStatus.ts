import { pool } from "../src/db";

/**
 * 一次性补全脚本：把 raw_approvals.status 同步到 visits.approval_status。
 *
 * 适用场景：
 * - 新增 visits.approval_status 字段后，给历史数据补状态
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/backfillApprovalStatus.ts
 */
async function main() {
  const result = await pool.query(
    `UPDATE visits v
     SET approval_status = COALESCE(r.status, 'COMPLETED')
     FROM raw_approvals r
     WHERE v.approval_id = r.approval_id
       AND (v.approval_status IS NULL OR v.approval_status = '')`
  );

  console.log(`[backfillApprovalStatus] updated ${result.rowCount} visits`);
}

main().catch((err) => {
  console.error("[backfillApprovalStatus] failed:", err);
  process.exit(1);
});
