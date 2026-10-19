import "dotenv/config";
import { pool } from "../src/db";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  getOrCreateFolder,
  ensureEmployeeReportStructure,
  ReportType,
} from "../src/services/dingtalkDoc";
import { buildOrgTree, OrgTreeNode } from "../src/services/orgService";

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤行为分析报告";

const REPORT_TYPES: ReportType[] = ["日报", "周报", "月报"];

/**
 * 确保某节点下存在「部门报告 / {日报,周报,月报}」结构。
 * 返回部门报告文件夹节点。
 */
async function ensureDeptReportStructure(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  deptName: string
) {
  const deptFolder = await getOrCreateFolder(
    unionId,
    workspaceId,
    parentNodeId,
    deptName
  );
  const reportFolder = await getOrCreateFolder(
    unionId,
    workspaceId,
    deptFolder.nodeId,
    "部门报告"
  );
  for (const type of REPORT_TYPES) {
    await getOrCreateFolder(unionId, workspaceId, reportFolder.nodeId, type);
  }
  return deptFolder;
}

/**
 * 确保知识库根目录存在「公司报告 / {日报,周报,月报}」结构。
 */
async function ensureCompanyReportStructure(
  unionId: string,
  workspaceId: string,
  rootNodeId: string
) {
  const companyFolder = await getOrCreateFolder(
    unionId,
    workspaceId,
    rootNodeId,
    "公司报告"
  );
  for (const type of REPORT_TYPES) {
    await getOrCreateFolder(unionId, workspaceId, companyFolder.nodeId, type);
  }
}

async function getUserNameById(userId: string): Promise<string> {
  const result = await pool.query(
    "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return result.rows[0]?.user_name || userId;
}

async function ensureDeptNode(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  node: OrgTreeNode,
  stats: { depts: number; employees: number; failed: string[] }
) {
  const deptFolder = await ensureDeptReportStructure(
    unionId,
    workspaceId,
    parentNodeId,
    node.shortName
  );
  stats.depts++;
  console.log(`✅ ${node.name} 部门报告结构已就绪`);

  // 递归子部门
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      await ensureDeptNode(unionId, workspaceId, deptFolder.nodeId, child, stats);
    }
  }

  // 为叶子节点下的员工创建个人结构
  if (node.userIds && node.userIds.length > 0) {
    for (const userId of node.userIds) {
      const userName = await getUserNameById(userId);
      if (!userName || userName.trim() === "") {
        stats.failed.push(`${userId}(无姓名)`);
        continue;
      }
      try {
        await ensureEmployeeReportStructure(
          unionId,
          workspaceId,
          deptFolder.nodeId,
          userName.trim()
        );
        stats.employees++;
        console.log(`  ✅ ${userName} 个人结构已就绪`);
      } catch (err: any) {
        stats.failed.push(`${userName}: ${err.message}`);
        console.error(`  ❌ ${userName} 个人结构创建失败:`, err.message);
      }
    }
  }
}

async function main() {
  const operatorUserId = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operatorUserId) {
    console.error("请先配置 DINGTALK_OPERATOR_USERID");
    process.exit(1);
  }

  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";
  console.log(`使用知识库：${workspace.name} (${workspace.workspaceId})`);

  // 公司级报告结构
  await ensureCompanyReportStructure(unionId, workspace.workspaceId, rootNodeId);
  console.log("✅ 公司报告结构已就绪");

  // 部门/子部门/个人结构
  const tree = await buildOrgTree();
  const stats = { depts: 0, employees: 0, failed: [] as string[] };
  for (const dept of tree) {
    await ensureDeptNode(unionId, workspace.workspaceId, rootNodeId, dept, stats);
  }

  console.log("\n完成统计:");
  console.log(`  部门/子部门节点：${stats.depts} 个`);
  console.log(`  个人节点：${stats.employees} 人`);
  if (stats.failed.length > 0) {
    console.log(`  失败：${stats.failed.length} 个`);
    for (const f of stats.failed) console.log(`    - ${f}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("脚本失败:", err);
  process.exit(1);
});
