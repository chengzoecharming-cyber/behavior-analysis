#!/usr/bin/env ts-node
/**
 * 更新已有 visits 的展示字段（location_name / visit_note / special_sign_reason / photos）。
 *
 * 用途：代码修改了钉钉字段解析逻辑后，用这个脚本从 raw_approvals.form_json
 * 重新解析展示字段并更新到 visits，无需重新同步钉钉数据，也不会调用高德 API。
 *
 * 用法：
 *   cd backend && npx ts-node scripts/updateVisitDisplayFields.ts [--dry-run]
 */
import dotenv from "dotenv";
import { pool } from "../src/db";
import { parseApprovalInstance } from "../src/services/dingtalk";

dotenv.config();

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

async function main() {
  console.log(
    `[updateVisitDisplayFields] start. dryRun=${DRY_RUN}, env=${process.env.NODE_ENV || "default"}`
  );

  const rawRes = await pool.query(
    `SELECT approval_id, originator_userid, originator_user_name, originator_dept_name,
            form_json, business_id, process_instance_id, title
     FROM raw_approvals
     WHERE source = 'dingtalk'
     ORDER BY approval_id`
  );

  console.log(`[updateVisitDisplayFields] found ${rawRes.rows.length} raw approvals`);

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rawRes.rows) {
    const approvalId = row.approval_id as string;

    // 构造 instance，给 originator_user_name 一个占位符，避免 parseApprovalInstance 调用通讯录 API
    const instance = {
      originator_userid: row.originator_userid,
      originator_user_name: row.originator_user_name || "-",
      originator_dept_name: row.originator_dept_name,
      form_component_values: row.form_json,
      business_id: row.business_id,
      process_instance_id: row.process_instance_id,
      title: row.title,
    };

    try {
      const parsedVisits = await parseApprovalInstance(instance);
      if (parsedVisits.length === 0) {
        skipped++;
        continue;
      }

      for (const v of parsedVisits) {
        if (!v.approval_id || v.sequence === undefined || !v.user_id) {
          continue;
        }

        if (DRY_RUN) {
          console.log(
            `[dry-run] ${v.approval_id} seq=${v.sequence} user=${v.user_id}: ` +
              `location_name=${v.location_name || "(empty)"}, visit_note=${v.visit_note || "(empty)"}, ` +
              `special_sign_reason=${v.special_sign_reason || "(empty)"}, photos=${v.photos?.length || 0}`
          );
          continue;
        }

        const updateRes = await pool.query(
          `UPDATE visits
           SET location_name = $1,
               visit_note = $2,
               special_sign_reason = $3,
               photos = $4
           WHERE approval_id = $5 AND sequence = $6 AND user_id = $7`,
          [
            v.location_name || "",
            v.visit_note || null,
            v.special_sign_reason || null,
            v.photos && v.photos.length > 0 ? JSON.stringify(v.photos) : "[]",
            v.approval_id,
            v.sequence,
            v.user_id,
          ]
        );
        updated += updateRes.rowCount || 0;
      }
    } catch (err: any) {
      failed++;
      console.error(`[updateVisitDisplayFields] failed for ${approvalId}:`, err.message);
    }
  }

  console.log(
    `[updateVisitDisplayFields] done. updated=${updated}, failed=${failed}, skipped=${skipped}`
  );
  await pool.end();
}

main().catch((err) => {
  console.error("[updateVisitDisplayFields] fatal error:", err);
  process.exit(1);
});
