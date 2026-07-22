import * as XLSX from "xlsx";
import { pool, initDB } from "../src/db";
import { RawVisitRow } from "../src/types";
import { parseDateTimeAsBeijing, formatBeijingDate } from "../src/utils/timezone";

function normalizeUserId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

async function main() {
  await initDB();

  const workbook = XLSX.readFile("../data/mock-visits.xlsx");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<RawVisitRow>(sheet);

  for (const row of rows) {
    const userId = normalizeUserId(row.user_name);
    const timestamp = parseDateTimeAsBeijing(row.time as string);
    const businessDate = formatBeijingDate(timestamp);

    // RAW 层
    const rawResult = await pool.query(
      `INSERT INTO raw_visits
       (raw_user_name, raw_time, raw_location, raw_address, raw_lat, raw_lng, raw_customer_name, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        row.user_name,
        String(row.time),
        row.location_name,
        row.address,
        String(row.lat),
        String(row.lng),
        row.customer_name,
        "seed",
        businessDate,
      ]
    );
    const rawVisitId = rawResult.rows[0].id;

    // NORMALIZED 层
    await pool.query(
      `INSERT INTO visits
       (raw_visit_id, user_id, user_name, department, timestamp, lat, lng, location_name, address, customer_name, source, business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        rawVisitId,
        userId,
        row.user_name,
        "销售部",
        timestamp,
        row.lat,
        row.lng,
        row.location_name,
        row.address,
        row.customer_name,
        "seed",
        businessDate,
      ]
    );
  }

  console.log(`Seeded ${rows.length} raw + normalized visits`);
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
