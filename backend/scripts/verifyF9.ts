import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("=== visits.department 分布 ===");
  const depts = await pool.query(
    `SELECT department, COUNT(*) AS count FROM visits GROUP BY department ORDER BY count DESC`
  );
  for (const row of depts.rows) {
    console.log(`  ${row.department}: ${row.count}`);
  }

  console.log("\n=== 跨部门用户 ===");
  const cross = await pool.query(`
    SELECT user_id, user_name,
           COUNT(DISTINCT SPLIT_PART(department, ',', 1)) AS dept_count,
           ARRAY_AGG(DISTINCT SPLIT_PART(department, ',', 1)) AS departments
    FROM visits
    GROUP BY user_id, user_name
    HAVING COUNT(DISTINCT SPLIT_PART(department, ',', 1)) > 1
  `);
  console.log(`共 ${cross.rows.length} 人`);
  for (const row of cross.rows) {
    console.log(`  ${row.user_name} (${row.user_id}): ${row.departments.join(", ")}`);
  }

  console.log("\n=== super_admin ===");
  const admins = await pool.query(
    `SELECT user_id, user_name, is_super_admin, leader_dept_ids FROM users WHERE is_super_admin`
  );
  for (const row of admins.rows) {
    console.log(`  ${row.user_name} (${row.user_id}): super_admin=${row.is_super_admin}`);
  }

  console.log("\n=== 销售部子部门 leader ===");
  const leaders = await pool.query(`
    SELECT DISTINCT u.user_id, u.user_name, d.name AS dept_name
    FROM users u
    LEFT JOIN dingtalk_departments d ON d.dept_id = ANY(u.leader_dept_ids)
    WHERE u.leader_dept_ids <> '{}'
      AND d.parent_id = 435668139
    ORDER BY d.name
  `);
  for (const row of leaders.rows) {
    console.log(`  ${row.dept_name}: ${row.user_name} (${row.user_id})`);
  }

  console.log("\n=== 无效/离职账号 ===");
  const special = await pool.query(
    `SELECT user_id, user_name, is_resigned, is_invalid FROM users WHERE is_resigned OR is_invalid`
  );
  for (const row of special.rows) {
    console.log(`  ${row.user_name} (${row.user_id}): resigned=${row.is_resigned}, invalid=${row.is_invalid}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
