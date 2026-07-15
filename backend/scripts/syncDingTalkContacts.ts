import dotenv from "dotenv";
import { syncContacts } from "../src/services/dingtalk";

dotenv.config();

async function main() {
  console.log("开始同步钉钉通讯录...");
  console.log(`时间：${new Date().toISOString()}`);

  const result = await syncContacts();

  console.log("\n同步完成");
  console.log(`部门数：${result.departments}`);
  console.log(`用户数：${result.users}`);
  if (result.errors.length > 0) {
    console.log("\n错误：");
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }
}

main().catch((err) => {
  console.error("同步失败：", err);
  process.exit(1);
});
