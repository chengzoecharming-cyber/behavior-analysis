import { pool } from "../src/db";

async function main() {
  await pool.query(`
    UPDATE anomaly_weights
    SET enabled = false
    WHERE rule_key IN ('invalid_trip_type', 'long_idle', 'long_stop', 'route_detour')
  `);

  await pool.query(`
    UPDATE anomaly_weights
    SET threshold_value = 8
    WHERE rule_key = 'duplicate_location'
  `);

  await pool.query("TRUNCATE risk_summary_cache");

  const result = await pool.query(
    "SELECT rule_key, rule_name, threshold_value, enabled FROM anomaly_weights ORDER BY rule_key"
  );
  console.log("=== 更新后的规则状态 ===");
  console.table(result.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
