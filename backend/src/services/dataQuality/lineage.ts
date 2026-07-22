import { pool } from "../../db";

export interface ComputationTask {
  id: number;
  procedure: string;
  params: Record<string, any>;
  status: "pending" | "running" | "done" | "failed";
}

/**
 * 当某个表的数据发生变更时，按血缘图生成待重算任务。
 */
export async function enqueueDownstreamComputations(changedTable: string, params: Record<string, any> = {}): Promise<void> {
  const deps = await pool.query(
    `SELECT output_table, refresh_procedure, priority
     FROM computation_dependencies
     WHERE depends_on_table = $1
     ORDER BY priority ASC`,
    [changedTable]
  );

  for (const row of deps.rows) {
    await pool.query(
      `INSERT INTO computation_queue (procedure, params, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT DO NOTHING`,
      [row.refresh_procedure, JSON.stringify({ ...params, output_table: row.output_table })]
    );
  }
}

/**
 * 执行队列中的重算任务。
 * 这里用占位方式映射到现有 scripts/ 里的脚本，未来可以改为调用函数或子进程。
 */
const PROCEDURE_MAP: Record<string, string> = {
  recomputeRoutes: "npm run recompute:routes",
  recomputeStops: "npm run recompute:stops",
  recomputeAnomalies: "npm run recompute:anomalies",
  refreshRiskCache: "npm run refresh:risk-cache",
};

export async function runPendingComputations(): Promise<void> {
  const pending = await pool.query(
    `SELECT id, procedure, params FROM computation_queue
     WHERE status = 'pending'
     ORDER BY scheduled_at ASC
     LIMIT 10`
  );

  for (const row of pending.rows) {
    await pool.query(
      `UPDATE computation_queue SET status = 'running', started_at = NOW() WHERE id = $1`,
      [row.id]
    );

    try {
      const command = PROCEDURE_MAP[row.procedure];
      if (!command) {
        throw new Error(`未知重算步骤: ${row.procedure}`);
      }

      // 注意：这里目前只是记录，实际执行应该放到 scheduler 或 worker 中，避免阻塞主线程
      console.log(`[lineage] 应执行: ${command}，参数: ${row.params}`);

      await pool.query(
        `UPDATE computation_queue SET status = 'done', finished_at = NOW() WHERE id = $1`,
        [row.id]
      );
    } catch (err) {
      await pool.query(
        `UPDATE computation_queue SET status = 'failed', finished_at = NOW(), error_message = $2 WHERE id = $1`,
        [row.id, err instanceof Error ? err.message : String(err)]
      );
    }
  }
}

/**
 * 查询重算队列状态。
 */
export async function getComputationQueue(limit: number = 50): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM computation_queue ORDER BY scheduled_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * 获取某个表的血缘下游。
 */
export async function getLineage(table: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT output_table, refresh_procedure, priority
     FROM computation_dependencies
     WHERE depends_on_table = $1
     ORDER BY priority ASC`,
    [table]
  );
  return result.rows;
}

/**
 * 手动触发某个表及其下游的重算。
 */
export async function refreshTableAndDownstream(table: string, params: Record<string, any> = {}): Promise<void> {
  await enqueueDownstreamComputations(table, params);
  await runPendingComputations();
}
