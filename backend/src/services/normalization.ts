import * as XLSX from "xlsx";
import { pool } from "../db";
import { ParsedVisit } from "../types";
import { parseDateTimeAsBeijing, formatBeijingDate } from "../utils/timezone";

export interface GeocodeFailure {
  row: number;
  location: string;
  user: string;
}

export interface AffectedUserDate {
  user_id: string;
  business_date: string;
}

export interface QualitySummary {
  totalRecords: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  insertedCount: number;
  skippedCount: number;
  /** 按 check_type 分组的失败计数，方便前端快速定位主要问题类型 */
  byCheckType: Record<string, number>;
}

export interface ProcessResult {
  rawInserted: number;
  normalizedInserted: number;
  skipped: number;
  geocodeFailures: GeocodeFailure[];
  affectedUserDates: AffectedUserDate[];
  qualitySummary?: QualitySummary;
}

export function normalizeUserId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

interface XlsxDateParts {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  S: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function normalizeTimestamp(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    // Excel 日期序列号解析为 {y, m, d, H, M, S} 对象，月份从 1 开始
    const parsed = XLSX.SSF.parse_date_code(value) as XlsxDateParts;
    const beijingStr = `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}T${pad2(parsed.H)}:${pad2(parsed.M)}:${pad2(parsed.S)}`;
    return parseDateTimeAsBeijing(beijingStr);
  }
  return parseDateTimeAsBeijing(value);
}

/** 校验坐标是否有效，无效时返回 null */
export function normalizeCoordinate(value: unknown): number | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(num)) return null;
  return num;
}

export async function checkDuplicateVisit(
  userId: string,
  timestamp: Date,
  locationName: string,
  address: string,
  approvalId?: string,
  sequence?: number
): Promise<boolean> {
  // 钉钉数据：按 approval_id + sequence + user_id 去重
  if (approvalId && sequence !== undefined) {
    const result = await pool.query(
      `SELECT id FROM visits WHERE approval_id = $1 AND sequence = $2 AND user_id = $3 LIMIT 1`,
      [approvalId, sequence, userId]
    );
    return result.rows.length > 0;
  }

  // 普通 Excel：按 user_id + timestamp + location_name + address 去重
  const result = await pool.query(
    `SELECT id FROM visits
     WHERE user_id = $1
       AND timestamp = $2
       AND location_name = $3
       AND COALESCE(address, '') = COALESCE($4, '')
     LIMIT 1`,
    [userId, timestamp, locationName, address]
  );
  return result.rows.length > 0;
}

async function computeBusinessDates(
  parsedVisits: ParsedVisit[],
  _source: "excel" | "dingtalk"
): Promise<string[]> {
  // 业务日期统一按实际签到时间（北京时间）计算。
  // 钉钉审批单的创建时间可能早于或晚于实际签到时间（补卡/提前提交），
  // 而外勤分析关心的是员工真实发生拜访的日期，因此以 visit.time 为准。
  return parsedVisits.map((visit) => {
    const ts = normalizeTimestamp(visit.time);
    return formatBeijingDate(ts);
  });
}

export async function processParsedVisits(
  parsedVisits: ParsedVisit[],
  source: "excel" | "dingtalk"
): Promise<ProcessResult> {
  const insertedRaw: number[] = [];
  const insertedNormalized: number[] = [];
  let skippedCount = 0;
  const geocodeFailures: GeocodeFailure[] = [];
  const affectedUserDates = new Set<string>();
  const businessDates = await computeBusinessDates(parsedVisits, source);

  // 导入断言：收集质量问题，循环结束后批量写入，绝不影响导入本身。
  // 注意：assertions.ts 依赖本文件（normalizeTimestamp 等），存在循环引用，
  // 因此用动态 import() 延迟加载，且只加载一次而非每次循环。
  type AssertionsModule = typeof import("./dataQuality/assertions");
  let assertionsModule: AssertionsModule | null = null;
  try {
    assertionsModule = await import("./dataQuality/assertions");
  } catch {
    // 加载失败时静默跳过质量检查
  }
  const qualityFailures: import("./dataQuality/assertions").QualityRecordInput[] = [];

  // 批内重复检测（钉钉数据）：同一批次里 approval_id+sequence+user_id 出现多次，
  // 说明源数据本身重复（如重复导出）。库内已有记录由 checkDuplicateVisit 负责。
  const batchDuplicateCounts = assertionsModule
    ? assertionsModule.findBatchDuplicates(parsedVisits)
    : new Map<string, number>();
  const reportedBatchDupKeys = new Set<string>();

  for (let i = 0; i < parsedVisits.length; i++) {
    const visit = parsedVisits[i];
    const userId = visit.user_id || normalizeUserId(visit.user_name);
    const timestamp = normalizeTimestamp(visit.time);
    const lat = normalizeCoordinate(visit.lat);
    const lng = normalizeCoordinate(visit.lng);
    const geocodeStatus = lat == null || lng == null ? "failed" : "success";

    // 收集该条记录的质量断言结果（不写入，循环结束后批量写）
    if (assertionsModule) {
      try {
        const { failures, businessDate } = assertionsModule.checkVisitQuality(visit, i + 1);
        for (const f of failures) {
          qualityFailures.push({
            source,
            sourceId: visit.approval_id ?? undefined,
            recordIndex: i + 1,
            userId,
            businessDate,
            checkType: f.checkType,
            severity: f.severity,
            message: f.message,
            rawValue: f.rawValue,
          });
        }
      } catch {
        // 断言本身失败时静默跳过，绝不影响导入
      }

      // 批内重复：每个重复 key 只记一条 error（在第二次遇到时记录，首次出现不记，避免误报）
      try {
        if (visit.approval_id && visit.sequence != null) {
          const dupKey = `${visit.approval_id}|${visit.sequence}|${userId}`;
          const cnt = batchDuplicateCounts.get(dupKey) ?? 0;
          // cnt>1 表示该 key 在批内重复；用 seenCounts 追踪当前是第几次遇到
          const seen = (reportedBatchDupKeys.has(dupKey) ? 1 : 0) + 1;
          if (cnt > 1 && seen === 2) {
            qualityFailures.push({
              source,
              sourceId: visit.approval_id ?? undefined,
              recordIndex: i + 1,
              userId,
              businessDate: businessDates[i],
              checkType: "duplicate",
              severity: "error",
              message: `同一批次内 approval_id+sequence+user_id 重复出现 ${cnt} 次，源数据可能重复导出`,
              rawValue: `approval_id=${visit.approval_id}, sequence=${visit.sequence}, user_id=${userId}`,
            });
          }
          // 标记已遇到过该 key（无论是否记录）
          reportedBatchDupKeys.add(dupKey);
        }
      } catch {
        // 重复检测失败时静默跳过
      }
    }

    if (geocodeStatus === "failed") {
      geocodeFailures.push({
        row: i + 1,
        location: visit.location_name,
        user: visit.user_name,
      });
    }

    const isDuplicate = await checkDuplicateVisit(
      userId,
      timestamp,
      visit.location_name,
      visit.address,
      visit.approval_id,
      visit.sequence
    );
    if (isDuplicate) {
      skippedCount++;
      continue;
    }

    const rawResult = await pool.query(
      `INSERT INTO raw_visits
       (raw_user_name, raw_time, raw_location, raw_address, raw_lat, raw_lng, raw_customer_name, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        visit.user_name,
        visit.time,
        visit.location_name,
        visit.address,
        String(visit.lat ?? ""),
        String(visit.lng ?? ""),
        visit.customer_name,
        source,
      ]
    );
    const rawVisitId = rawResult.rows[0].id;
    insertedRaw.push(rawVisitId);

    const visitResult = await pool.query(
      `INSERT INTO visits
       (raw_visit_id, user_id, user_name, department, timestamp, lat, lng,
        location_name, address, customer_name, source,
        approval_id, approval_status, sequence, trip_type, vehicle, start_odometer, end_odometer,
        reported_distance_km, cumulative_mileage_km, visit_note, special_sign_reason, photos, geocode_status, source_detail,
        business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        rawVisitId,
        userId,
        visit.user_name,
        visit.department,
        timestamp,
        lat,
        lng,
        visit.location_name,
        visit.address,
        visit.customer_name,
        source,
        visit.approval_id ?? null,
        visit.approval_status ?? null,
        visit.sequence ?? 0,
        visit.trip_type ?? null,
        visit.vehicle ?? null,
        visit.start_odometer ?? null,
        visit.end_odometer ?? null,
        visit.reported_distance_km ?? null,
        visit.cumulative_mileage_km ?? null,
        visit.visit_note ?? null,
        visit.special_sign_reason ?? null,
        Array.isArray(visit.photos) && visit.photos.length > 0
          ? JSON.stringify(visit.photos)
          : "[]",
        geocodeStatus,
        visit.source_detail ?? null,
        businessDates[i],
      ]
    );
    insertedNormalized.push(visitResult.rows[0].id);
    affectedUserDates.add(
      JSON.stringify({ user_id: userId, business_date: businessDates[i] })
    );
  }

  // 循环结束后批量写入质量断言结果，失败时静默跳过，绝不影响导入返回
  if (assertionsModule && qualityFailures.length > 0) {
    try {
      await assertionsModule.batchRecordQualityRecords(qualityFailures);
    } catch (err) {
      console.warn("[dataQuality] 批量写入质量记录失败:", err);
    }
  }

  // 汇总质量统计并写入 data_quality_summary（每个导入批次一条）
  let qualitySummary: QualitySummary | undefined;
  if (assertionsModule) {
    try {
      const byCheckType: Record<string, number> = {};
      let errorCount = 0;
      let warningCount = 0;
      let infoCount = 0;
      for (const f of qualityFailures) {
        byCheckType[f.checkType] = (byCheckType[f.checkType] ?? 0) + 1;
        if (f.severity === "error") errorCount++;
        else if (f.severity === "warning") warningCount++;
        else infoCount++;
      }

      const businessDateValues = businessDates.filter(Boolean).sort();
      await assertionsModule.recordQualitySummary({
        jobType: source === "excel" ? "excel_upload" : "dingtalk_sync",
        startDate: businessDateValues[0],
        endDate: businessDateValues[businessDateValues.length - 1],
        totalRecords: parsedVisits.length,
        errorCount,
        warningCount,
        infoCount,
        insertedCount: insertedNormalized.length,
        skippedCount,
        details: { byCheckType, geocodeFailureCount: geocodeFailures.length },
      });

      qualitySummary = {
        totalRecords: parsedVisits.length,
        errorCount,
        warningCount,
        infoCount,
        insertedCount: insertedNormalized.length,
        skippedCount,
        byCheckType,
      };
    } catch (err) {
      console.warn("[dataQuality] 写入质量汇总失败:", err);
    }
  }

  return {
    rawInserted: insertedRaw.length,
    normalizedInserted: insertedNormalized.length,
    skipped: skippedCount,
    geocodeFailures,
    affectedUserDates: Array.from(affectedUserDates).map((s) => JSON.parse(s)),
    qualitySummary,
  };
}
