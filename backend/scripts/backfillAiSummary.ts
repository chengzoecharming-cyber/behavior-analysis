/**
 * 回填 v2 行的自建 LLM AI 总结（visit_detail.ai / visit_note）。
 *
 * 钉钉 DDAIField「AI总结」字段失效后，存量 v2 行只有兜底拼接的
 * 「沟通内容：...；存在问题：...」。本脚本找出所有缺 ai 但有原始内容
 * （comm/issues 至少一个非空）的 v2 行，调用 llmSummaryService 生成总结并回写。
 * 回写 visit_note 时保留原里程备注后缀（如「[缺少终点里程读数]」）。
 *
 * 未配置 LLM_API_KEY 时直接退出（不做任何事）。
 *
 * 用法：
 *   npx ts-node scripts/backfillAiSummary.ts        # 实际执行
 *   npx ts-node scripts/backfillAiSummary.ts --dry  # 只预览将处理的行数与样例，不写库不调 LLM
 */
import { pool } from "../src/db";
import {
  isLlmConfigured,
  summarizeVisit,
  persistAiSummary,
} from "../src/services/llmSummaryService";

const DRY_RUN = process.argv.includes("--dry");

interface Row {
  approval_id: string;
  user_id: string;
  user_name: string;
  sequence: number;
  visit_note: string | null;
  comm: string;
  issues: string;
}

async function main() {
  if (!isLlmConfigured()) {
    console.log("未配置 LLM_API_KEY，跳过（dry-run 也只展示待处理行）");
  }

  const result = await pool.query<Row>(
    `SELECT approval_id, user_id, user_name, sequence, visit_note,
            COALESCE(visit_detail->>'comm', '') AS comm,
            COALESCE(visit_detail->>'issues', '') AS issues
     FROM visits
     WHERE form_version = 'v2'
       AND approval_id IS NOT NULL AND sequence IS NOT NULL
       AND (visit_detail IS NULL OR COALESCE(visit_detail->>'ai', '') = '')
       AND (COALESCE(visit_detail->>'comm', '') <> '' OR COALESCE(visit_detail->>'issues', '') <> '')
     ORDER BY user_id, business_date, sequence`
  );
  console.log(`待补 AI 总结的 v2 行：${result.rows.length} 条，dryRun=${DRY_RUN}`);

  // 样例预览
  for (const row of result.rows.slice(0, 10)) {
    console.log(
      `  [${row.user_name}] approval=${row.approval_id} seq=${row.sequence} 沟通=${row.comm.slice(0, 30)}... 问题=${row.issues.slice(0, 30)}...`
    );
  }

  if (DRY_RUN || !isLlmConfigured()) {
    console.log("\n(dry-run 或未配置 key，未写库)");
    return;
  }

  let done = 0;
  let failed = 0;
  for (const row of result.rows) {
    try {
      const aiText = await summarizeVisit(row.comm, row.issues);
      if (!aiText) {
        failed++;
        continue;
      }
      await persistAiSummary(row, aiText);
      done++;
      if (done % 20 === 0) console.log(`  已完成 ${done} 条...`);
    } catch (err) {
      failed++;
      console.warn(
        `  失败: approval=${row.approval_id} user=${row.user_id} seq=${row.sequence}`,
        err
      );
    }
  }
  console.log(`\n回填完成：成功 ${done} 条，失败/跳过 ${failed} 条`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
