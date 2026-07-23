import { pool } from "../src/db";
import {
  recomputeDerivedDataForVisits,
  AffectedUserDate,
} from "../src/services/derivedComputation";

/**
 * 一次性重刷脚本：把钉钉 visits 的 business_date 统一为「审批单级归日」口径。
 *
 * 口径：整张审批单的所有签到，business_date = 该审批单首次签到的北京时间日期。
 * 即使审批单跨天（次日早上补收尾签到），也归到行程开始的那天。
 * Excel 数据（无 approval_id）不在本脚本处理范围，仍按每条签到时间归日。
 *
 * 同时对受影响的 user+date 重算衍生数据（routes + 风险摘要缓存，含异常检测）。
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/recomputeBusinessDates.ts          # 正式执行
 *   npx ts-node scripts/recomputeBusinessDates.ts dry      # dry-run 预览，不更新
 */
async function main() {
  const dryRun = process.argv.includes("dry");
  try {
    console.log("[1/3] 查询与「审批单首次签到日期」不一致的钉钉 visits...");
    const visitsResult = await pool.query(
      `WITH first_dates AS (
         SELECT approval_id,
                (MIN(timestamp) AT TIME ZONE 'Asia/Shanghai')::date AS first_date
         FROM visits
         WHERE source = 'dingtalk' AND approval_id IS NOT NULL
         GROUP BY approval_id
       )
       SELECT v.id, v.user_id,
              v.business_date::text AS old_date,
              f.first_date::text  AS new_date
       FROM visits v
       JOIN first_dates f ON f.approval_id = v.approval_id
       WHERE v.source = 'dingtalk'
         AND v.business_date <> f.first_date
       ORDER BY v.id`
    );
    console.log(`找到 ${visitsResult.rows.length} 条需要修正的 visits`);

    // 受影响的 user+date：旧日期和新日期都要重算（旧日期少了这条记录，新日期多了这条）
    const pairMap = new Map<string, AffectedUserDate>();
    let updated = 0;

    for (let i = 0; i < visitsResult.rows.length; i++) {
      const row = visitsResult.rows[i];
      pairMap.set(`${row.user_id}|${row.old_date}`, {
        user_id: row.user_id,
        business_date: row.old_date,
      });
      pairMap.set(`${row.user_id}|${row.new_date}`, {
        user_id: row.user_id,
        business_date: row.new_date,
      });

      if (dryRun) {
        if (i < 10) {
          console.log(`  [dry] visit ${row.id}: ${row.old_date} -> ${row.new_date}`);
        }
        continue;
      }

      try {
        const updateResult = await pool.query(
          `UPDATE visits SET business_date = $1 WHERE id = $2`,
          [row.new_date, row.id]
        );
        updated += updateResult.rowCount || 0;
      } catch (err) {
        console.error(`visit ${row.id} 更新失败:`, err);
      }

      if ((i + 1) % 100 === 0 || i === visitsResult.rows.length - 1) {
        console.log(`[${i + 1}/${visitsResult.rows.length}] 已更新 ${updated} 条`);
      }
    }

    if (dryRun) {
      console.log(
        `[dry-run] 将更新 ${visitsResult.rows.length} 条 visits，` +
          `涉及 ${pairMap.size} 个 user+date 组合的衍生数据重算`
      );
      return;
    }

    console.log(`[2/3] 共更新 ${updated} 条 visits 的 business_date`);

    console.log(
      `[3/3] 重算 ${pairMap.size} 个 user+date 的衍生数据（routes + 风险摘要缓存）...`
    );
    await recomputeDerivedDataForVisits(Array.from(pairMap.values()));
    console.log("衍生数据重算完成，All done.");
  } catch (err) {
    console.error("Failed to run recomputeBusinessDates:", err);
  } finally {
    await pool.end();
  }
}

main();
