import { pool } from "../src/db";
import { formatBeijingDate } from "../src/utils/timezone";
import {
  recomputeDerivedDataForVisits,
  AffectedUserDate,
} from "../src/services/derivedComputation";

/**
 * 一次性重刷脚本：修正钉钉 visits 的 business_date。
 *
 * 背景：d402944 之前，钉钉数据的 business_date 按审批单日期归日；
 * 现行规则是按每条记录的实际签到时间（北京时间）归日。本脚本修正历史错位数据，
 * 并对受影响的 user+date 重算衍生数据（routes + 风险摘要缓存，含异常检测）。
 *
 * 用法（在 backend 目录下）：
 *   npx ts-node scripts/recomputeBusinessDates.ts          # 正式执行
 *   npx ts-node scripts/recomputeBusinessDates.ts dry      # dry-run 预览，不更新
 */
async function main() {
  const dryRun = process.argv.includes("dry");
  try {
    console.log("[1/3] 查询 business_date 与实际签到日期不一致的钉钉 visits...");
    const visitsResult = await pool.query(
      `SELECT id, user_id, business_date::text AS old_date, timestamp
       FROM visits
       WHERE source = 'dingtalk'
         AND business_date <> (timestamp AT TIME ZONE 'Asia/Shanghai')::date
       ORDER BY id`
    );
    console.log(`找到 ${visitsResult.rows.length} 条需要修正的 visits`);

    // 受影响的 user+date：旧日期和新日期都要重算（旧日期少了这条记录，新日期多了这条）
    const pairMap = new Map<string, AffectedUserDate>();
    let updated = 0;

    for (let i = 0; i < visitsResult.rows.length; i++) {
      const row = visitsResult.rows[i];
      const newDate = formatBeijingDate(new Date(row.timestamp));
      pairMap.set(`${row.user_id}|${row.old_date}`, {
        user_id: row.user_id,
        business_date: row.old_date,
      });
      pairMap.set(`${row.user_id}|${newDate}`, {
        user_id: row.user_id,
        business_date: newDate,
      });

      if (dryRun) {
        if (i < 10) {
          console.log(`  [dry] visit ${row.id}: ${row.old_date} -> ${newDate}`);
        }
        continue;
      }

      try {
        const updateResult = await pool.query(
          `UPDATE visits SET business_date = $1 WHERE id = $2`,
          [newDate, row.id]
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
