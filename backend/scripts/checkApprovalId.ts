import { pool } from "../src/db";

async function main() {
  const result = await pool.query(
    `SELECT anomaly_date, type, metadata->>'approval_id' as approval_id, metadata
     FROM anomalies
     WHERE type = 'mileage_deviation'
     ORDER BY created_at DESC
     LIMIT 100`
  );
  console.log(JSON.stringify(result.rows, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
