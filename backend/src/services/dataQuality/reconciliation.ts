import { pool } from "../../db";
import crypto from "crypto";

export interface ReconciliationCheckInput {
  syncLogId: number;
  checkName: string;
  status: "passed" | "failed" | "warning";
  sourceValue?: string;
  targetValue?: string;
  message: string;
}

export async function recordReconciliationCheck(input: ReconciliationCheckInput): Promise<void> {
  await pool.query(
    `INSERT INTO reconciliation_checks
       (sync_log_id, check_name, status, source_value, target_value, message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.syncLogId, input.checkName, input.status, input.sourceValue ?? null, input.targetValue ?? null, input.message]
  );
}

/**
 * 计算 ID 集合的 MD5 hash，用于快速比较源端和库端是否一致。
 */
export function hashIdList(ids: string[]): string {
  const sorted = [...ids].sort();
  return crypto.createHash("md5").update(sorted.join(",")).digest("hex");
}

export interface ReconciliationContext {
  syncLogId: number;
  startDate: string;
  endDate: string;
  sourceApprovalIds: string[];
  parsedVisitCount: number;
  normalizedInsertedCount: number;
  rawVisitCount: number;
}

/**
 * 在钉钉同步完成后执行一组对账检查。
 * 这个函数应该在 dingtalk 同步落库后调用。
 */
export async function runReconciliationChecks(ctx: ReconciliationContext): Promise<void> {
  const { syncLogId, startDate, endDate, sourceApprovalIds, parsedVisitCount, normalizedInsertedCount, rawVisitCount } = ctx;

  // 1. 审批单集合 hash 对账
  const sourceHash = hashIdList(sourceApprovalIds);
  const dbRawApprovalRows = await pool.query(
    `SELECT approval_id FROM raw_approvals WHERE create_time >= $1::date AND create_time < $2::date + INTERVAL '1 day'`,
    [startDate, endDate]
  );
  const dbApprovalIds = dbRawApprovalRows.rows.map((r) => r.approval_id);
  const dbHash = hashIdList(dbApprovalIds);

  if (sourceHash !== dbHash) {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "approval_id_hash_match",
      status: "failed",
      sourceValue: sourceHash,
      targetValue: dbHash,
      message: `源端审批单集合与库中不一致，源端 ${sourceApprovalIds.length} 条，库中 ${dbApprovalIds.length} 条`,
    });
  } else {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "approval_id_hash_match",
      status: "passed",
      sourceValue: sourceHash,
      targetValue: dbHash,
      message: "审批单集合 hash 一致",
    });
  }

  // 2. 解析出的 visit 数 vs 写入数
  if (parsedVisitCount !== normalizedInsertedCount) {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "parsed_vs_inserted",
      status: "failed",
      sourceValue: String(parsedVisitCount),
      targetValue: String(normalizedInsertedCount),
      message: `解析出 ${parsedVisitCount} 条 visit，但写入 ${normalizedInsertedCount} 条，可能因重复或异常被跳过`,
    });
  } else {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "parsed_vs_inserted",
      status: "passed",
      sourceValue: String(parsedVisitCount),
      targetValue: String(normalizedInsertedCount),
      message: "解析数与写入数一致",
    });
  }

  // 3. raw_visits vs normalized visits
  if (rawVisitCount !== normalizedInsertedCount) {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "raw_vs_normalized",
      status: "warning",
      sourceValue: String(rawVisitCount),
      targetValue: String(normalizedInsertedCount),
      message: `raw_visits 写入 ${rawVisitCount} 条，但 visits 写入 ${normalizedInsertedCount} 条，部分记录可能在标准化时被跳过`,
    });
  } else {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "raw_vs_normalized",
      status: "passed",
      sourceValue: String(rawVisitCount),
      targetValue: String(normalizedInsertedCount),
      message: "raw_visits 与 visits 数量一致",
    });
  }

  // 4. 重复检查：approval_id + sequence + user_id
  const duplicateRows = await pool.query(
    `SELECT approval_id, sequence, user_id, COUNT(*) AS cnt
     FROM visits
     WHERE approval_id IS NOT NULL
       AND business_date BETWEEN $1 AND $2
     GROUP BY approval_id, sequence, user_id
     HAVING COUNT(*) > 1
     LIMIT 1`,
    [startDate, endDate]
  );
  if (duplicateRows.rows.length > 0) {
    const row = duplicateRows.rows[0];
    await recordReconciliationCheck({
      syncLogId,
      checkName: "duplicate_approval_sequence",
      status: "failed",
      targetValue: `${row.approval_id}/${row.sequence}/${row.user_id} = ${row.cnt}`,
      message: `发现 approval_id + sequence + user_id 重复：${row.approval_id}/${row.sequence}/${row.user_id} 出现 ${row.cnt} 次`,
    });
  } else {
    await recordReconciliationCheck({
      syncLogId,
      checkName: "duplicate_approval_sequence",
      status: "passed",
      message: "未发现 approval_id + sequence + user_id 重复",
    });
  }
}

/**
 * 查询某次同步的对账结果。
 */
export async function getReconciliationChecks(syncLogId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM reconciliation_checks WHERE sync_log_id = $1 ORDER BY created_at DESC`,
    [syncLogId]
  );
  return result.rows;
}

/**
 * 判断某次同步是否通过对账。
 */
export async function isSyncReconciliationPassed(syncLogId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM reconciliation_checks WHERE sync_log_id = $1 AND status = 'failed'`,
    [syncLogId]
  );
  return Number(result.rows[0].cnt) === 0;
}
