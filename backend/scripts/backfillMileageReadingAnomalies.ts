/**
 * 历史数据回填：基于 visits.start_odometer / end_odometer 重新检测里程读数异常，
 * 并写入 anomalies 表。
 *
 * 说明：
 * - 不调用高德 API，也不修改 routes/stops。
 * - 会先清空已有的 type = 'mileage_reading_invalid' 异常，再重新生成，避免重复。
 * - 只处理有里程读数字段的审批单（start_odometer 或 end_odometer 非空）。
 *
 * 用法：
 *   npx ts-node scripts/backfillMileageReadingAnomalies.ts        # 正式执行
 *   npx ts-node scripts/backfillMileageReadingAnomalies.ts dry    # 只预览
 */

import { pool } from "../src/db";
import { detectMileageReadingInvalid } from "../src/services/anomalyDetection";
import { Visit } from "../src/types";
import { formatBeijingDate } from "../src/utils/timezone";

async function backfill(dryRun = false): Promise<void> {
  // 1. 先拿到所有可能有里程读数的审批单关联的 visits
  const visitsRes = await pool.query<Visit>(
    `SELECT id, user_id, user_name, business_date, timestamp, lat, lng,
            location_name, address, approval_id, sequence, trip_type,
            start_odometer, end_odometer, reported_distance_km,
            special_sign_reason, visit_note, source_detail
     FROM visits
     WHERE approval_id IN (
       SELECT DISTINCT approval_id
       FROM visits
       WHERE approval_id IS NOT NULL
         AND (start_odometer IS NOT NULL OR end_odometer IS NOT NULL)
     )
     ORDER BY approval_id, sequence`
  );

  // 2. 按 approval_id 分组
  const groups = new Map<string, Visit[]>();
  for (const v of visitsRes.rows) {
    const aid = v.approval_id;
    if (!aid) continue;
    if (!groups.has(aid)) groups.set(aid, []);
    groups.get(aid)!.push(v);
  }

  const toInsert: {
    user_id: string;
    type: string;
    description: string;
    severity: string;
    related_visit_ids: number[];
    metadata: any;
    anomaly_date: string;
  }[] = [];

  for (const [approvalId, groupVisits] of groups) {
    const anomalies = detectMileageReadingInvalid(groupVisits);
    for (const a of anomalies) {
      // 用审批单内第一个 visit 的 business_date 作为异常日期
      const firstVisit = groupVisits[0];
      const anomalyDate = firstVisit.business_date
        ? formatBeijingDate(new Date(firstVisit.business_date))
        : formatBeijingDate(firstVisit.timestamp);

      toInsert.push({
        user_id: a.user_id,
        type: a.type,
        description: a.description,
        severity: a.severity,
        related_visit_ids: a.related_visit_ids,
        metadata: a.metadata,
        anomaly_date: anomalyDate,
      });
    }
  }

  console.log(`检测到 ${toInsert.length} 条 mileage_reading_invalid 异常`);

  if (dryRun) {
    console.log("\n[dry-run] 前 10 条预览：");
    for (let i = 0; i < Math.min(10, toInsert.length); i++) {
      const item = toInsert[i];
      console.log(`  ${item.user_id} | ${item.anomaly_date} | ${item.description.slice(0, 120)}...`);
    }
    console.log("\n[dry-run] 不会实际写入数据库");
    return;
  }

  // 3. 在事务中清空旧记录并写入新记录
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deleteRes = await client.query(
      `DELETE FROM anomalies WHERE type = 'mileage_reading_invalid'`
    );
    console.log(`已清空 ${deleteRes.rowCount} 条旧 mileage_reading_invalid 异常`);

    let inserted = 0;
    for (const item of toInsert) {
      await client.query(
        `INSERT INTO anomalies
         (user_id, type, description, start_time, end_time, lat, lng,
          severity, related_visit_ids, metadata, anomaly_date, created_at)
         VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, $4, $5, $6, $7, NOW())`,
        [
          item.user_id,
          item.type,
          item.description,
          item.severity,
          item.related_visit_ids,
          JSON.stringify(item.metadata || {}),
          item.anomaly_date,
        ]
      );
      inserted++;
    }

    await client.query("COMMIT");
    console.log(`\nDone. 插入 ${inserted} 条 mileage_reading_invalid 异常`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const dryRun = process.argv.includes("dry") || process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("[dry-run] 不会实际更新数据库\n");
  }

  try {
    await backfill(dryRun);
  } catch (err) {
    console.error("脚本执行失败:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
