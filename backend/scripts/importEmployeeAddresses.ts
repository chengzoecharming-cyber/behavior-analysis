import * as XLSX from "xlsx";
import { pool, initDB } from "../src/db";

interface AddressRow {
  name: string;
  address: string;
}

function normalize(value: string | undefined | null): string {
  return (value || "").trim();
}

async function main() {
  await initDB();

  const workbook = XLSX.readFile("../data/employee_addresses.xlsx");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // 首行是标题，第二行是表头
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, range: 1 });

  const entries: AddressRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    const name = normalize(row[2]);
    const address = normalize(row[4]);
    if (!name || !address) continue;
    entries.push({ name, address });
  }

  console.log(`Excel 中读取到 ${entries.length} 条住址记录`);

  // 批量匹配 users 表：先按 user_name 精确匹配，再按 visits.user_name 兜底
  const matched: { user_id: string; name: string; address: string }[] = [];
  const unmatched: { name: string; address: string }[] = [];

  for (const entry of entries) {
    const userResult = await pool.query(
      `SELECT user_id FROM users WHERE user_name = $1 LIMIT 1`,
      [entry.name]
    );
    if (userResult.rows.length > 0) {
      matched.push({ user_id: userResult.rows[0].user_id, name: entry.name, address: entry.address });
      continue;
    }

    const visitResult = await pool.query(
      `SELECT DISTINCT user_id FROM visits WHERE user_name = $1 LIMIT 1`,
      [entry.name]
    );
    if (visitResult.rows.length > 0) {
      matched.push({ user_id: visitResult.rows[0].user_id, name: entry.name, address: entry.address });
    } else {
      unmatched.push(entry);
    }
  }

  // 写入 home_address
  let updated = 0;
  for (const m of matched) {
    await pool.query(
      `UPDATE users SET home_address = $1 WHERE user_id = $2`,
      [m.address, m.user_id]
    );
    updated++;
  }

  console.log(`成功匹配并写入 ${updated} 条员工住址`);
  if (unmatched.length > 0) {
    console.log(`\n未匹配到系统用户的 ${unmatched.length} 条记录：`);
    for (const u of unmatched) {
      console.log(`  - ${u.name}: ${u.address}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
