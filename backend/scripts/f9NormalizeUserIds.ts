import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 已知分类（按 visits.user_name）
const INVALID_USER_NAMES = new Set(["白色帝豪", "蓝黑帝豪"]);
const RESIGNED_USER_NAMES = new Set(["黄柔菊", "李同邦"]);

interface UserMapping {
  oldUserId: string;
  oldUserName: string;
  newUserId: string | null;
  newUserName: string | null;
  primaryDept: string | null;
  status: "matched" | "resigned" | "invalid" | "unknown";
  matchBy: "userid" | "name" | "manual" | null;
}

async function main() {
  console.log("=== F9.5 Step 1: 全公司 user_id 归一化 ===\n");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. 加载 visits 中所有用户
    const visitsUsers = await client.query<{
      user_id: string;
      user_name: string;
      visit_count: number;
    }>(`
      SELECT user_id, user_name, COUNT(*) AS visit_count
      FROM visits
      GROUP BY user_id, user_name
      ORDER BY user_name
    `);
    console.log(`visits 中共有 ${visitsUsers.rows.length} 个不同用户`);

    // 2. 加载钉钉用户
    const dingtalkUsers = await client.query<{
      userid: string;
      name: string;
      title: string;
      source_dept_name: string;
    }>(`
      SELECT du.userid, du.name, du.title, dd.name AS source_dept_name
      FROM dingtalk_users du
      LEFT JOIN dingtalk_departments dd ON du.source_dept_id = dd.dept_id
    `);
    const dingtalkByUserId = new Map(dingtalkUsers.rows.map((u) => [u.userid, u]));
    const dingtalkByName = new Map(dingtalkUsers.rows.map((u) => [u.name, u]));
    console.log(`钉钉通讯录共有 ${dingtalkUsers.rows.length} 人\n`);

    // 3. 构建映射
    const mappings: UserMapping[] = visitsUsers.rows.map((vu) => {
      const oldUserId = vu.user_id;
      const oldUserName = vu.user_name;

      // 精确匹配
      const exactMatch = dingtalkByUserId.get(oldUserId);
      if (exactMatch) {
        return {
          oldUserId,
          oldUserName,
          newUserId: exactMatch.userid,
          newUserName: exactMatch.name,
          primaryDept: exactMatch.source_dept_name,
          status: "matched",
          matchBy: "userid",
        };
      }

      // 姓名匹配
      const nameMatch = dingtalkByName.get(oldUserName);
      if (nameMatch) {
        return {
          oldUserId,
          oldUserName,
          newUserId: nameMatch.userid,
          newUserName: nameMatch.name,
          primaryDept: nameMatch.source_dept_name,
          status: "matched",
          matchBy: "name",
        };
      }

      // 手动分类
      if (INVALID_USER_NAMES.has(oldUserName)) {
        return {
          oldUserId,
          oldUserName,
          newUserId: null,
          newUserName: null,
          primaryDept: null,
          status: "invalid",
          matchBy: "manual",
        };
      }

      if (RESIGNED_USER_NAMES.has(oldUserName)) {
        return {
          oldUserId,
          oldUserName,
          newUserId: null,
          newUserName: null,
          primaryDept: null,
          status: "resigned",
          matchBy: "manual",
        };
      }

      return {
        oldUserId,
        oldUserName,
        newUserId: null,
        newUserName: null,
        primaryDept: null,
        status: "unknown",
        matchBy: null,
      };
    });

    // 4. 打印映射报告
    console.log("--- 映射结果 ---");
    const matched = mappings.filter((m) => m.status === "matched");
    const nameMatched = matched.filter((m) => m.matchBy === "name");
    const resigned = mappings.filter((m) => m.status === "resigned");
    const invalid = mappings.filter((m) => m.status === "invalid");
    const unknown = mappings.filter((m) => m.status === "unknown");

    console.log(`精确匹配：${matched.length - nameMatched.length} 人`);
    console.log(`姓名匹配：${nameMatched.length} 人`);
    console.log(`已离职：${resigned.length} 人`);
    console.log(`无效账号：${invalid.length} 人`);
    console.log(`未知：${unknown.length} 人\n`);

    if (nameMatched.length > 0) {
      console.log("按姓名匹配的用户（需要修改 user_id）：");
      for (const m of nameMatched) {
        console.log(`  ${m.oldUserId} (${m.oldUserName}) → ${m.newUserId} (${m.newUserName})`);
      }
      console.log("");
    }

    if (unknown.length > 0) {
      console.log("未知用户（请人工确认）：");
      for (const m of unknown) {
        console.log(`  ${m.oldUserId} (${m.oldUserName})`);
      }
      console.log("");
    }

    // 如果还有未知用户，先不继续，避免误改
    if (unknown.length > 0) {
      console.error("存在未知用户，请先确认分类后再执行。");
      await client.query("ROLLBACK");
      process.exit(1);
    }

    // 5. 更新 visits.user_id
    let updatedVisits = 0;
    for (const m of mappings) {
      if (m.status === "matched" && m.newUserId && m.newUserId !== m.oldUserId) {
        const result = await client.query(
          `UPDATE visits SET user_id = $1, user_name = $2 WHERE user_id = $3`,
          [m.newUserId, m.newUserName, m.oldUserId]
        );
        updatedVisits += result.rowCount || 0;
      }
    }
    console.log(`visits 更新记录数：${updatedVisits}`);

    // 6. 更新 routes / stops 的 user_id
    let updatedRoutes = 0;
    let updatedStops = 0;
    for (const m of mappings) {
      if (m.status === "matched" && m.newUserId && m.newUserId !== m.oldUserId) {
        const r = await client.query(`UPDATE routes SET user_id = $1 WHERE user_id = $2`, [
          m.newUserId,
          m.oldUserId,
        ]);
        updatedRoutes += r.rowCount || 0;

        const s = await client.query(`UPDATE stops SET user_id = $1 WHERE user_id = $2`, [
          m.newUserId,
          m.oldUserId,
        ]);
        updatedStops += s.rowCount || 0;
      }
    }
    console.log(`routes 更新记录数：${updatedRoutes}`);
    console.log(`stops 更新记录数：${updatedStops}`);

    // 7. 清理并重建 users 表记录
    console.log("\n--- 同步 users 表 ---");

    for (const m of mappings) {
      if (m.status === "matched" && m.newUserId && m.newUserName) {
        await client.query(
          `
          INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid, is_super_admin, leader_dept_ids)
          VALUES ($1, $2, $3, 'staff', false, false, false, '{}')
          ON CONFLICT (user_id) DO UPDATE SET
            user_name = EXCLUDED.user_name,
            department = EXCLUDED.department,
            is_resigned = false,
            is_invalid = false
        `,
          [m.newUserId, m.newUserName, m.primaryDept]
        );
      } else if (m.status === "resigned") {
        await client.query(
          `
          INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid, is_super_admin, leader_dept_ids)
          VALUES ($1, $2, NULL, 'staff', true, false, false, '{}')
          ON CONFLICT (user_id) DO UPDATE SET
            user_name = EXCLUDED.user_name,
            is_resigned = true,
            is_invalid = false
        `,
          [m.oldUserId, m.oldUserName]
        );
      } else if (m.status === "invalid") {
        await client.query(
          `
          INSERT INTO users (user_id, user_name, department, role, is_resigned, is_invalid, is_super_admin, leader_dept_ids)
          VALUES ($1, $2, NULL, 'staff', false, true, false, '{}')
          ON CONFLICT (user_id) DO UPDATE SET
            user_name = EXCLUDED.user_name,
            is_resigned = false,
            is_invalid = true
        `,
          [m.oldUserId, m.oldUserName]
        );
      }
    }

    const usersCount = await client.query(`SELECT COUNT(*) AS count FROM users`);
    console.log(`users 表当前记录数：${usersCount.rows[0].count}`);

    // 8. 清理 anomalies 和 risk_summary_cache，后续脚本重新计算
    const deletedAnomalies = await client.query(`DELETE FROM anomalies`);
    console.log(`\n清理 anomalies：${deletedAnomalies.rowCount} 条`);

    const deletedRiskCache = await client.query(`DELETE FROM risk_summary_cache`);
    console.log(`清理 risk_summary_cache：${deletedRiskCache.rowCount} 条`);

    await client.query("COMMIT");
    console.log("\n=== user_id 归一化完成 ===");
    console.log("下一步：执行 f9MergeSalesChannelVisits.ts");
    console.log("完成后执行：npm run recompute:anomalies && npm run refresh:risk-cache all");
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
