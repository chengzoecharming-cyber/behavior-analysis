import { pool } from "../src/db";
import { formatBeijingDate } from "../src/utils/timezone";

async function main() {
  try {
    console.log("[1/3] 查询需要修正的钉钉审批单...");
    const approvalResult = await pool.query(
      `SELECT DISTINCT approval_id
       FROM visits
       WHERE source = 'dingtalk' AND approval_id IS NOT NULL
       ORDER BY approval_id`
    );
    const approvalIds = approvalResult.rows.map((r) => r.approval_id) as string[];
    console.log(`找到 ${approvalIds.length} 个审批单`);

    let updated = 0;
    for (let i = 0; i < approvalIds.length; i++) {
      const approvalId = approvalIds[i];
      try {
        // 取该审批单下最早的拜访时间作为业务日期
        const minResult = await pool.query(
          `SELECT MIN(timestamp) AS min_ts
           FROM visits
           WHERE approval_id = $1 AND source = 'dingtalk'`,
          [approvalId]
        );
        const minTs = minResult.rows[0]?.min_ts;
        if (!minTs) continue;

        const businessDate = formatBeijingDate(new Date(minTs));

        const updateResult = await pool.query(
          `UPDATE visits
           SET business_date = $1
           WHERE approval_id = $2 AND source = 'dingtalk'`,
          [businessDate, approvalId]
        );
        updated += updateResult.rowCount || 0;

        if ((i + 1) % 100 === 0 || i === approvalIds.length - 1) {
          console.log(`[${i + 1}/${approvalIds.length}] 已更新 ${updated} 条 visits`);
        }
      } catch (err) {
        console.error(`[${i + 1}/${approvalIds.length}] 审批单 ${approvalId} 处理失败:`, err);
      }
    }

    console.log(`[2/3] 共更新 ${updated} 条 visits 的 business_date`);

    // 顺手把 raw_approvals 的 create_time/finish_time 也修正（如果之前存错了）
    console.log("[3/3] 修正 raw_approvals 的 create_time/finish_time...");
    const rawResult = await pool.query(
      `SELECT approval_id, create_time, finish_time
       FROM raw_approvals
       WHERE source = 'dingtalk'`
    );
    let rawUpdated = 0;
    for (const row of rawResult.rows) {
      // 这里只是重新按北京时间格式化，若原本已正确则无变化
      const newCreate = row.create_time ? formatBeijingDate(row.create_time) : null;
      const newFinish = row.finish_time ? formatBeijingDate(row.finish_time) : null;
      if (newCreate || newFinish) {
        await pool.query(
          `UPDATE raw_approvals
           SET create_time = COALESCE($1, create_time),
               finish_time = COALESCE($2, finish_time)
           WHERE approval_id = $3`,
          [newCreate ? new Date(newCreate + "T00:00:00+08:00") : null,
           newFinish ? new Date(newFinish + "T00:00:00+08:00") : null,
           row.approval_id]
        );
        rawUpdated++;
      }
    }
    console.log(`修正 ${rawUpdated} 条 raw_approvals`);

    console.log("All done.");
  } catch (err) {
    console.error("Failed to run recomputeBusinessDates:", err);
  } finally {
    await pool.end();
  }
}

main();
