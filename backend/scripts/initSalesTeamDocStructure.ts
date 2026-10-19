import "dotenv/config";
import { pool } from "../src/db";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  ensureEmployeeReportStructure,
} from "../src/services/dingtalkDoc";

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤行为分析报告";

async function main() {
  const operatorUserId = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operatorUserId) {
    console.error("请先配置 DINGTALK_OPERATOR_USERID");
    process.exit(1);
  }

  // 查询规范后的销售部/销售渠道相关同事（有姓名的）
  // 规则：department_aliases 中任意 alias 包含「销售」或「渠道」的 canonical_name 视为销售部门
  const result = await pool.query(
    `WITH sales_canonical AS (
       SELECT DISTINCT canonical_name
       FROM department_aliases
       WHERE canonical_name IS NOT NULL
         AND canonical_name <> ''
         AND EXISTS (
           SELECT 1
           FROM unnest(string_to_array(alias, ',')) AS a
           WHERE trim(a) ILIKE '%销售%' OR trim(a) ILIKE '%渠道%'
         )
     )
     SELECT DISTINCT u.user_id, u.user_name, u.department, da.canonical_name
     FROM users u
     JOIN department_aliases da ON u.department = ANY(string_to_array(da.alias, ','))
     JOIN sales_canonical sc ON da.canonical_name = sc.canonical_name
     WHERE u.user_name IS NOT NULL
       AND TRIM(u.user_name) <> ''
     ORDER BY da.canonical_name, u.user_name`
  );

  if (result.rows.length === 0) {
    console.log("未找到销售部相关同事");
    return;
  }

  console.log(`即将为 ${result.rows.length} 位销售部同事创建文档目录结构：`);
  for (const row of result.rows) {
    console.log(`  - ${row.user_name} (${row.department})`);
  }

  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";
  console.log(`\n使用知识库：${workspace.name} (${workspace.workspaceId})`);

  let success = 0;
  let failed = 0;
  for (const row of result.rows) {
    const employeeName = row.user_name.trim();
    try {
      await ensureEmployeeReportStructure(
        unionId,
        workspace.workspaceId,
        rootNodeId,
        employeeName
      );
      console.log(`✅ ${employeeName} 目录结构已就绪`);
      success++;
    } catch (err: any) {
      console.error(`❌ ${employeeName} 创建失败:`, err.message);
      failed++;
    }
  }

  console.log(`\n完成：成功 ${success} 人，失败 ${failed} 人`);
  await pool.end();
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exit(1);
});
