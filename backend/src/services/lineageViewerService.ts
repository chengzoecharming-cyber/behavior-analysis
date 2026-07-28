import { pool } from "../db";
import { parseApprovalInstance } from "./dingtalk";
import { ParsedVisit } from "../types";

/**
 * 数据血缘查看器（只读）。
 *
 * 目标：把「钉钉原始表单 → 解析结果 → 标准化入库」三步摊开给用户看，
 * 解决“同步过来的数据长什么样、哪一步出错了”的黑箱问题。
 *
 * 全部为只读查询 + 复用现有 parseApprovalInstance 重新解析（不落库），
 * 不改变任何数据。
 */

// ============ 类型定义 ============

/** 审批单列表项 */
export interface ApprovalListItem {
  approvalId: string;
  processInstanceId?: string;
  userName?: string;
  department?: string;
  createTime?: string;
  finishTime?: string;
  status?: string;
  result?: string;
  /** 解析出的签到点数（visits 条数） */
  visitCount: number;
  /** 该单关联的质量问题数（error 优先展示） */
  qualityErrorCount: number;
  qualityWarningCount: number;
}

/** 第①步：原始表单的一个控件（已翻译成中文标签） */
export interface RawFormField {
  name: string; // 中文标签
  componentType: string;
  /** 已格式化的可读值（照片显示张数，定位显示 时间|坐标|地址） */
  displayValue: string;
  /** 是否为签到定位控件 */
  isLocation: boolean;
  /** 值是否为空 */
  empty: boolean;
}

/** 三步血缘详情 */
export interface ApprovalLineageDetail {
  approvalId: string;
  /** 审批单概要 */
  meta: {
    userName?: string;
    department?: string;
    createTime?: string;
    finishTime?: string;
    status?: string;
    result?: string;
  };
  /** 第①步：原始表单字段 */
  rawForm: RawFormField[];
  /** 第②步：重新解析出的 visits（当前解析逻辑） */
  parsedVisits: ParsedVisit[];
  /** 解析是否正常（是否有可用签到点） */
  parseOk: boolean;
  parseError?: string;
  /** 第③步：已入库的 visits */
  storedVisits: any[];
  /** 该单关联的质量问题记录 */
  qualityRecords: any[];
}

// ============ 控件值格式化 ============

/** 把控件原始 value 格式化为可读字符串 */
function formatComponentValue(componentType: string, value: string): { display: string; isLocation: boolean } {
  const v = (value ?? "").trim();
  if (!v || v === "null") return { display: "（空）", isLocation: componentType === "TimeAndLocationField" };

  // 签到定位：["时间", 经度, 纬度, "地址", 精度]
  if (componentType === "TimeAndLocationField") {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) {
        const [time, lng, lat, address] = arr;
        return {
          display: `${time ?? ""} | ${lat ?? ""},${lng ?? ""} | ${address ?? ""}`,
          isLocation: true,
        };
      }
    } catch {
      // fallthrough
    }
    return { display: v, isLocation: true };
  }

  // 照片：JSON 数组，显示张数
  if (componentType === "DDPhotoField") {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return { display: `${arr.length} 张照片`, isLocation: false };
    } catch {
      // fallthrough
    }
    return { display: v, isLocation: false };
  }

  // 表格 / 客户名称等复杂结构：尝试提取可读文本
  if (componentType === "TableField" || componentType === "OpenDataField") {
    const text = extractReadableText(v);
    return { display: text || v, isLocation: false };
  }

  return { display: v, isLocation: false };
}

/** 从复杂 JSON 值里提取可读文本（客户名称等） */
function extractReadableText(value: string): string {
  try {
    const parsed = JSON.parse(value);
    const found: string[] = [];
    const walk = (node: any) => {
      if (node == null) return;
      if (typeof node === "string") {
        const t = node.trim();
        if (t && t !== "null") found.push(t);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node === "object") {
        if (typeof node.label === "string") walk(node.label);
        else if (typeof node.value === "string") walk(node.value);
        else Object.values(node).forEach(walk);
      }
    };
    walk(parsed);
    // 去重并拼接
    return Array.from(new Set(found)).join("、");
  } catch {
    return value;
  }
}

// ============ 查询：审批单列表 ============

export async function listApprovals(options: {
  startDate?: string;
  endDate?: string;
  userName?: string;
  limit?: number;
  offset?: number;
  /** 权限收口：非 null 时只返回可见成员有签到入库的审批单 */
  visibleUserIds?: string[] | null;
}): Promise<{ total: number; items: ApprovalListItem[] }> {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`ra.create_time >= ($${params.length})::date`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`ra.create_time < (($${params.length})::date + interval '1 day')`);
  }
  if (options.userName) {
    params.push(`%${options.userName}%`);
    conditions.push(`ra.originator_user_name ILIKE $${params.length}`);
  }
  if (options.visibleUserIds) {
    params.push(options.visibleUserIds);
    conditions.push(
      `EXISTS (SELECT 1 FROM visits v WHERE v.approval_id = ra.approval_id AND v.user_id = ANY($${params.length}))`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM raw_approvals ra ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].cnt, 10);

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const result = await pool.query(
    `SELECT
       ra.approval_id,
       ra.process_instance_id,
       ra.originator_user_name,
       ra.originator_dept_name,
       ra.create_time,
       ra.finish_time,
       ra.status,
       ra.result,
       COALESCE(v.visit_count, 0) AS visit_count,
       COALESCE(q.error_count, 0) AS quality_error_count,
       COALESCE(q.warning_count, 0) AS quality_warning_count
     FROM raw_approvals ra
     LEFT JOIN (
       SELECT approval_id, COUNT(*) AS visit_count
       FROM visits
       WHERE approval_id IS NOT NULL
       GROUP BY approval_id
     ) v ON v.approval_id = ra.approval_id
     LEFT JOIN (
       SELECT
         source_id,
         COUNT(*) FILTER (WHERE severity = 'error') AS error_count,
         COUNT(*) FILTER (WHERE severity = 'warning') AS warning_count
       FROM data_quality_records
       WHERE source = 'dingtalk' AND source_id IS NOT NULL
       GROUP BY source_id
     ) q ON q.source_id = ra.approval_id
     ${where}
     ORDER BY ra.create_time DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const items: ApprovalListItem[] = result.rows.map((r) => ({
    approvalId: r.approval_id,
    processInstanceId: r.process_instance_id ?? undefined,
    userName: r.originator_user_name ?? undefined,
    department: r.originator_dept_name ?? undefined,
    createTime: r.create_time ?? undefined,
    finishTime: r.finish_time ?? undefined,
    status: r.status ?? undefined,
    result: r.result ?? undefined,
    visitCount: parseInt(r.visit_count, 10),
    qualityErrorCount: parseInt(r.quality_error_count, 10),
    qualityWarningCount: parseInt(r.quality_warning_count, 10),
  }));

  return { total, items };
}

// ============ 查询：单条三步血缘详情 ============

export async function getApprovalLineage(approvalId: string): Promise<ApprovalLineageDetail | null> {
  const approvalResult = await pool.query(
    `SELECT approval_id, process_instance_id, title, originator_userid, originator_user_name,
            originator_dept_name, create_time, finish_time, form_json, result, status
     FROM raw_approvals
     WHERE approval_id = $1
     LIMIT 1`,
    [approvalId]
  );

  if (approvalResult.rows.length === 0) return null;
  const ra = approvalResult.rows[0];

  // 第①步：原始表单翻译成中文标签 + 可读值
  const formComponents: any[] = Array.isArray(ra.form_json) ? ra.form_json : [];
  const rawForm: RawFormField[] = formComponents.map((c) => {
    const { display, isLocation } = formatComponentValue(c.component_type ?? c.componentType ?? "", c.value ?? "");
    const value = (c.value ?? "").trim();
    return {
      name: c.name ?? c.label ?? c.id ?? "（未命名）",
      componentType: c.component_type ?? c.componentType ?? "",
      displayValue: display,
      isLocation,
      empty: !value || value === "null",
    };
  });

  // 第②步：用当前解析逻辑重新解析（不落库）。parseApprovalInstance 可能因网络（用户名 fallback）失败，做容错。
  let parsedVisits: ParsedVisit[] = [];
  let parseOk = false;
  let parseError: string | undefined;
  try {
    const instance = {
      form_component_values: formComponents,
      // title 必须传：isMultiStopRouteForm 靠它识别多段行程表单，
      // 否则会走单表单 fallback，只产出 1 条退化记录
      title: ra.title,
      originator_userid: ra.originator_userid,
      originator_user_name: ra.originator_user_name,
      originator_dept_name: ra.originator_dept_name,
      business_id: ra.approval_id,
      process_instance_id: ra.process_instance_id,
      status: ra.status,
      result: ra.result,
    };
    parsedVisits = await parseApprovalInstance(instance);
    parseOk = parsedVisits.length > 0;
    if (!parseOk) parseError = "解析未产出任何签到点（可能所有定位字段为空）";
  } catch (err) {
    parseOk = false;
    parseError = err instanceof Error ? err.message : String(err);
  }

  // 第③步：已入库 visits
  const storedResult = await pool.query(
    `SELECT id, user_id, user_name, department, timestamp, business_date,
            lat, lng, location_name, address, customer_name,
            sequence, trip_type, vehicle, start_odometer, end_odometer,
            reported_distance_km, cumulative_mileage_km, visit_note,
            geocode_status
     FROM visits
     WHERE approval_id = $1
     ORDER BY sequence ASC`,
    [approvalId]
  );

  // 该单关联的质量问题
  const qualityResult = await pool.query(
    `SELECT id, record_index, user_id, business_date, check_type, severity, message, raw_value, resolved, created_at
     FROM data_quality_records
     WHERE source = 'dingtalk' AND source_id = $1
     ORDER BY created_at DESC`,
    [approvalId]
  );

  return {
    approvalId,
    meta: {
      userName: ra.originator_user_name ?? undefined,
      department: ra.originator_dept_name ?? undefined,
      createTime: ra.create_time ?? undefined,
      finishTime: ra.finish_time ?? undefined,
      status: ra.status ?? undefined,
      result: ra.result ?? undefined,
    },
    rawForm,
    parsedVisits,
    parseOk,
    parseError,
    storedVisits: storedResult.rows,
    qualityRecords: qualityResult.rows,
  };
}
