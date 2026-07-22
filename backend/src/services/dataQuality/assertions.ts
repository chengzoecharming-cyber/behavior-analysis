import { pool } from "../../db";
import { ParsedVisit } from "../../types";
import { normalizeTimestamp, normalizeCoordinate, normalizeUserId } from "../normalization";
import { formatBeijingDate } from "../../utils/timezone";
import { MAX_MILEAGE_KM } from "../mileageConfig";

export type Severity = "error" | "warning" | "info";
export type CheckType =
  | "timestamp"
  | "coordinate"
  | "mileage"
  | "duplicate"
  | "user"
  | "trip_type"
  | "odometer"
  | "approval_sequence";

export interface QualityRecordInput {
  source: "excel" | "dingtalk";
  sourceId?: string;
  recordIndex: number;
  userId?: string;
  businessDate?: string;
  checkType: CheckType;
  severity: Severity;
  message: string;
  rawValue?: string;
}

export interface QualitySummaryInput {
  jobType: "excel_upload" | "dingtalk_sync";
  jobId?: string;
  startDate?: string;
  endDate?: string;
  totalRecords: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  insertedCount: number;
  skippedCount: number;
  details?: Record<string, any>;
}

/**
 * 记录单条数据质量问题。
 * 这个函数不抛异常，只负责写入审计表，保证导入流程不被中断。
 */
export async function recordQualityRecord(input: QualityRecordInput): Promise<void> {
  await pool.query(
    `INSERT INTO data_quality_records
       (source, source_id, record_index, user_id, business_date, check_type, severity, message, raw_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.source,
      input.sourceId ?? null,
      input.recordIndex,
      input.userId ?? null,
      input.businessDate ?? null,
      input.checkType,
      input.severity,
      input.message,
      input.rawValue ?? null,
    ]
  );
}

export async function recordQualitySummary(input: QualitySummaryInput): Promise<void> {
  await pool.query(
    `INSERT INTO data_quality_summary
       (job_type, job_id, start_date, end_date, total_records, error_count, warning_count, info_count, inserted_count, skipped_count, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.jobType,
      input.jobId ?? null,
      input.startDate ?? null,
      input.endDate ?? null,
      input.totalRecords,
      input.errorCount,
      input.warningCount,
      input.infoCount,
      input.insertedCount,
      input.skippedCount,
      JSON.stringify(input.details ?? {}),
    ]
  );
}

interface AssertionResult {
  passed: boolean;
  severity: Severity;
  checkType: CheckType;
  message: string;
  rawValue?: string;
}

function assertTimestamp(value: string | number | Date): AssertionResult[] {
  const results: AssertionResult[] = [];
  try {
    normalizeTimestamp(value);
  } catch (err) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "timestamp",
      message: `时间解析失败: ${err instanceof Error ? err.message : String(err)}`,
      rawValue: String(value),
    });
  }
  return results;
}

function assertCoordinate(lat: unknown, lng: unknown): AssertionResult[] {
  const results: AssertionResult[] = [];
  const latNum = normalizeCoordinate(lat);
  const lngNum = normalizeCoordinate(lng);

  if (latNum == null || lngNum == null) {
    results.push({
      passed: false,
      severity: "warning",
      checkType: "coordinate",
      message: "坐标缺失，后续需要地理编码或人工修正",
      rawValue: `lat=${lat}, lng=${lng}`,
    });
    return results;
  }

  // 中国大致范围：纬度 18-54，经度 73-135
  if (latNum < 18 || latNum > 54 || lngNum < 73 || lngNum > 135) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "coordinate",
      message: "坐标超出中国合理范围，请检查是否经纬度写反或单位错误",
      rawValue: `lat=${latNum}, lng=${lngNum}`,
    });
  }

  return results;
}

function assertMileage(value: number | undefined | null): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (value == null) return results;
  if (value < 0) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "mileage",
      message: "填报里程为负数",
      rawValue: String(value),
    });
  }
  if (value > MAX_MILEAGE_KM) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "mileage",
      message: `填报里程超过上限 ${MAX_MILEAGE_KM} km`,
      rawValue: String(value),
    });
  }
  return results;
}

function assertOdometer(start?: number, end?: number): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (start == null && end == null) return results;
  if (start != null && end != null && end < start) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "odometer",
      message: "终点里程读数小于出发里程读数",
      rawValue: `start=${start}, end=${end}`,
    });
  }
  if (start == null && end != null) {
    results.push({
      passed: false,
      severity: "warning",
      checkType: "odometer",
      message: "缺少出发里程读数",
      rawValue: `start=${start}, end=${end}`,
    });
  }
  return results;
}

function assertUser(userId: string | undefined, userName: string): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (!userName || !userName.trim()) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "user",
      message: "员工姓名为空",
      rawValue: String(userName),
    });
  }
  if (!userId || !userId.trim()) {
    results.push({
      passed: false,
      severity: "error",
      checkType: "user",
      message: "员工 ID 为空",
      rawValue: String(userId),
    });
  }
  return results;
}

function assertTripType(tripType: string | undefined | null): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (!tripType) {
    results.push({
      passed: false,
      severity: "warning",
      checkType: "trip_type",
      message: "出行方式为空",
    });
  }
  return results;
}

/**
 * 对一条 ParsedVisit 做完整断言检查。
 * 返回所有失败项，调用方自行决定是否写入 data_quality_records。
 */
export function checkVisitQuality(
  visit: ParsedVisit,
  index: number
): { failures: AssertionResult[]; businessDate?: string } {
  const failures: AssertionResult[] = [];
  let businessDate: string | undefined;

  try {
    const ts = normalizeTimestamp(visit.time);
    businessDate = formatBeijingDate(ts);
  } catch {
    // 时间检查会补充失败项
  }

  failures.push(...assertTimestamp(visit.time));
  failures.push(...assertCoordinate(visit.lat, visit.lng));
  failures.push(...assertMileage(visit.reported_distance_km));
  failures.push(...assertMileage(visit.cumulative_mileage_km));
  failures.push(...assertOdometer(visit.start_odometer, visit.end_odometer));
  failures.push(...assertUser(visit.user_id, visit.user_name));
  failures.push(...assertTripType(visit.trip_type));

  return { failures, businessDate };
}

/**
 * 在导入流程中批量记录断言结果。
 * 这个函数应该在 processParsedVisits 的循环里被调用，每条失败记录写一条 quality record。
 */
export async function persistVisitQualityFailures(
  source: "excel" | "dingtalk",
  visit: ParsedVisit,
  index: number
): Promise<{ errorCount: number; warningCount: number; infoCount: number }> {
  const { failures, businessDate } = checkVisitQuality(visit, index);
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const f of failures) {
    if (f.severity === "error") errorCount++;
    if (f.severity === "warning") warningCount++;
    if (f.severity === "info") infoCount++;

    await recordQualityRecord({
      source,
      sourceId: visit.approval_id ?? undefined,
      recordIndex: index,
      userId: visit.user_id || normalizeUserId(visit.user_name),
      businessDate,
      checkType: f.checkType,
      severity: f.severity,
      message: f.message,
      rawValue: f.rawValue,
    });
  }

  return { errorCount, warningCount, infoCount };
}

/**
 * 查询尚未解决的异常记录，用于管理后台展示。
 */
export async function getUnresolvedQualityRecords(options?: {
  source?: "excel" | "dingtalk";
  userId?: string;
  limit?: number;
}): Promise<any[]> {
  const conditions: string[] = ["resolved = false"];
  const params: any[] = [];
  if (options?.source) {
    params.push(options.source);
    conditions.push(`source = $${params.length}`);
  }
  if (options?.userId) {
    params.push(options.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  const limit = options?.limit ?? 100;
  params.push(limit);

  const result = await pool.query(
    `SELECT * FROM data_quality_records
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}
