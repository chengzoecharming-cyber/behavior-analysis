import * as XLSX from "xlsx";
import { pool, initDB } from "../src/db";
import { geocodeAddressWithSimplification } from "../src/services/geocoding";

interface AddressRow {
  name: string;
  address: string;
}

function normalize(value: string | undefined | null): string {
  return (value || "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await initDB();

  // 默认读取镜像内路径，也支持命令行参数传入任意路径
  const filePath = process.argv[2] || "./data/employee_addresses.xlsx";
  console.log(`读取住址文件: ${filePath}`);

  const workbook = XLSX.readFile(filePath);
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

  // 写入 home_address，并同步地理编码持久化坐标（报告/异常检测运行时不再实时解析）
  let updated = 0;
  let geocoded = 0;
  const geocodeFailed: { name: string; address: string }[] = [];
  for (const m of matched) {
    // 高德 QPS 有限，串行 + 节流，避免限流导致坐标缺失
    const result = await geocodeAddressWithSimplification(m.address);
    await sleep(200);
    if (result) {
      await pool.query(
        `UPDATE users SET home_address = $1, home_lat = $2, home_lng = $3 WHERE user_id = $4`,
        [m.address, result.coords.lat, result.coords.lng, m.user_id]
      );
      geocoded++;
      if (result.usedAddress !== m.address) {
        console.log(`  [简化命中] ${m.name}: 「${m.address}」→ 用「${result.usedAddress}」解析`);
      }
    } else {
      // 解析不出也要写 home_address（文本匹配仍可用），坐标留空
      await pool.query(
        `UPDATE users SET home_address = $1, home_lat = NULL, home_lng = NULL WHERE user_id = $2`,
        [m.address, m.user_id]
      );
      geocodeFailed.push({ name: m.name, address: m.address });
    }
    updated++;
  }

  console.log(`成功匹配并写入 ${updated} 条员工住址（其中 ${geocoded} 条已解析坐标）`);
  if (geocodeFailed.length > 0) {
    console.log(`\n⚠️ 以下 ${geocodeFailed.length} 条住址地理编码失败，坐标半径兜底不可用：`);
    for (const f of geocodeFailed) {
      console.log(`  - ${f.name}: ${f.address}`);
    }
    console.log(`  请人工核实坐标后写入 address_fallback_coordinates 表（address 列填上面的原始住址）。`);
  }
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
