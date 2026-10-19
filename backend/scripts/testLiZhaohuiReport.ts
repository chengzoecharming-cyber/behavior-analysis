import "dotenv/config";
import { pool } from "../src/db";
import { buildOrgTree, OrgTreeNode } from "../src/services/orgService";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  listNodes,
  createDoc,
  overwriteDocContent,
  findDocNodeByName,
  inferReportType,
  ReportType,
} from "../src/services/dingtalkDoc";
import { computeUserOverview } from "../src/services/userOverviewService";
import { renderConsoleReportMarkdown } from "../src/services/exportConsoleReportMarkdown";

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤行为分析报告";
const TEST_USER_ID = "046956096126259111"; // 李朝晖
const TEST_DATE = "2026-07-16";

/** 忽略「XX. 」序号前缀匹配名称 */
function baseNameMatch(nodeName: string, target: string): boolean {
  const normalized = nodeName.replace(/^\d+\.\s*/, "").trim();
  return normalized === target;
}

async function findFolder(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  targetName: string
) {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  return nodes.find((n) => n.type === "FOLDER" && baseNameMatch(n.name, targetName)) || null;
}

async function findUserReportFolder(
  unionId: string,
  workspaceId: string,
  rootNodeId: string,
  userId: string,
  reportType: ReportType
): Promise<string | null> {
  const tree = await buildOrgTree();

  // 找到用户所在的叶子节点路径
  type FoundPath = { leaf: OrgTreeNode; parent: OrgTreeNode | null };
  let found: FoundPath | null = null;

  function find(node: OrgTreeNode, parent: OrgTreeNode | null): FoundPath | null {
    if (node.userIds?.includes(userId)) {
      return { leaf: node, parent };
    }
    if (node.children) {
      for (const child of node.children) {
        const result = find(child, node);
        if (result) return result;
      }
    }
    return null;
  }

  for (const dept of tree) {
    found = find(dept, null);
    if (found) break;
  }

  if (!found) {
    console.error("未找到用户在组织架构中的位置");
    return null;
  }

  const { leaf: leafNode, parent: parentNode } = found;
  console.log(
    `用户所在路径: ${parentNode ? parentNode.shortName + " / " : ""}${leafNode.shortName}`
  );

  // 逐级查找/创建文件夹（使用基础名称，忽略前缀）
  let currentNodeId = rootNodeId;

  // 部门（根）
  if (parentNode) {
    const deptFolder = await findFolder(
      unionId,
      workspaceId,
      currentNodeId,
      parentNode.shortName
    );
    if (!deptFolder) {
      console.error(`未找到部门文件夹: ${parentNode.shortName}`);
      return null;
    }
    currentNodeId = deptFolder.nodeId;
  }

  // 子部门/叶子部门
  const leafFolder = await findFolder(
    unionId,
    workspaceId,
    currentNodeId,
    leafNode.shortName
  );
  if (!leafFolder) {
    console.error(`未找到子部门文件夹: ${leafNode.shortName}`);
    return null;
  }
  currentNodeId = leafFolder.nodeId;

  // 员工姓名
  const userResult = await pool.query(
    "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  const userName = userResult.rows[0]?.user_name || userId;
  const employeeFolder = await findFolder(
    unionId,
    workspaceId,
    currentNodeId,
    userName
  );
  if (!employeeFolder) {
    console.error(`未找到员工文件夹: ${userName}`);
    return null;
  }
  currentNodeId = employeeFolder.nodeId;

  // 报告类型文件夹
  const typeFolder = await findFolder(
    unionId,
    workspaceId,
    currentNodeId,
    reportType
  );
  if (!typeFolder) {
    console.error(`未找到报告类型文件夹: ${reportType}`);
    return null;
  }

  return typeFolder.nodeId;
}

async function main() {
  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";

  console.log(`使用知识库：${workspace.name}`);

  const reportType = inferReportType(TEST_DATE, TEST_DATE).reportType;
  console.log(`报告类型：${reportType}`);

  const typeFolderId = await findUserReportFolder(
    unionId,
    workspace.workspaceId,
    rootNodeId,
    TEST_USER_ID,
    reportType
  );
  if (!typeFolderId) {
    console.error("无法定位到报告文件夹");
    process.exit(1);
  }

  // 生成报告数据
  const overview = await computeUserOverview(TEST_USER_ID, TEST_DATE, TEST_DATE);
  const visits = (
    await pool.query(
      `SELECT * FROM visits WHERE user_id = $1 AND business_date = $2::date ORDER BY timestamp`,
      [TEST_USER_ID, TEST_DATE]
    )
  ).rows;
  const routes = (
    await pool.query(
      `SELECT * FROM routes WHERE user_id = $1 AND business_date = $2::date ORDER BY id`,
      [TEST_USER_ID, TEST_DATE]
    )
  ).rows;

  const userResult = await pool.query(
    "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
    [TEST_USER_ID]
  );
  const userName = userResult.rows[0]?.user_name || TEST_USER_ID;

  const markdown = renderConsoleReportMarkdown({
    userName,
    start: TEST_DATE,
    end: TEST_DATE,
    reportType,
    overview,
    visits,
    routes,
  });

  // 文档名：2026-07-16_李朝晖_日报
  const docName = `${TEST_DATE}_${userName}_${reportType}`;

  // 检查是否已存在
  const existingDoc = await findDocNodeByName(
    unionId,
    workspace.workspaceId,
    typeFolderId,
    docName
  );

  let doc;
  if (existingDoc?.nodeId) {
    console.log("文档已存在，覆写内容...");
    await overwriteDocContent(existingDoc.nodeId, unionId, markdown);
    doc = {
      nodeId: existingDoc.nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${existingDoc.nodeId}`,
    };
  } else {
    console.log("创建新文档...");
    doc = await createDoc(
      unionId,
      workspace.workspaceId,
      typeFolderId,
      docName
    );
    await overwriteDocContent(doc.dentryUuid, unionId, markdown);
  }

  console.log("完成！");
  console.log("文档 URL:", doc.url);

  await pool.end();
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
