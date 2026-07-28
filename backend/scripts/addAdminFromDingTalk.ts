import { pool } from "../src/db";
import { syncContacts, getDingTalkOrgUsers } from "../src/services/dingtalk";

/**
 * 从钉钉通讯录同步用户并指定为 admin。
 * 用法：cd backend && npx ts-node scripts/addAdminFromDingTalk.ts 李杰
 */
async function main() {
  const targetName = process.argv[2]?.trim();
  if (!targetName) {
    console.error("请指定姓名，例如：npx ts-node scripts/addAdminFromDingTalk.ts 李杰");
    process.exit(1);
  }

  console.log(`[AddAdmin] 开始同步钉钉通讯录，寻找「${targetName}」...`);
  const syncResult = await syncContacts();
  console.log(
    `[AddAdmin] 通讯录同步完成：${syncResult.departments} 个部门，${syncResult.users} 个用户，${syncResult.errors.length} 个错误`
  );
  if (syncResult.errors.length > 0) {
    for (const err of syncResult.errors) {
      console.warn(`  - ${err}`);
    }
  }

  const orgUsers = await getDingTalkOrgUsers();
  const matched = orgUsers.filter((u) => u.user_name === targetName);

  if (matched.length === 0) {
    console.error(`[AddAdmin] 钉钉通讯录中未找到「${targetName}」，请确认姓名或通讯录范围。`);
    process.exit(1);
  }

  if (matched.length > 1) {
    console.error(`[AddAdmin] 找到 ${matched.length} 个「${targetName}」，请通过 user_id 指定唯一用户：`);
    for (const u of matched) {
      console.error(`  - ${u.user_name} (${u.user_id}) / ${u.department || "无部门"}`);
    }
    process.exit(1);
  }

  const target = matched[0];
  console.log(
    `[AddAdmin] 找到唯一用户：${target.user_name} (${target.user_id}) / ${target.department || "无部门"}`
  );

  // 检查是否已存在
  const existing = await pool.query("SELECT id, role FROM users WHERE user_id = $1", [
    target.user_id,
  ]);

  if (existing.rows.length > 0) {
    const currentRole = existing.rows[0].role;
    if (currentRole === "admin") {
      console.log(`[AddAdmin] 用户已存在且已是 admin，无需修改。`);
      await pool.end();
      return;
    }
    console.log(`[AddAdmin] 用户已存在，当前角色 ${currentRole}，升级为 admin...`);
    await pool.query(
      `UPDATE users
       SET role = 'admin',
           is_invalid = false,
           is_resigned = false
       WHERE user_id = $1`,
      [target.user_id]
    );
  } else {
    console.log(`[AddAdmin] 在 users 表新建管理员记录...`);
    await pool.query(
      `INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid)
       VALUES ($1, $2, $3, 'admin', false, false)`,
      [target.user_id, target.user_name, target.department || null]
    );
  }

  console.log(`[AddAdmin] 完成：${target.user_name} (${target.user_id}) 已是 admin。`);
  await pool.end();
}

main().catch((err) => {
  console.error("[AddAdmin] 失败:", err.message);
  process.exit(1);
});
