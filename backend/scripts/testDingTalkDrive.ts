import { getOrCreateSpace, getOrCreateFolder, uploadFileToDrive, addDrivePermission } from "../src/services/dingtalkDrive";
import { getUserDetail } from "../src/services/dingtalk";
import fs from "fs";
import path from "path";
import os from "os";

async function main() {
  try {
    console.log("=== Step 0: get unionId ===");
    const userDetail = await getUserDetail("046956096126259111");
    const unionId = userDetail?.unionid || userDetail?.unionId;
    console.log("unionId:", unionId);
    if (!unionId) {
      throw new Error("无法获取 unionId");
    }

    console.log("\n=== Step 1: get or create space ===");
    const space = await getOrCreateSpace("外勤日报测试", unionId);
    console.log("space:", space);

    console.log("\n=== Step 2: get or create folder ===");
    const rootFolderId = "0"; // 大多数云盘根目录用 0
    const folderId = await getOrCreateFolder(space.spaceId, rootFolderId, "李朝晖", unionId);
    console.log("folderId:", folderId);

    console.log("\n=== Step 3: create a test file ===");
    const testFile = path.join(os.tmpdir(), `dingtalk-drive-test-${Date.now()}.html`);
    fs.writeFileSync(testFile, "<html><body><h1>测试外勤日报</h1><p>这是从系统上传到钉钉云盘的测试文件。</p></body></html>", "utf-8");

    console.log("\n=== Step 4: upload file ===");
    const fileId = await uploadFileToDrive(space.spaceId, folderId, testFile, `李朝晖_2026-06-23_外勤日报.html`);
    console.log("fileId:", fileId);

    console.log("\n=== Step 5: add permission ===");
    // 这里用李朝晖的 user_id，从前面的数据库查询知道是 '046956096126259111'
    await addDrivePermission(space.spaceId, folderId, "046956096126259111", "viewer");

    console.log("\n=== 测试完成 ===");
    console.log(`文件已上传到云盘，文件夹 ID: ${folderId}，文件 ID: ${fileId}`);

    fs.unlinkSync(testFile);
  } catch (err: any) {
    console.error("测试失败:", err.message);
    console.error(err);
    process.exit(1);
  }
}

main();
