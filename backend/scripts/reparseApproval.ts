/**
 * 重录指定审批单：销售在钉钉修改表单后，重新拉取实例 → 更新 raw_approvals →
 * 重解析替换 visits → 重算派生数据（拜访排除标记、routes、stops、异常、风险摘要）。
 *
 * 背景：日常同步是「存在即跳过」（v2 重复行只刷新 visit_note/visit_detail），
 * 客户名等字段不会随钉钉表单修改自动更新，必须用本脚本定向重录。
 * 按 process_instance_id 直接拉单，不受同步「最近 3 天」窗口限制。
 *
 * 用法：
 *   npx ts-node scripts/reparseApproval.ts <approval_id> [approval_id...] [--dry]
 * 示例：
 *   npx ts-node scripts/reparseApproval.ts 202608071057000303031 --dry   # 只预览新旧差异
 *   npx ts-node scripts/reparseApproval.ts 202608071057000303031         # 实际重录
 *
 * 注意：raw_approvals.form_json 会被覆盖为修改后的表单（原始填报面貌不再保留）；
 * raw_visits 保留追加历史，不删除。
 */
import { pool } from "../src/db";
import {
  getApprovalDetail,
  saveRawApproval,
  parseApprovalInstance,
  isDingTalkConfigured,
} from "../src/services/dingtalk";
import { processParsedVisits } from "../src/services/normalization";
import {
  recomputeDerivedDataForVisits,
  AffectedUserDate,
} from "../src/services/derivedComputation";
import { formatBeijingDate } from "../src/utils/timezone";

interface OldVisitRow {
  id: number;
  user_id: string;
  user_name: string;
  sequence: number;
  timestamp: Date;
  location_name: string | null;
  customer_name: string | null;
  customer_count: number;
  exclude_from_visit_count: boolean;
  start_odometer: number | null;
  end_odometer: number | null;
  reported_distance_km: number | null;
}

function toDateStr(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 10) : formatBeijingDate(value);
}

async function reparseOne(approvalId: string, dryRun: boolean): Promise<boolean> {
  console.log(`\n===== ${approvalId} =====`);

  // 1. 从 raw_approvals 拿 process_instance_id 与 process_code（v1/v2 解析分发依据）
  const rawResult = await pool.query(
    `SELECT process_instance_id, process_code FROM raw_approvals WHERE approval_id = $1`,
    [approvalId]
  );
  if (rawResult.rows.length === 0) {
    console.error(`  ✗ raw_approvals 中找不到该审批单，跳过`);
    return false;
  }
  const { process_instance_id: processInstanceId, process_code: processCode } =
    rawResult.rows[0];

  // 2. 从钉钉重新拉取实例（含销售修改后的表单值）
  const instance = await getApprovalDetail(processInstanceId);
  console.log(
    `  钉钉实例: title=${instance.title} status=${instance.status} result=${instance.result}`
  );

  // 3. 库中现有 visits 快照
  const oldResult = await pool.query(
    `SELECT id, user_id, user_name, sequence, timestamp, location_name, customer_name,
            customer_count, exclude_from_visit_count,
            start_odometer, end_odometer, reported_distance_km
     FROM visits WHERE approval_id = $1 ORDER BY sequence`,
    [approvalId]
  );
  const oldVisits: OldVisitRow[] = oldResult.rows;

  // 4. 重新解析
  const parsed = await parseApprovalInstance(instance, processCode);
  if (parsed.length === 0) {
    console.error(`  ✗ 重新解析结果为空，保留现有数据，跳过`);
    return false;
  }

  // 5. 新旧对照（按 sequence 对齐）
  console.log(`  打卡点：旧 ${oldVisits.length} 条 → 新 ${parsed.length} 条`);
  const maxLen = Math.max(oldVisits.length, parsed.length);
  let hasDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const oldV = oldVisits[i];
    const newV = parsed.find((p) => (p.sequence ?? i + 1) === i + 1) ?? parsed[i];
    const oldDesc = oldV
      ? `客户「${oldV.customer_name ?? ""}」${oldV.exclude_from_visit_count ? "(不计拜访)" : ""} @ ${oldV.location_name ?? ""}`
      : "(无)";
    const newDesc = newV
      ? `客户「${newV.customer_name ?? ""}」 @ ${newV.location_name ?? ""}`
      : "(无)";
    const same =
      oldV &&
      newV &&
      (oldV.customer_name ?? "") === (newV.customer_name ?? "") &&
      (oldV.location_name ?? "") === (newV.location_name ?? "");
    if (!same) hasDiff = true;
    console.log(`  ${same ? " " : "*"} #${i + 1} 旧: ${oldDesc}`);
    if (!same) console.log(`      新: ${newDesc}`);
  }
  if (!hasDiff) {
    console.log(`  新旧一致，无需重录（销售可能尚未修改）`);
    return true;
  }

  if (dryRun) {
    console.log(`  [dry-run] 仅预览，未写库`);
    return true;
  }

  // 6. 更新 raw_approvals（form_json 覆盖为修改后的表单）
  await saveRawApproval(instance, processInstanceId, processCode);

  // 7. 删除旧 visits 并重新入库（processParsedVisits 自带拜访排除打标、
  //    customer_count、business_date 归日、质量断言等完整链路）
  const oldPairs: AffectedUserDate[] = Array.from(
    new Map(
      oldVisits.map((v) => [
        `${v.user_id}|${toDateStr((v as any).business_date ?? v.timestamp)}`,
        {
          user_id: v.user_id,
          business_date: toDateStr((v as any).business_date ?? v.timestamp),
        },
      ])
    ).values()
  );
  const delResult = await pool.query(
    `DELETE FROM visits WHERE approval_id = $1`,
    [approvalId]
  );
  console.log(`  已删除旧 visits ${delResult.rowCount} 条`);

  const result = await processParsedVisits(parsed, "dingtalk");
  console.log(
    `  重新入库 ${result.normalizedInserted} 条（跳过 ${result.skipped} 条）`
  );

  // 8. 重算派生数据（旧日期也要算，防止归日变化后旧日期残留）
  const pairMap = new Map<string, AffectedUserDate>();
  for (const p of [...oldPairs, ...result.affectedUserDates]) {
    pairMap.set(`${p.user_id}|${p.business_date}`, p);
  }
  console.log(
    `  重算派生数据: ${Array.from(pairMap.keys()).join(", ")}`
  );
  await recomputeDerivedDataForVisits(Array.from(pairMap.values()));
  console.log(`  ✓ 完成`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const approvalIds = args.filter((a) => a !== "--dry");

  if (approvalIds.length === 0) {
    console.log(
      "用法: npx ts-node scripts/reparseApproval.ts <approval_id> [approval_id...] [--dry]"
    );
    process.exit(1);
  }
  if (!isDingTalkConfigured()) {
    console.error("未配置钉钉（DINGTALK_APP_KEY/SECRET），无法拉取审批实例");
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const id of approvalIds) {
    try {
      const success = await reparseOne(id, dryRun);
      success ? ok++ : fail++;
    } catch (err) {
      console.error(`  ✗ ${id} 重录失败:`, err);
      fail++;
    }
  }
  console.log(`\n汇总: 成功 ${ok}，失败 ${fail}`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
