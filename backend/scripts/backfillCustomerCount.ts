/**
 * 回填 visits.customer_count（一个打卡点多家客户 = 多次拜访）。
 *
 * 只处理 customer_name 含分隔符 [,，、] 的行（v1 历史数据中存在逗号连接的多客户），
 * 其余行保持默认 1：v1/Excel 单客户本就为 1，v2 数据已由解析器写入准确值。
 * 幂等，可重复执行。
 *
 * 用法：
 *   npx ts-node scripts/backfillCustomerCount.ts        # 实际执行
 *   npx ts-node scripts/backfillCustomerCount.ts --dry  # 只预览，不写库
 */
import { pool } from "../src/db";

const DRY_RUN = process.argv.includes("--dry");

async function main() {
  const preview = await pool.query(
    `SELECT id, customer_name,
            (SELECT COUNT(*) FROM unnest(string_to_array(regexp_replace(customer_name, '[，、]', ',', 'g'), ',')) AS t(part) WHERE btrim(part) <> '') AS n
     FROM visits
     WHERE customer_name ~ '[,，、]'
     ORDER BY id`
  );
  console.log(`含多客户名的签到共 ${preview.rows.length} 行：`);
  for (const row of preview.rows.slice(0, 20)) {
    console.log(`  #${row.id} (${row.n} 家) ${row.customer_name}`);
  }
  if (preview.rows.length > 20) console.log(`  ... 其余 ${preview.rows.length - 20} 行省略`);

  if (DRY_RUN) {
    console.log("\n(dry-run，未写库)");
    return;
  }

  const result = await pool.query(
    `UPDATE visits v
     SET customer_count = sub.n
     FROM (
       SELECT id, COUNT(*) AS n
       FROM visits,
            LATERAL unnest(string_to_array(regexp_replace(customer_name, '[，、]', ',', 'g'), ',')) AS t(part)
       WHERE customer_name ~ '[,，、]' AND btrim(part) <> ''
       GROUP BY id
     ) sub
     WHERE v.id = sub.id AND v.customer_count <> sub.n`
  );
  console.log(`\ncustomer_count 更新 ${result.rowCount} 行`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
