import dotenv from "dotenv";
import { Pool } from "pg";
import { getAccessToken } from "../src/services/dingtalk";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// super_admin 用户（钉钉 userid）
const SUPER_ADMIN_USERIDS = new Set([
  "02395740281223048", // 陈盐/陈总
  "0115001229181213647", // 陈列
]);

interface DeptLeaderInfo {
  dept_id: number;
  dept_name: string;
  manager_userids: string[];
}

async function fetchDepartmentLeader(deptId: number): Promise<DeptLeaderInfo | null> {
  try {
    const accessToken = await getAccessToken();
    const res = await fetch(`https://oapi.dingtalk.com/topapi/v2/department/get?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dept_id: deptId, language: "zh_CN" }),
    });
    const data: any = await res.json();
    if (data.errcode !== 0) {
      console.warn(`[dept/get] dept_id=${deptId} failed: ${data.errmsg}`);
      return null;
    }
    const result: any = data.result || {};
    return {
      dept_id: deptId,
      dept_name: result.name || "",
      manager_userids: result.dept_manager_userid_list || [],
    };
  } catch (err: any) {
    console.warn(`[dept/get] dept_id=${deptId} error: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log("=== F9.5 Step 3: 初始化 leader 与 super_admin 角色 ===\n");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. 确保字段存在
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_dept_ids BIGINT[] DEFAULT '{}'`);

    // 2. 获取所有部门
    const depts = await client.query<{ dept_id: number; name: string }>(
      `SELECT dept_id, name FROM dingtalk_departments ORDER BY dept_id`
    );
    console.log(`共 ${depts.rows.length} 个部门，开始获取 leader...\n`);

    // 3. 收集每个部门的 leader
    const userLeaderDepts = new Map<string, number[]>();
    let fetchedCount = 0;

    for (const dept of depts.rows) {
      const info = await fetchDepartmentLeader(dept.dept_id);
      if (!info) continue;
      fetchedCount++;

      if (info.manager_userids.length > 0) {
        console.log(`${info.dept_name} (dept_id=${info.dept_id}) leader: ${info.manager_userids.join(", ")}`);
        for (const userid of info.manager_userids) {
          const existing = userLeaderDepts.get(userid) || [];
          if (!existing.includes(dept.dept_id)) {
            existing.push(dept.dept_id);
          }
          userLeaderDepts.set(userid, existing);
        }
      }
    }
    console.log(`\n成功获取 ${fetchedCount} 个部门信息`);
    console.log(`共有 ${userLeaderDepts.size} 个 leader 用户\n`);

    // 4. 更新 users 表 leader_dept_ids
    let updatedLeaders = 0;
    for (const [userid, deptIds] of userLeaderDepts.entries()) {
      const result = await client.query(
        `
        INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid, is_super_admin, leader_dept_ids)
        VALUES ($1, $1, NULL, 'staff', false, false, false, $2)
        ON CONFLICT (user_id) DO UPDATE SET
          leader_dept_ids = EXCLUDED.leader_dept_ids
      `,
        [userid, deptIds]
      );
      if (result.rowCount && result.rowCount > 0) updatedLeaders++;
    }
    console.log(`更新 leader 角色：${updatedLeaders} 人`);

    // 5. 设置 super_admin，并从钉钉获取真实姓名
    const superAdminNames = await client.query<{ userid: string; name: string }>(
      `SELECT userid, name FROM dingtalk_users WHERE userid IN ('${[...SUPER_ADMIN_USERIDS].join("','")}')`
    );
    const nameMap = new Map(superAdminNames.rows.map((u) => [u.userid, u.name]));

    let updatedSuperAdmin = 0;
    for (const userid of SUPER_ADMIN_USERIDS) {
      const userName = nameMap.get(userid) || userid;
      const result = await client.query(
        `
        UPDATE users
        SET is_super_admin = true, user_name = $2
        WHERE user_id = $1
      `,
        [userid, userName]
      );
      if (result.rowCount && result.rowCount > 0) {
        updatedSuperAdmin++;
        console.log(`设置 super_admin: ${userName} (${userid})`);
      } else {
        // 如果 users 表没有该用户，插入一条占位记录
        await client.query(
          `
          INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid, is_super_admin, leader_dept_ids)
          VALUES ($1, $2, NULL, 'admin', false, false, true, '{}')
          ON CONFLICT (user_id) DO UPDATE SET is_super_admin = true
        `,
          [userid, userName]
        );
        updatedSuperAdmin++;
        console.log(`设置 super_admin（新建用户）: ${userName} (${userid})`);
      }
    }
    console.log(`\n更新 super_admin：${updatedSuperAdmin} 人`);

    // 6. 输出汇总
    const summary = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_super_admin) AS super_admin_count,
        COUNT(*) FILTER (WHERE leader_dept_ids <> '{}') AS leader_count
      FROM users
    `);
    console.log("\n--- 角色汇总 ---");
    console.log(`super_admin：${summary.rows[0].super_admin_count} 人`);
    console.log(`leader：${summary.rows[0].leader_count} 人`);

    await client.query("COMMIT");
    console.log("\n=== leader 与 super_admin 初始化完成 ===");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("执行失败：", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
