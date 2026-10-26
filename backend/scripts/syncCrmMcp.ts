/**
 * CRM MCP 同步手动脚本。
 *
 * 用法：
 *   npm run sync:crm-mcp                 # 增量（按 crm_mcp_sync_state 水位线）
 *   npm run sync:crm-mcp -- --full       # 全量（含僵尸客户 is_deleted 打标）
 *   npm run sync:crm-mcp -- --dry        # 只拉远端计数 vs 本地对账，不写库
 *
 * 首次接入先跑 --dry 对账，再 --full 全量，之后交给每 2 小时的调度跑增量。
 */

import { pool, initDB } from "../src/db";
import { syncCrmFromMcp } from "../src/services/crmMcpSyncService";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const dryRun = args.includes("--dry");

  // --dry 模式也需要表结构存在（读本地 count），initDB 幂等
  await initDB();

  console.log(`[sync:crm-mcp] 开始 ${dryRun ? "对账（dry）" : full ? "全量同步" : "增量同步"} ...`);
  const result = await syncCrmFromMcp({ full, dryRun, triggerSource: "manual" });

  console.log("\n===== 结果 =====");
  console.log(`run_id=${result.runId} status=${result.status} 耗时=${(result.durationMs / 1000).toFixed(1)}s`);
  for (const [type, s] of Object.entries(result.customers)) {
    console.log(
      `客户 ${type}: fetched=${s.fetched} inserted=${s.inserted} updated=${s.updated} failed=${s.failed}` +
        (s.marked_deleted != null ? ` marked_deleted=${s.marked_deleted}` : "") +
        (s.remote_total != null ? ` remote=${s.remote_total} local=${s.local_count} drift=${s.drift}` : "")
    );
  }
  const c = result.contacts;
  console.log(
    `联系人: fetched=${c.fetched} inserted=${c.inserted} updated=${c.updated} failed=${c.failed}` +
      (c.remote_total != null ? ` remote=${c.remote_total} local=${c.local_count} drift=${c.drift}` : "")
  );
  const f = result.follows;
  console.log(
    `跟进: fetched=${f.fetched} inserted=${f.inserted} updated=${f.updated} failed=${f.failed}` +
      ` 刷新客户=${f.customers_refreshed} 回补=${f.backstop_customers}` +
      (f.remote_total != null ? ` remote=${f.remote_total} local=${f.local_count} drift=${f.drift}` : "")
  );
  console.log(
    `图片: 下载=${result.images.downloaded} 失败=${result.images.failed} 超6个月跳过=${result.images.skipped_old}`
  );
  if (result.error) console.log(`错误: ${result.error}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[sync:crm-mcp] 失败:", err);
    pool.end().finally(() => process.exit(1));
  });
