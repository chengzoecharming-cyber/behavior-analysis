/**
 * 基于 raw_approvals 重新解析里程读数字段，只更新 visits.visit_note。
 *
 * 说明：
 * - 不修改 routes、stops、anomalies 等派生表。
 * - 只处理多段行程类审批单（标题含 用车里程 / 客户签到 / 里程登记 / 外出签到）。
 * - 保留 visits.visit_note 中原有的拜访情况文本，仅替换末尾的里程读数提示。
 *
 * 用法：
 *   npx ts-node scripts/reparseVisitNoteFromRawApprovals.ts        # 正式执行
 *   npx ts-node scripts/reparseVisitNoteFromRawApprovals.ts dry    # 只预览不更新
 */

import { pool } from "../src/db";
import { MAX_MILEAGE_KM } from "../src/services/mileageConfig";

interface FormComponent {
  id?: string;
  name: string;
  value: string;
  ext_value?: string;
  component_type?: string;
}

function isMultiStopRouteForm(title: string | null): boolean {
  return /用车里程|客户签到|里程登记|外出签到/.test(title || "");
}

function findValue(components: FormComponent[], pattern: RegExp): string | undefined {
  for (const c of components) {
    const name = (c.name || "").trim();
    const value = (c.value || "").trim();
    if (pattern.test(name) && value && value !== "null") {
      return value;
    }
  }
  return undefined;
}

function findNearby(
  components: FormComponent[],
  stopIndex: number,
  pattern: RegExp
): string | undefined {
  for (let i = stopIndex + 1; i < Math.min(stopIndex + 9, components.length); i++) {
    const c = components[i];
    if (c.component_type === "TimeAndLocationField") break;
    const name = (c.name || "").trim();
    const value = (c.value || "").trim();
    if (pattern.test(name) && value && value !== "null") {
      return value;
    }
  }
  return undefined;
}

/**
 * 去掉旧的里程读数提示（格式为 " [xxx]"）。
 * 只删除包含特定关键词的方括号后缀，避免误伤用户正文。
 */
function stripMileageNote(note: string | null): string {
  if (!note) return "";
  return note
    .replace(/\s*\[(?:里程读数|缺少出发里程|终点里程|无法计算|差值|异常)[^\]]*\]/g, "")
    .trim();
}

async function reparseVisitNotes(dryRun = false): Promise<void> {
  const approvals = await pool.query<{
    approval_id: string;
    title: string;
    form_json: FormComponent[];
  }>(
    `SELECT approval_id, title, form_json
     FROM raw_approvals
     WHERE source = 'dingtalk'
     ORDER BY approval_id`
  );

  let updated = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const row of approvals.rows) {
    const components = Array.isArray(row.form_json) ? row.form_json : [];
    if (!isMultiStopRouteForm(row.title)) {
      skipped++;
      continue;
    }

    const tripType = findValue(components, /请选择出行方式/);
    const isPublicTransport = /公共交通/.test(tripType || "");
    const startOdometerRaw = isPublicTransport
      ? undefined
      : findValue(components, /出发里程读数/);
    const startOdometer = startOdometerRaw ? parseFloat(startOdometerRaw) : NaN;

    // 收集所有非空的 TimeAndLocationField 下标
    const stopIndices: number[] = [];
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      if (c.component_type !== "TimeAndLocationField") continue;
      const value = (c.value || "").trim();
      if (!value || value === "null") continue;
      stopIndices.push(i);
    }

    if (stopIndices.length === 0) {
      skipped++;
      continue;
    }

    for (let i = 0; i < stopIndices.length; i++) {
      const sequence = i + 1;
      let mileageNote = "";

      if (!isPublicTransport) {
        if (i === 0) {
          if (isNaN(startOdometer)) {
            mileageNote = " [缺少出发里程读数]";
          }
        } else {
          const odoRaw = findNearby(components, stopIndices[i], /^终点里程读数/);
          const endOdometer = odoRaw && odoRaw !== "null" ? parseFloat(odoRaw) : null;

          if (endOdometer == null || isNaN(endOdometer)) {
            mileageNote = ` [第${sequence}个签到点缺少终点里程读数]`;
          } else if (!isNaN(startOdometer)) {
            const diff = endOdometer - startOdometer;
            if (diff < 0) {
              mileageNote = ` [里程读数异常：终点${endOdometer} < 出发${startOdometer}]`;
            } else if (diff > MAX_MILEAGE_KM) {
              mileageNote = ` [里程读数异常：差值${diff}km 超上限]`;
            }
            // diff 在合理范围内时不追加提示
          } else {
            mileageNote = " [缺少出发里程读数，无法计算终点里程]";
          }
        }
      }

      const visitRes = await pool.query<{ visit_note: string | null }>(
        `SELECT visit_note FROM visits WHERE approval_id = $1 AND sequence = $2`,
        [row.approval_id, sequence]
      );

      if (visitRes.rows.length === 0) {
        continue;
      }

      const oldNote = visitRes.rows[0].visit_note || "";
      const baseNote = stripMileageNote(oldNote);
      const newNote = (baseNote + mileageNote).trim() || null;

      if (newNote === oldNote || (newNote == null && !oldNote)) {
        unchanged++;
        continue;
      }

      if (!dryRun) {
        await pool.query(
          `UPDATE visits SET visit_note = $1 WHERE approval_id = $2 AND sequence = $3`,
          [newNote, row.approval_id, sequence]
        );
      }
      updated++;

      if (updated <= 5 || dryRun) {
        console.log(`[${dryRun ? "dry" : "update"}] ${row.approval_id}#${sequence}: "${oldNote}" -> "${newNote}"`);
      }
    }
  }

  console.log(`\nDone. updated=${updated}, unchanged=${unchanged}, skipped=${skipped}`);
}

async function main() {
  const dryRun = process.argv.includes("dry") || process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("[dry-run] 不会实际更新数据库\n");
  }

  try {
    await reparseVisitNotes(dryRun);
  } catch (err) {
    console.error("脚本执行失败:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
