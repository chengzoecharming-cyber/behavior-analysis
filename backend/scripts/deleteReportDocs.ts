/**
 * 删除指定 run_id 生成的钉钉报告文档（移入回收站）。
 * 用于清理本地/异常实例误生成的重复报告。
 *
 * 用法：
 *   npx ts-node scripts/deleteReportDocs.ts <run_id> [--dry]
 *
 * --dry 只列出将删除的文档，不实际调用删除接口。
 */
import { pool } from "../src/db";
import {
  deleteDoc,
  getOperatorUnionId,
  getOrCreateWorkspace,
} from "../src/services/dingtalkDoc";

async function main() {
  const args = process.argv.slice(2);
  const runId = args[0];
  const dryRun = args.includes("--dry");

  if (!runId) {
    console.error(
      "用法: npx ts-node scripts/deleteReportDocs.ts <run_id> [--dry]"
    );
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT id, scope, scope_name, doc_url
     FROM report_generation_logs
     WHERE run_id = $1 AND doc_url IS NOT NULL
     ORDER BY id`,
    [runId]
  );

  console.log(`run_id=${runId}，共 ${rows.length} 份文档${dryRun ? "（dry-run，不删除）" : "待删除"}`);
  if (rows.length === 0) {
    await pool.end();
    return;
  }

  if (dryRun) {
    for (const row of rows) {
      console.log(`  [${row.scope}] ${row.scope_name}: ${row.doc_url}`);
    }
    await pool.end();
    return;
  }

  const unionId = await getOperatorUnionId();
  const workspaceName =
    process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";
  const workspace = await getOrCreateWorkspace(unionId, workspaceName);

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    const nodeId = (row.doc_url as string).split("/").pop()!;
    try {
      await deleteDoc(unionId, workspace.workspaceId, nodeId);
      ok++;
      console.log(`✓ [${row.scope}] ${row.scope_name} ${nodeId}`);
    } catch (err: any) {
      fail++;
      console.error(`✗ [${row.scope}] ${row.scope_name} ${nodeId}: ${err.message}`);
    }
  }

  console.log(`完成：成功 ${ok}，失败 ${fail}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
