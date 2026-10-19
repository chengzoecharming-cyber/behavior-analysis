import { pool } from "../src/db";
import { resetAnomalyWeights } from "../src/services/anomalyWeights";

async function main() {
  try {
    await resetAnomalyWeights();
    console.log("Anomaly weights reset successfully.");
  } catch (err) {
    console.error("Failed to reset anomaly weights:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
