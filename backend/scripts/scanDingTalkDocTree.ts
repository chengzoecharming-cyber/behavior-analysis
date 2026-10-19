import "dotenv/config";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  listNodes,
  DocNode,
} from "../src/services/dingtalkDoc";

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤行为分析报告";

async function scanTree(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  prefix = ""
): Promise<void> {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    console.log(`${prefix}${branch}${node.name} [${node.type}]`);
    if (node.type === "FOLDER") {
      await scanTree(
        unionId,
        workspaceId,
        node.nodeId,
        prefix + childPrefix
      );
    }
  }
}

async function main() {
  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";

  console.log(`知识库：${workspace.name} (${workspace.workspaceId})`);
  console.log(workspace.rootNodeId || "root");
  await scanTree(unionId, workspace.workspaceId, rootNodeId);
}

main().catch((err) => {
  console.error("扫描失败:", err);
  process.exit(1);
});
