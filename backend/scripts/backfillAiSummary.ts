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
 *   npx ts-node scripts/backfillAiSummary.ts        # 实际执行（只补缺 ai 的行）
 *   npx ts-node scripts/backfillAiSummary.ts --dry  # 只预览将处理的行数与样例，不写库不调 LLM
 *   npx ts-node scripts/backfillAiSummary.ts --force # 重做「总结比原文还长」的臃肿行（覆盖旧 ai）
 *   npx ts-node scripts/backfillAiSummary.ts --force-ds # 只重做 DS 生成过的行：
 *      重解析 raw_approvals.form_json，AI总结块为空的打卡点说明 ai 是本服务写的
 *      （钉钉生成的总结保留不动），按新 prompt 重做。
 */
import { pool } from "../src/db";
import {
  isLlmConfigured,
  summarizeVisit,
  persistAiSummary,
} from "../src/services/llmSummaryService";
import { parseApprovalInstance } from "../src/services/dingtalk";

const DRY_RUN = process.argv.includes("--dry");
// --force：重做已生成但「比原文还长」的 AI 总结（早期 prompt 过松导致的扩写问题）
const FORCE = process.argv.includes("--force");
// --force-ds：只重做 DS 写过的行（重解析原始表单判定，钉钉生成的 ai 不动）
const FORCE_DS = process.argv.includes("--force-ds");

interface Row {
  approval_id: string;
  user_id: string;
  user_name: string;
  sequence: number;
  visit_note: string | null;
  comm: string;
  issues: string;
}

/**
 * 找出「ai 是 DS 写的」行：对每张有 ai 的 v2 审批单重解析原始表单，
 * 解析结果中 AI总结块为空的打卡点 → 库里的 ai 必为 DS 回填。
 */
async function findDsWrittenRows(): Promise<Row[]> {
  const approvals = await pool.query<{ approval_id: string }>(
    `SELECT DISTINCT approval_id FROM visits
     WHERE form_version = 'v2' AND approval_id IS NOT NULL
       AND COALESCE(visit_detail->>'ai', '') <> ''
       AND (COALESCE(visit_detail->>'comm', '') <> '' OR COALESCE(visit_detail->>'issues', '') <> '')`
  );
  const dsKeys: string[] = [];
  for (const { approval_id } of approvals.rows) {
    const r = await pool.query(
      `SELECT form_json, process_code, originator_userid, originator_user_name,
              originator_dept_name, status, result
       FROM raw_approvals WHERE approval_id = $1`,
      [approval_id]
    );
    if (r.rows.length === 0) continue;
    const raw = r.rows[0];
    try {
      const parsed = await parseApprovalInstance(
        {
          form_component_values: raw.form_json,
          business_id: approval_id,
          originator_userid: raw.originator_userid,
          originator_user_name: raw.originator_user_name,
          originator_dept_name: raw.originator_dept_name,
          status: raw.status,
          result: raw.result,
        },
        raw.process_code
      );
      for (const v of parsed) {
        if (!v.visit_detail?.ai && v.user_id && v.sequence != null) {
          dsKeys.push(`${approval_id}|${v.user_id}|${v.sequence}`);
        }
      }
    } catch (err) {
      console.warn(`  重解析失败，跳过审批单 ${approval_id}`, err);
    }
  }
  if (dsKeys.length === 0) return [];
  const rows = await pool.query<Row>(
    `SELECT approval_id, user_id, user_name, sequence, visit_note,
            COALESCE(visit_detail->>'comm', '') AS comm,
            COALESCE(visit_detail->>'issues', '') AS issues
     FROM visits
     WHERE form_version = 'v2'
       AND (approval_id || '|' || user_id || '|' || sequence) = ANY($1)
       AND COALESCE(visit_detail->>'ai', '') <> ''`,
    [dsKeys]
  );
  return rows.rows;
}

async function main() {
  if (!isLlmConfigured()) {
    console.log("未配置 LLM_API_KEY，跳过（dry-run 也只展示待处理行）");
  }

  let rows: Row[];
  if (FORCE_DS) {
    rows = await findDsWrittenRows();
  } else {
    const aiFilter = FORCE
      ? // 臃肿判定：ai 长度 > 原始内容长度（原文本就一二十个字的行总结却写了一大段）
        `AND COALESCE(visit_detail->>'ai', '') <> ''
         AND LENGTH(visit_detail->>'ai') > LENGTH(COALESCE(visit_detail->>'comm', '') || COALESCE(visit_detail->>'issues', ''))`
      : `AND (visit_detail IS NULL OR COALESCE(visit_detail->>'ai', '') = '')`;
    const result = await pool.query<Row>(
      `SELECT approval_id, user_id, user_name, sequence, visit_note,
              COALESCE(visit_detail->>'comm', '') AS comm,
              COALESCE(visit_detail->>'issues', '') AS issues
       FROM visits
       WHERE form_version = 'v2'
         AND approval_id IS NOT NULL AND sequence IS NOT NULL
         ${aiFilter}
         AND (COALESCE(visit_detail->>'comm', '') <> '' OR COALESCE(visit_detail->>'issues', '') <> '')
       ORDER BY user_id, business_date, sequence`
    );
    rows = result.rows;
  }
  console.log(`待补 AI 总结的 v2 行：${rows.length} 条，dryRun=${DRY_RUN}，force=${FORCE}，forceDs=${FORCE_DS}`);

  // 样例预览
  for (const row of rows.slice(0, 10)) {
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
  for (const row of rows) {
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
