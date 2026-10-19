import {
  getOperatorUnionId,
  listWorkspaces,
  getOrCreateWorkspace,
  listNodes,
  getOrCreateFolder,
  createDoc,
  overwriteDocContent,
  addDocMember,
} from "../src/services/dingtalkDoc";
import { getUserDetail } from "../src/services/dingtalk";

// 测试配置：
// OPERATOR_USER_ID 是执行创建/写入操作的管理员钉钉 user_id，所有文档都由该管理员创建。
// EMPLOYEE_NAME 仅用于在知识库中创建员工文件夹，方便归档；文档创建者仍是管理员。
const OPERATOR_USER_ID = process.env.DINGTALK_OPERATOR_USERID || "046956096126259111";
const EMPLOYEE_USER_ID = "046956096126259111"; // 李朝晖的钉钉 user_id
const EMPLOYEE_NAME = "李朝晖";
const WORKSPACE_NAME = "外勤行为报告测试";

async function main() {
  try {
    console.log("=== Step 0: get operator unionId ===");
    console.log("using operatorUserId:", OPERATOR_USER_ID);
    const unionId = await getOperatorUnionId();
    console.log("operator unionId:", unionId);

    console.log("\n=== Step 1: list workspaces ===");
    const workspaces = await listWorkspaces(unionId);
    console.log("workspaces count:", workspaces.length);
    console.log("workspaces:", JSON.stringify(workspaces.slice(0, 5), null, 2));

    console.log("\n=== Step 2: get or create workspace ===");
    const workspace = await getOrCreateWorkspace(unionId, WORKSPACE_NAME);
    console.log("workspace:", JSON.stringify(workspace, null, 2));

    console.log("\n=== Step 3: list root nodes ===");
    const rootNodes = await listNodes(
      unionId,
      workspace.workspaceId,
      workspace.rootNodeId || "root"
    );
    console.log("root nodes:", JSON.stringify(rootNodes.slice(0, 5), null, 2));

    console.log("\n=== Step 4: get or create employee folder ===");
    const folder = await getOrCreateFolder(
      unionId,
      workspace.workspaceId,
      workspace.rootNodeId || "root",
      EMPLOYEE_NAME
    );
    console.log("folder:", JSON.stringify(folder, null, 2));

    console.log("\n=== Step 5: create doc ===");
    const docName = `${EMPLOYEE_NAME}_2026-06-23_外勤日报`;
    const doc = await createDoc(
      unionId,
      workspace.workspaceId,
      folder.nodeId,
      docName
    );
    console.log("created doc:", JSON.stringify(doc, null, 2));

    console.log("\n=== Step 6: write markdown content ===");
    const markdown = `# ${EMPLOYEE_NAME} 外勤日报

> 测试文档，由销售外勤行为分析系统自动生成。

## 基本信息

- 员工：${EMPLOYEE_NAME}
- 日期：2026-06-23
- 状态：测试中

## 轨迹摘要

1. 09:00 出发点
2. 10:30 客户 A
3. 14:00 客户 B

## 里程

- 填报里程：120 km
- 估算里程：115 km

---

*本报告仅供内部核对使用。*
`;
    await overwriteDocContent(doc.docKey, unionId, markdown);
    console.log("content written successfully");

    console.log("\n=== Step 7: grant employee access to folder ===");
    const employeeDetail = await getUserDetail(EMPLOYEE_USER_ID);
    const employeeUnionId = employeeDetail?.unionid || employeeDetail?.unionId;
    if (!employeeUnionId) {
      console.warn("无法获取员工 unionId，跳过授权");
    } else {
      // 尝试用文档创建返回的 workspaceId 给文件夹授权
      // 钉钉有两种 workspaceId：wiki 2.0 的（gjvAqSMWVOG94mvX）和 doc 1.0 的（oqvGp36lWZ2NEmDy）
      // addDocMember 需要 doc 1.0 的 workspaceId
      const docWorkspaceId = doc.workspaceId;
      try {
        await addDocMember(
          docWorkspaceId,
          folder.nodeId,
          unionId,
          employeeUnionId,
          "VIEWER"
        );
        console.log(`已授权 ${EMPLOYEE_NAME}(${EMPLOYEE_USER_ID}) 查看文件夹`);
      } catch (err: any) {
        console.warn(`用 doc workspaceId 授权文件夹失败: ${err.message}，尝试授权文档本身`);
        await addDocMember(
          docWorkspaceId,
          doc.nodeId,
          unionId,
          employeeUnionId,
          "VIEWER"
        );
        console.log(`已授权 ${EMPLOYEE_NAME}(${EMPLOYEE_USER_ID}) 查看文档`);
      }
    }

    console.log("\n=== 测试完成 ===");
    console.log(`文档 URL: ${doc.url}`);
  } catch (err: any) {
    console.error("测试失败:", err.message);
    console.error(err);
    process.exit(1);
  }
}

main();
