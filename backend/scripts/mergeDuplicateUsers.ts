#!/usr/bin/env ts-node
/**
 * 合并因钉钉同步逻辑导致的重复账号。
 *
 * 历史问题：早期钉钉同步用 user_name 生成 user_id，后来改用真实 userid，
 * 导致同一个人有两个账号（如 user_id="桂君" 和 user_id="0205662647848921"）。
 *
 * 本脚本将姓名账号的所有数据迁移到数字 userid 账号下，并删除姓名账号。
 * 之后钉钉同步代码已修复为始终使用 originator_userid 作为 user_id。
 *
 * 用法：
 *   cd backend && npx ts-node scripts/mergeDuplicateUsers.ts [--dry-run]
 */
import dotenv from "dotenv";
import { pool } from "../src/db";

dotenv.config();

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

interface DuplicatePair {
  name_user_id: string;
  numeric_user_id: string;
  user_name: string;
}

async function findDuplicatePairs(): Promise<DuplicatePair[]> {
  const result = await pool.query(
    `SELECT n.user_id as name_user_id,
            n.user_name,
            nu.user_id as numeric_user_id
     FROM users n
     JOIN users nu ON n.user_name = nu.user_name
     WHERE n.user_id !~ '^[0-9]+$'
       AND nu.user_id ~ '^[0-9]+$'
     ORDER BY n.user_name`
  );
  return result.rows as DuplicatePair[];
}

async function mergePair(pair: DuplicatePair): Promise<void> {
  const { name_user_id, numeric_user_id, user_name } = pair;
  console.log(`[merge] ${name_user_id} -> ${numeric_user_id} (${user_name})`);

  // risk_summary_cache 有 (user_id, date) 唯一约束，直接 UPDATE 可能冲突。
  // 先删除两个账号在该表中的记录，合并完后再统一刷新。
  const cacheDeleteRes = await pool.query(
    `DELETE FROM risk_summary_cache WHERE user_id IN ($1, $2)`,
    [name_user_id, numeric_user_id]
  );
  console.log(`  [risk_summary_cache] cleared ${cacheDeleteRes.rowCount || 0} rows before merge`);

  // 需要迁移 user_id 的表（不包括 users 本身）
  const tables = [
    "visits",
    "routes",
    "stops",
    "anomalies",
    "anomaly_exceptions",
    "feedback",
  ];

  for (const table of tables) {
    const res = await pool.query(
      `UPDATE ${table}
       SET user_id = $1
       WHERE user_id = $2`,
      [numeric_user_id, name_user_id]
    );
    console.log(`  [${table}] updated ${res.rowCount || 0} rows`);
  }

  // 删除旧的姓名账号
  const deleteRes = await pool.query(
    `DELETE FROM users WHERE user_id = $1 RETURNING id`,
    [name_user_id]
  );
  console.log(`  [users] deleted ${deleteRes.rowCount || 0} old account(s)`);
}

async function main() {
  console.log(
    `[mergeDuplicateUsers] start. dryRun=${DRY_RUN}, env=${process.env.NODE_ENV || "default"}`
  );

  const pairs = await findDuplicatePairs();
  console.log(`[mergeDuplicateUsers] found ${pairs.length} duplicate pairs`);

  if (pairs.length === 0) {
    console.log("[mergeDuplicateUsers] nothing to merge.");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("[mergeDuplicateUsers] dry-run: would merge following pairs:");
    for (const pair of pairs) {
      console.log(`  ${pair.name_user_id} -> ${pair.numeric_user_id} (${pair.user_name})`);
    }
    await pool.end();
    return;
  }

  for (const pair of pairs) {
    await mergePair(pair);
  }

  console.log("[mergeDuplicateUsers] done");
  await pool.end();
}

main().catch((err) => {
  console.error("[mergeDuplicateUsers] fatal error:", err);
  process.exit(1);
});
