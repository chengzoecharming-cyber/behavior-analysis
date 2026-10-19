import "dotenv/config";
import {
  exportConsoleReportToDingTalkDoc,
  inferReportType,
} from "../src/services/dingtalkDoc";

const OPERATOR_USER_ID = process.env.DINGTALK_OPERATOR_USERID || "";
const EMPLOYEE_USER_ID = process.env.TEST_EMPLOYEE_USER_ID || "046956096126259111";
const EMPLOYEE_NAME = process.env.TEST_EMPLOYEE_NAME || "李朝晖";
const WORKSPACE_NAME = process.env.TEST_WORKSPACE_NAME || "外勤行为报告测试";

async function main() {
  if (!OPERATOR_USER_ID) {
    console.error("请先配置 DINGTALK_OPERATOR_USERID");
    process.exit(1);
  }

  console.log("=== 测试报告类型推断 ===");
  console.log("单日:", inferReportType("2026-07-16", "2026-07-16"));
  console.log("整周:", inferReportType("2026-07-13", "2026-07-19"));
  console.log("整月:", inferReportType("2026-07-01", "2026-07-31"));
  console.log("其他:", inferReportType("2026-07-14", "2026-07-16"));

  console.log("\n=== 测试三级结构导出 ===");
  const markdown = `# ${EMPLOYEE_NAME} 外勤日报

> 测试文档，用于验证「知识库 / 员工 / 日报 / 日期_姓名_日报」三级结构。

## 汇总指标

| 指标 | 数值 |
|---|---|
| 拜访次数 | 3 次 |
| 填报里程 | 120 km |
| 估算里程 | 115 km |

## 行程

1. 09:00 客户 A
2. 14:00 客户 B
`;

  const result = await exportConsoleReportToDingTalkDoc({
    operatorUserId: OPERATOR_USER_ID,
    targetUserId: EMPLOYEE_USER_ID,
    targetUserName: EMPLOYEE_NAME,
    workspaceName: WORKSPACE_NAME,
    start: "2026-07-16",
    end: "2026-07-16",
    markdown,
  });

  console.log("导出结果:");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n=== 测试完成 ===");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
