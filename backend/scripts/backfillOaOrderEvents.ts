/**
 * OA 订单操作证据（operationRecords）历史回填。
 *
 * 对库内全部订单按 process_instance_id 调用新版工作流 API 拉取 operationRecords，
 * 幂等落 oa_order_events 并派生里程碑。失败重试 3 次，中断可重跑（已落事件幂等去重）。
 *
 * 用法：
 *   npx ts-node scripts/backfillOaOrderEvents.ts              # 全部订单
 *   npx ts-node scripts/backfillOaOrderEvents.ts -- --limit 50 --only-missing
 */
import { pool } from "../src/db";
import { syncOrderEvents } from "../src/services/orderMilestoneService";

const INTERVAL_MS = 150;
const MAX_RETRIES = 3;

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const limit = parseInt(argValue("--limit") || "0", 10);
  const onlyMissing = process.argv.includes("--only-missing");

  let sql = `SELECT o.process_instance_id FROM oa_orders o`;
  if (onlyMissing) {
    sql += ` WHERE NOT EXISTS (SELECT 1 FROM oa_order_events e WHERE e.process_instance_id = o.process_instance_id)`;
  }
  sql += ` ORDER BY o.oa_create_time DESC NULLS LAST`;
  if (limit > 0) sql += ` LIMIT ${limit}`;

  const res = await pool.query(sql);
  console.log(`待回填订单 ${res.rows.length} 张`);

  let ok = 0, failed = 0, totalEvents = 0;
  const failedIds: string[] = [];
  for (let i = 0; i < res.rows.length; i++) {
    const pid = res.rows[i].process_instance_id;
    let lastErr: any = null;
    let done = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !done; attempt++) {
      try {
        const r = await syncOrderEvents(pid);
        totalEvents += r.total;
        done = true;
        ok++;
      } catch (err: any) {
        lastErr = err;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    if (!done) {
      failed++;
      failedIds.push(pid);
      console.error(`[${i + 1}/${res.rows.length}] ${pid} 失败: ${lastErr?.message || lastErr}`);
    }
    if ((i + 1) % 100 === 0) console.log(`进度 ${i + 1}/${res.rows.length}，ok=${ok} failed=${failed}`);
    await sleep(INTERVAL_MS);
  }

  console.log(`\n回填完成：订单 ok=${ok} failed=${failed}，事件总数=${totalEvents}`);
  if (failedIds.length > 0) {
    console.log(`失败单（重跑 --only-missing 可续）：${failedIds.length} 个`);
  }

  // 里程碑统计
  const ms = await pool.query(`
    SELECT key AS milestone, count(*) FILTER (WHERE value IS NOT NULL AND value <> 'null') AS hit
    FROM oa_orders, jsonb_each(COALESCE(milestones->'items', '{}'::jsonb))
    GROUP BY 1 ORDER BY 1
  `);
  console.log("\n里程碑识别统计:");
  for (const r of ms.rows) console.log(`  ${r.milestone}: ${r.hit}`);
  const invalid = await pool.query(
    `SELECT count(*) FROM oa_orders WHERE milestones->'final_status'->>'valid' = 'false'`
  );
  console.log(`最终状态无效（撤销/拒绝）的订单: ${invalid.rows[0].count}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
