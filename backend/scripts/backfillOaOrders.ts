/**
 * OA 订单执行单历史回拉（断点续跑）。
 *
 * - 钉钉 listids 实测上限：只能回拉 365 天内的实例（超过报 400003 Invalid timestamp）；
 * - 按 30 天分窗写入 oa_order_sync_windows，done 窗口重跑自动跳过；
 * - 单窗口失败重试 3 次（指数退避），仍失败标 failed，可再次运行本脚本续跑；
 * - 结束输出对账报告（窗口 listed_count 累计 vs oa_orders 落库数）。
 *
 * 用法：
 *   npx ts-node scripts/backfillOaOrders.ts                # 回拉 365 天（全部已配置订单 code）
 *   npx ts-node scripts/backfillOaOrders.ts -- --days 90   # 只回拉 90 天
 *   npx ts-node scripts/backfillOaOrders.ts -- --code PROC-XXX  # 只跑指定 code
 */
import { pool } from "../src/db";
import { getOrderProcessCodes } from "../src/services/dingtalk";
import { syncOrders } from "../src/services/orderSyncService";

const WINDOW_DAYS = 30;
const MAX_DAYS = 365; // 钉钉 listids 实测硬限制
const MAX_WINDOW_RETRIES = 3;

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const days = Math.min(parseInt(argValue("--days") || "365", 10), MAX_DAYS);
  const onlyCode = argValue("--code");
  const codes = getOrderProcessCodes().filter((c) => !onlyCode || c === onlyCode);
  if (codes.length === 0) {
    console.error("未配置订单 process_code（DINGTALK_PROCESS_CODE_ORDER / _ORDER_AGENT）");
    process.exit(1);
  }

  const runId = `backfill-${Date.now()}`;
  const endMs = Date.now();

  for (const code of codes) {
    console.log(`\n===== 回拉 code=${code} days=${days}`);
    // 生成窗口（从最近往回推）
    const windows: Array<{ start: Date; end: Date }> = [];
    for (let back = 0; back < days; back += WINDOW_DAYS) {
      const wEnd = new Date(endMs - back * 86400000);
      const wStart = new Date(endMs - Math.min(back + WINDOW_DAYS, days) * 86400000);
      windows.push({ start: wStart, end: wEnd });
    }

    for (const w of windows) {
      // 断点续跑：done 跳过
      const existing = await pool.query(
        `SELECT status FROM oa_order_sync_windows WHERE process_code = $1 AND window_start = $2 AND window_end = $3`,
        [code, w.start, w.end]
      );
      if (existing.rows[0]?.status === "done") {
        console.log(`跳过 done 窗口 ${w.start.toISOString().slice(0, 10)}..${w.end.toISOString().slice(0, 10)}`);
        continue;
      }

      await pool.query(
        `INSERT INTO oa_order_sync_windows (process_code, window_start, window_end, status, run_id)
         VALUES ($1, $2, $3, 'running', $4)
         ON CONFLICT (process_code, window_start, window_end) DO UPDATE SET status = 'running', run_id = $4, updated_at = now()`,
        [code, w.start, w.end, runId]
      );

      let lastErr: any = null;
      let done = false;
      for (let attempt = 1; attempt <= MAX_WINDOW_RETRIES && !done; attempt++) {
        try {
          const r = await syncOrders(code, w.start.getTime(), w.end.getTime(), runId);
          await pool.query(
            `UPDATE oa_order_sync_windows
             SET status = $4, listed_count = $5, detail_ok = $6, detail_fail = $7, error = $8, updated_at = now()
             WHERE process_code = $1 AND window_start = $2 AND window_end = $3`,
            [
              code, w.start, w.end,
              r.detailFail > 0 ? "failed" : "done",
              r.listedCount, r.detailOk, r.detailFail,
              r.detailFail > 0 ? `${r.detailFail} 单解析失败` : null,
            ]
          );
          console.log(
            `窗口 ${w.start.toISOString().slice(0, 10)}..${w.end.toISOString().slice(0, 10)}: ` +
            `listed=${r.listedCount} ok=${r.detailOk} fail=${r.detailFail} changed=${r.changed} locked=${r.skippedLocked}` +
            (r.detailFail > 0 ? " [标 failed，可续跑]" : "")
          );
          done = true;
        } catch (err: any) {
          lastErr = err;
          console.error(`窗口尝试 ${attempt}/${MAX_WINDOW_RETRIES} 失败:`, err?.message || err);
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
      if (!done) {
        await pool.query(
          `UPDATE oa_order_sync_windows SET status = 'failed', error = $4, updated_at = now()
           WHERE process_code = $1 AND window_start = $2 AND window_end = $3`,
          [code, w.start, w.end, lastErr?.message || String(lastErr)]
        );
        console.error(`窗口 ${w.start.toISOString().slice(0, 10)}.. 多次失败，标 failed 后继续下一窗口`);
      }
    }
  }

  // 对账报告
  console.log("\n===== 对账报告");
  for (const code of codes) {
    const win = await pool.query(
      `SELECT COALESCE(SUM(listed_count), 0) AS listed, COALESCE(SUM(detail_ok), 0) AS ok, COALESCE(SUM(detail_fail), 0) AS fail,
              COUNT(*) FILTER (WHERE status = 'done') AS done_windows, COUNT(*) FILTER (WHERE status = 'failed') AS failed_windows
       FROM oa_order_sync_windows WHERE process_code = $1`,
      [code]
    );
    const db = await pool.query(`SELECT COUNT(*) AS cnt FROM oa_orders WHERE process_code = $1`, [code]);
    console.log(
      `code=${code}: 窗口 listed 累计=${win.rows[0].listed}, detail_ok=${win.rows[0].ok}, detail_fail=${win.rows[0].fail}, ` +
      `done 窗口=${win.rows[0].done_windows}, failed 窗口=${win.rows[0].failed_windows}, 库内订单=${db.rows[0].cnt}`
    );
    const match = await pool.query(
      `SELECT customer_match_status, COUNT(*) FROM oa_orders WHERE process_code = $1 GROUP BY customer_match_status ORDER BY 2 DESC`,
      [code]
    );
    for (const row of match.rows) {
      console.log(`  ${row.customer_match_status}: ${row.count}`);
    }
  }
  console.log("\n注意：钉钉 listids 仅支持 365 天窗口，更早订单为数据缺口（history_since 动态计算）。");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
