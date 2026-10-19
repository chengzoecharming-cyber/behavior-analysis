import "dotenv/config";
import {
  getOperatorUnionId,
  getOrCreateWorkspace,
  listNodes,
  DocNode,
} from "../src/services/dingtalkDoc";

/**
 * 批量清理知识库中的文档（FILE 节点），保留文件夹结构。
 * 用法：
 *   npx ts-node scripts/cleanWikiDocs.ts          # 干跑，只列出将删除的文档
 *   npx ts-node scripts/cleanWikiDocs.ts --delete # 实际删除
 */

const WORKSPACE_NAME =
  process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";

const DINGTALK_API_BASE = "https://api.dingtalk.com";

async function collectFileNodes(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  pathPrefix = ""
): Promise<{ node: DocNode; path: string }[]> {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  const result: { node: DocNode; path: string }[] = [];
  for (const node of nodes) {
    const path = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
    if (node.type === "FOLDER") {
      result.push(
        ...(await collectFileNodes(unionId, workspaceId, node.nodeId, path))
      );
    } else {
      result.push({ node, path });
    }
  }
  return result;
}

async function deleteDocNode(
  accessToken: string,
  workspaceId: string,
  nodeId: string,
  operatorId: string
): Promise<void> {
  const url = `${DINGTALK_API_BASE}/v1.0/doc/workspaces/${workspaceId}/docs/${nodeId}?operatorId=${encodeURIComponent(
    operatorId
  )}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-acs-dingtalk-access-token": accessToken },
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.code) {
    throw new Error(`${data.message} (${data.code})`);
  }
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`${data.errmsg} (${data.errcode})`);
  }
}

async function main() {
  const doDelete = process.argv.includes("--delete");
  const unionId = await getOperatorUnionId();
  const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
  const rootNodeId = workspace.rootNodeId || "root";

  // --exclude <子串>：跳过路径包含该子串的文档（可多次传入）
  // --include <子串>：只处理路径包含该子串的文档（可多次传入，传入后其余忽略）
  const excludes: string[] = [];
  const includes: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--exclude" && process.argv[i + 1]) {
      excludes.push(process.argv[i + 1]);
      i++;
    }
    if (process.argv[i] === "--include" && process.argv[i + 1]) {
      includes.push(process.argv[i + 1]);
      i++;
    }
  }

  const all = await collectFileNodes(
    unionId,
    workspace.workspaceId,
    rootNodeId
  );
  const files = all.filter(
    (f) =>
      !excludes.some((ex) => f.path.includes(ex)) &&
      (includes.length === 0 || includes.some((inc) => f.path.includes(inc)))
  );

  console.log(
    `知识库：${workspace.name}，共发现 ${all.length} 个文档，排除 ${all.length - files.length} 个，待处理 ${files.length} 个`
  );
  for (const f of files) {
    console.log(`  ${f.path}`);
  }

  if (!doDelete) {
    console.log("\n干跑模式，未删除任何内容。加 --delete 参数执行实际删除。");
    return;
  }

  const { getAccessToken } = await import("../src/services/dingtalk");
  const accessToken = await getAccessToken();

  let success = 0;
  let failed = 0;
  for (const f of files) {
    try {
      await deleteDocNode(
        accessToken,
        workspace.workspaceId,
        f.node.nodeId,
        unionId
      );
      console.log(`已删除: ${f.path}`);
      success++;
    } catch (err: any) {
      console.error(`删除失败: ${f.path} -> ${err?.message || err}`);
      failed++;
    }
  }
  console.log(`\n完成：成功 ${success}，失败 ${failed}`);
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});
