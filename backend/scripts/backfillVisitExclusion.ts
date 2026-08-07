/**
 * 回填 visits.exclude_from_visit_count（拜访次数统计排除标记）。
 *
 * 打标口径按表单版本分流：
 * - v1 旧表单 / Excel：命中「员工本人住址」或「公司地址白名单」的签到置为 true；
 * - v2 新表单（按 raw_approvals.process_code 识别）：客户名为空或含「虚拟」字眼
 *   （情况B）置为 true，不看地址（PLAN.md Step 3.6）。
 *
 * 全量重算、幂等：住址或公司地址白名单有更新时，直接重跑本脚本即可刷新。
 * 同时按新口径修正 risk_summary_cache.visit_count（不重算风险分）。
 *
 * 用法：
 *   npx ts-node scripts/backfillVisitExclusion.ts        # 实际执行
 *   npx ts-node scripts/backfillVisitExclusion.ts --dry  # 只预览统计，不写库
 */
import { pool } from "../src/db";
import {
  loadAllHomeAddresses,
  loadCompanyAddresses,
  isHomeAddress,
  isCompanyAddress,
} from "../src/services/addressWhitelistService";
import { splitRealCustomerNames } from "../src/services/normalization";

const DRY_RUN = process.argv.includes("--dry");
const PROCESS_CODE_V2 = process.env.DINGTALK_PROCESS_CODE_V2 || "";

interface VisitRow {
  id: number;
  user_id: string;
  user_name: string;
  address: string | null;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  customer_name: string | null;
  approval_id: string | null;
}

async function main() {
  const homeAddressMap = await loadAllHomeAddresses();
  const companyAddresses = await loadCompanyAddresses();
  console.log(`员工住址 ${homeAddressMap.size} 条，公司地址白名单 ${companyAddresses.length} 条，dryRun=${DRY_RUN}`);

  // v2 审批单集合（按 process_code 识别）
  let v2ApprovalIds = new Set<string>();
  if (PROCESS_CODE_V2) {
    const r = await pool.query(
      `SELECT approval_id FROM raw_approvals WHERE process_code = $1`,
      [PROCESS_CODE_V2]
    );
    v2ApprovalIds = new Set(r.rows.map((row) => row.approval_id));
  }
  console.log(`v2 审批单 ${v2ApprovalIds.size} 张（process_code=${PROCESS_CODE_V2 || "未配置"}）`);

  const visits = await pool.query<VisitRow>(
    `SELECT id, user_id, user_name, address, location_name, lat, lng, customer_name, approval_id FROM visits ORDER BY id`
  );
  console.log(`共 ${visits.rows.length} 条签到待处理`);

  const excludedIds: number[] = [];
  const excludedByUser = new Map<string, number>();
  const samples: string[] = [];

  for (const v of visits.rows) {
    const isV2 = !!v.approval_id && v2ApprovalIds.has(v.approval_id);
    const excluded = isV2
      ? splitRealCustomerNames(v.customer_name).length === 0
      : (await (async () => {
          const home = homeAddressMap.get(v.user_id);
          return (
            (home ? await isHomeAddress(v, home) : false) ||
            isCompanyAddress(v, companyAddresses)
          );
        })());
    if (excluded) {
      excludedIds.push(v.id);
      excludedByUser.set(v.user_name, (excludedByUser.get(v.user_name) ?? 0) + 1);
      if (samples.length < 15) {
        samples.push(`  [${v.user_name}]${isV2 ? "(v2)" : ""} ${v.location_name || ""} / ${v.address || ""} / 客户=${v.customer_name || ""}`);
      }
    }
  }

  console.log(`\n应排除 ${excludedIds.length} 条（占 ${((excludedIds.length / Math.max(visits.rows.length, 1)) * 100).toFixed(1)}%），样例：`);
  for (const s of samples) console.log(s);
  console.log("\n按员工分布（Top 20）：");
  const sorted = [...excludedByUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [name, count] of sorted) console.log(`  ${name}: ${count}`);

  if (DRY_RUN) {
    console.log("\n(dry-run，未写库)");
    return;
  }

  // 全量重打标：true 集合外的全部置 false，保证幂等可重复执行
  await pool.query(
    `UPDATE visits SET exclude_from_visit_count = (id = ANY($1::int[]))`,
    [excludedIds]
  );
  console.log(`\nvisits 打标完成`);

  // 同步修正风险摘要缓存的 visit_count（只改数字，不动风险分与异常）；
  // 一个打卡点多家客户按客户数计（customer_count，v1/Excel 恒为 1）
  const cacheResult = await pool.query(
    `UPDATE risk_summary_cache c
     SET visit_count = COALESCE(sub.cnt, 0)
     FROM (
       SELECT user_id, business_date, COALESCE(SUM(customer_count), 0) AS cnt
       FROM visits
       WHERE NOT exclude_from_visit_count
       GROUP BY user_id, business_date
     ) sub
     WHERE c.user_id = sub.user_id AND c.date = sub.business_date`
  );
  console.log(`risk_summary_cache.visit_count 更新 ${cacheResult.rowCount} 行`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
