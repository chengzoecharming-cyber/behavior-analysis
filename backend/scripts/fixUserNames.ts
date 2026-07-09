#!/usr/bin/env ts-node
/**
 * 修复 visits/users 表中因钉钉通讯录权限不足而写入的数字 user_name。
 *
 * 用法：
 *   cd backend && npx ts-node scripts/fixUserNames.ts [--dry-run]
 *
 * 逻辑：
 *   1. 取出 visits 中 user_name 看起来是钉钉数字 userid 的 distinct user_id。
 *   2. 优先调用钉钉通讯录 topapi/v2/user/get 查询真实姓名。
 *   3. 通讯录查不到（如已离职员工）时，回退到智能人事花名册 topapi/smartwork/hrm/employee/list。
 *   4. 通过智能人事查到的员工标记为 is_resigned=true。
 *   5. 把查到的真实姓名写回 visits.user_name 和 users.user_name，并更新 users.is_resigned。
 *   6. 输出本次修复统计。
 */
import dotenv from "dotenv";
import { pool } from "../src/db";
import {
  getUserNameById,
  getHrmUserNameById,
} from "../src/services/dingtalk";

dotenv.config();

const DRY_RUN = process.argv.slice(2).includes("--dry-run");
const DELAY_MS = 150; // 钉钉 API 限流保护

function looksLikeNumericUserid(name: string | null): boolean {
  if (!name) return false;
  return /^[0-9]+$/.test(name.trim());
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(
    `[fixUserNames] start. dryRun=${DRY_RUN}, env=${process.env.NODE_ENV || "default"}`
  );

  // 1. 找出需要修复的用户
  const distinctRes = await pool.query(
    `SELECT DISTINCT user_id, user_name
     FROM visits
     WHERE user_name ~ '^[0-9]+$'
     ORDER BY user_id`
  );

  const candidates = distinctRes.rows.filter((r) =>
    looksLikeNumericUserid(r.user_name)
  );

  if (candidates.length === 0) {
    console.log("[fixUserNames] no numeric user_name found. nothing to do.");
    await pool.end();
    return;
  }

  console.log(`[fixUserNames] found ${candidates.length} numeric users to fix`);

  // 2. 查询钉钉真实姓名
  const nameMap = new Map<string, string>();
  const resignedMap = new Map<string, boolean>();
  const failed: string[] = [];

  for (const row of candidates) {
    const userId = row.user_id as string;
    const current = row.user_name as string;

    let realName: string | null = null;
    let isResigned = false;

    try {
      realName = await getUserNameById(userId);
      if (!realName) {
        // 通讯录查不到，尝试智能人事花名册（离职员工）
        realName = await getHrmUserNameById(userId);
        if (realName) {
          isResigned = true;
          console.log(`[fixUserNames] ${userId} -> ${realName} (via HRM, resigned)`);
        }
      } else {
        console.log(`[fixUserNames] ${userId} -> ${realName}`);
      }

      if (realName && realName !== current) {
        nameMap.set(userId, realName);
        if (isResigned) {
          resignedMap.set(userId, true);
        }
      } else if (!realName) {
        failed.push(userId);
        console.warn(`[fixUserNames] ${userId}: no real name returned`);
      } else {
        console.log(`[fixUserNames] ${userId}: name unchanged (${realName})`);
      }
    } catch (err: any) {
      failed.push(userId);
      console.warn(`[fixUserNames] ${userId}: query failed - ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  // 3. 写回数据库
  if (!DRY_RUN && nameMap.size > 0) {
    let visitsUpdated = 0;
    let usersUpdated = 0;
    let usersResignedUpdated = 0;

    for (const [userId, realName] of nameMap.entries()) {
      const vRes = await pool.query(
        `UPDATE visits
         SET user_name = $1
         WHERE user_id = $2 AND user_name ~ '^[0-9]+$'`,
        [realName, userId]
      );
      visitsUpdated += vRes.rowCount || 0;

      const isResigned = resignedMap.get(userId) || false;
      const uRes = await pool.query(
        `UPDATE users
         SET user_name = $1,
             is_resigned = $2
         WHERE user_id = $3`,
        [realName, isResigned, userId]
      );
      usersUpdated += uRes.rowCount || 0;

      if (isResigned && uRes.rowCount && uRes.rowCount > 0) {
        usersResignedUpdated += uRes.rowCount;
      }
    }

    console.log(
      `[fixUserNames] updated visits=${visitsUpdated}, users=${usersUpdated}, resigned=${usersResignedUpdated}`
    );
  } else if (DRY_RUN) {
    console.log(
      `[fixUserNames] dry-run: would update ${nameMap.size} users, skipped write`
    );
    if (resignedMap.size > 0) {
      console.log(
        `[fixUserNames] dry-run: resigned users=${Array.from(resignedMap.keys()).join(", ")}`
      );
    }
  }

  if (failed.length > 0) {
    console.warn(
      `[fixUserNames] failed count=${failed.length}, ids=${failed.join(", ")}`
    );
  }

  await pool.end();
  console.log("[fixUserNames] done");
}

main().catch((err) => {
  console.error("[fixUserNames] fatal error:", err);
  process.exit(1);
});
