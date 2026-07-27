/**
 * 新增/更新公司地址白名单（company_addresses）。
 * 命中公司地址的签到不计入报告客户统计（对全体员工生效）。
 *
 * 用法：cd backend && npx ts-node scripts/upsertCompanyAddress.ts "创维数字大厦" "广东省深圳市宝安区石岩街道创维数字大厦"
 *   地址会立即地理编码并持久化坐标；解析失败时仍写入文本（文本匹配可用），并提示人工兜底。
 */
import { pool, initDB } from "../src/db";
import { geocodeAddressWithSimplification } from "../src/services/geocoding";

async function main() {
  const [name, address] = process.argv.slice(2);
  if (!name || !address) {
    console.error('用法: npx ts-node scripts/upsertCompanyAddress.ts "<名称>" "<地址>"');
    process.exit(1);
  }

  await initDB();

  const geo = await geocodeAddressWithSimplification(address);
  await pool.query(
    `INSERT INTO company_addresses (name, address, lat, lng)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
    [name, address, geo?.coords.lat ?? null, geo?.coords.lng ?? null]
  );

  if (geo) {
    const suffix = geo.usedAddress !== address ? `（用「${geo.usedAddress}」简化命中）` : "";
    console.log(`已写入公司地址: ${name} | ${address} → ${geo.coords.lat},${geo.coords.lng} ${suffix}`);
  } else {
    console.log(`已写入公司地址: ${name} | ${address}（地理编码失败，仅文本匹配生效；可人工写入坐标后重跑）`);
  }

  const all = await pool.query(`SELECT name, address, lat, lng FROM company_addresses ORDER BY id`);
  console.log(`\n当前公司地址白名单共 ${all.rows.length} 条：`);
  for (const row of all.rows) {
    console.log(`  - ${row.name} | ${row.address} | ${row.lat ?? "-"},${row.lng ?? "-"}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Upsert failed:", err);
  process.exit(1);
});
