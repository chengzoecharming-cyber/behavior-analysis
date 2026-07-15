import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  console.log("=== F9.5 Step 2: 销售渠道数据并入销售部 ===\n");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. 找到销售部及其子部门
    const salesDept = await client.query<{ dept_id: string }>(
      `SELECT dept_id FROM dingtalk_departments WHERE name = '销售部' LIMIT 1`
    );
    if (salesDept.rows.length === 0) {
      throw new Error("钉钉部门树中未找到「销售部」");
    }
    const salesDeptId = salesDept.rows[0].dept_id;

    const salesSubDepts = await client.query<{ dept_id: string; name: string }>(
      `SELECT dept_id, name FROM dingtalk_departments WHERE parent_id = $1 ORDER BY dept_id`,
      [salesDeptId]
    );
    const salesSubDeptMap = new Map(salesSubDepts.rows.map((d) => [Number(d.dept_id), d.name]));

    // 加载已初始化的 leader 信息（若已执行 f9InitLeaderRoles）
    const userLeaderDepts = await client.query<{
      user_id: string;
      leader_dept_ids: (number | string)[];
    }>(`SELECT user_id, leader_dept_ids FROM users WHERE leader_dept_ids <> '{}'`);
    const leaderDeptMap = new Map(
      userLeaderDepts.rows.map((u) => [u.user_id, u.leader_dept_ids.map((id) => Number(id))])
    );
    console.log(`销售部子部门（${salesSubDepts.rows.length} 个）：`);
    for (const d of salesSubDepts.rows) {
      console.log(`  ${d.name} (dept_id=${d.dept_id})`);
    }
    console.log("");

    // 2. 找到所有销售渠道相关的 visits 记录
    const channelVisits = await client.query<{
      id: number;
      user_id: string;
      user_name: string;
      department: string;
    }>(`
      SELECT id, user_id, user_name, department
      FROM visits
      WHERE department LIKE '销售渠道%'
      ORDER BY user_id, timestamp
    `);
    console.log(`销售渠道相关 visits 记录：${channelVisits.rows.length} 条\n`);

    // 3. 加载这些用户在钉钉中的部门归属
    const userIds = [...new Set(channelVisits.rows.map((v) => v.user_id))];
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
    const dingtalkUsers =
      userIds.length > 0
        ? await client.query<{
            userid: string;
            name: string;
            dept_id_list: string;
          }>(
            `SELECT userid, name, dept_id_list FROM dingtalk_users WHERE userid IN (${placeholders})`,
            userIds
          )
        : { rows: [] };
    const dingtalkUserMap = new Map(dingtalkUsers.rows.map((u) => [u.userid, u]));

    // 4. 为每条记录判断是否能合并到销售部子部门
    let mergedCount = 0;
    let skippedCount = 0;
    const mergeLog: string[] = [];

    for (const visit of channelVisits.rows) {
      const dtUser = dingtalkUserMap.get(visit.user_id);
      if (!dtUser) {
        skippedCount++;
        mergeLog.push(`SKIP [id=${visit.id}] ${visit.user_name}(${visit.user_id}): 钉钉中找不到该用户`);
        continue;
      }

      if (!dtUser.dept_id_list) {
        skippedCount++;
        mergeLog.push(`SKIP [id=${visit.id}] ${visit.user_name}(${visit.user_id}): dept_id_list 为空`);
        continue;
      }

      const userDeptIds: number[] = (dtUser.dept_id_list || "")
        .replace(/[{}"]/g, "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      // 1. 优先取该用户是 leader 的销售部子部门
      const leaderDeptIds = (leaderDeptMap.get(visit.user_id) || []).map(Number);
      const leaderSalesSubDeptIds = leaderDeptIds.filter((id) => salesSubDeptMap.has(id));

      // 2. 其次取用户所属的销售部子部门
      const memberSalesSubDeptIds = userDeptIds.filter((id) => salesSubDeptMap.has(id));

      const matchedSubDeptIds = leaderSalesSubDeptIds.length > 0
        ? leaderSalesSubDeptIds
        : memberSalesSubDeptIds;

      if (matchedSubDeptIds.length === 0) {
        skippedCount++;
        mergeLog.push(
          `SKIP [id=${visit.id}] ${visit.user_name}(${visit.user_id}): 不属于任何销售部子部门，depts=[${userDeptIds.join(",")}]`
        );
        continue;
      }

      // 如果匹配到多个销售部子部门，取第一个
      const targetDeptId = matchedSubDeptIds[0];
      const targetDeptName = salesSubDeptMap.get(targetDeptId)!;
      const newDepartment = `销售部-${targetDeptName}`;

      await client.query(`UPDATE visits SET department = $1 WHERE id = $2`, [
        newDepartment,
        visit.id,
      ]);

      mergedCount++;
      if (mergedCount <= 20 || visit.department !== newDepartment) {
        mergeLog.push(
          `MERGE [id=${visit.id}] ${visit.user_name}: ${visit.department} → ${newDepartment}`
        );
      }
    }

    console.log(`销售渠道 → 销售部子部门：${mergedCount} 条`);
    console.log(`保持原样：${skippedCount} 条\n`);

    // 第二轮：修正销售部子部门内部归属
    // 如果某用户在钉钉里只属于一个销售部子部门，但 visits 里出现在其他销售部子部门，统一归并
    console.log("--- 第二轮：修正销售部子部门内部错误归属 ---");
    let normalizedCount = 0;

    for (const dtUser of dingtalkUsers.rows) {
      const userDeptIds: number[] = (dtUser.dept_id_list || "")
        .replace(/[{}"]/g, "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const leaderDeptIds = (leaderDeptMap.get(dtUser.userid) || []).map(Number);
      const leaderSalesSubDeptIds = leaderDeptIds.filter((id) => salesSubDeptMap.has(id));
      const memberSalesSubDeptIds = userDeptIds.filter((id) => salesSubDeptMap.has(id));

      const matchedSubDeptIds = leaderSalesSubDeptIds.length > 0
        ? leaderSalesSubDeptIds
        : memberSalesSubDeptIds;

      if (matchedSubDeptIds.length === 0) continue;

      // 取第一个销售部子部门作为该用户的主销售子部门
      const primaryDeptId = matchedSubDeptIds[0];
      const primaryDeptName = salesSubDeptMap.get(primaryDeptId)!;
      const expectedDepartment = `销售部-${primaryDeptName}`;

      const result = await client.query(
        `UPDATE visits
         SET department = $1
         WHERE user_id = $2
           AND department LIKE '销售部-%'
           AND department <> $1`,
        [expectedDepartment, dtUser.userid]
      );

      if (result.rowCount && result.rowCount > 0) {
        normalizedCount += result.rowCount;
        mergeLog.push(`NORMALIZE ${dtUser.userid}: 统一归并到 ${expectedDepartment} (${result.rowCount} 条)`);
      }
    }

    console.log(`销售渠道用户对应销售部子部门归并：${normalizedCount} 条\n`);

    // 第三轮：修正所有销售部子部门记录（包括原本就在销售部但子部门错误的）
    console.log("--- 第三轮：修正所有销售部子部门错误归属 ---");
    let allNormalizedCount = 0;

    const allSalesDeptUsers = await client.query<{
      user_id: string;
      dept_id_list: string;
    }>(`
      SELECT DISTINCT du.userid AS user_id, du.dept_id_list
      FROM visits v
      JOIN dingtalk_users du ON v.user_id = du.userid
      WHERE v.department LIKE '销售部-%'
    `);

    for (const dtUser of allSalesDeptUsers.rows) {
      const userDeptIds: number[] = (dtUser.dept_id_list || "")
        .replace(/[{}"]/g, "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));

      const leaderDeptIds = (leaderDeptMap.get(dtUser.user_id) || []).map(Number);
      const leaderSalesSubDeptIds = leaderDeptIds.filter((id) => salesSubDeptMap.has(id));
      const memberSalesSubDeptIds = userDeptIds.filter((id) => salesSubDeptMap.has(id));

      const matchedSubDeptIds = leaderSalesSubDeptIds.length > 0
        ? leaderSalesSubDeptIds
        : memberSalesSubDeptIds;

      if (matchedSubDeptIds.length === 0) continue;

      const primaryDeptId = matchedSubDeptIds[0];
      const primaryDeptName = salesSubDeptMap.get(primaryDeptId)!;
      const expectedDepartment = `销售部-${primaryDeptName}`;

      const result = await client.query(
        `UPDATE visits
         SET department = $1
         WHERE user_id = $2
           AND department LIKE '销售部-%'
           AND department <> $1`,
        [expectedDepartment, dtUser.user_id]
      );

      if (result.rowCount && result.rowCount > 0) {
        allNormalizedCount += result.rowCount;
        mergeLog.push(`ALL-NORMALIZE ${dtUser.user_id}: 统一归并到 ${expectedDepartment} (${result.rowCount} 条)`);
      }
    }

    console.log(`全量销售部子部门归并：${allNormalizedCount} 条\n`);
    for (const log of mergeLog.slice(0, 80)) {
      console.log(log);
    }
    if (mergeLog.length > 80) {
      console.log(`... 还有 ${mergeLog.length - 80} 条日志未显示`);
    }

    await client.query("COMMIT");
    console.log("\n=== 销售渠道数据合并完成 ===");
    console.log(`销售渠道 → 销售部：${mergedCount} 条`);
    console.log(`销售部子部门内部修正：${normalizedCount + allNormalizedCount} 条`);
    console.log(`总计变更：${mergedCount + normalizedCount + allNormalizedCount} 条`);
    console.log("下一步：执行 f9InitLeaderRoles.ts");
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
