import "dotenv/config";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  listNodes,
} from "../src/services/dingtalkDoc";

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤行为分析报告";

async function printChildren(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  indent = ""
) {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  for (const node of nodes) {
    console.log(`${indent}- ${node.name} (${node.type})`);
    if (node.type === "FOLDER") {
      await printChildren(unionId, workspaceId, node.nodeId, indent + "  ");
    }
  }
}

async function main() {
  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";
  console.log(`知识库：${workspace.name}`);
  await printChildren(unionId, workspace.workspaceId, rootNodeId);
}

main().catch((err) => {
  console.error("失败:", err);
  process.exit(1);
});
