import * as XLSX from "xlsx";
import { pool } from "../db";
import { ParsedVisit } from "../types";
import { totalDistanceKm } from "./distance";
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

export interface ProcessResult {
  rawInserted: number;
  normalizedInserted: number;
  skipped: number;
  totalDistanceKm: number;
  geocodeFailures: GeocodeFailure[];
  affectedUserDates: AffectedUserDate[];
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
  source: "excel" | "dingtalk"
): Promise<string[]> {
  const result: string[] = [];

  if (source !== "dingtalk") {
    for (const visit of parsedVisits) {
      const ts = normalizeTimestamp(visit.time);
      result.push(formatBeijingDate(ts));
    }
    return result;
  }

  // 钉钉数据：按 approval_id 分组，取审批发起时间（fallback 最早签到时间）作为业务日期
  const groups = new Map<string, ParsedVisit[]>();
  for (let i = 0; i < parsedVisits.length; i++) {
    const visit = parsedVisits[i];
    const approvalId = visit.approval_id || "_no_approval";
    if (!groups.has(approvalId)) groups.set(approvalId, []);
    groups.get(approvalId)!.push(visit);
  }

  const dateByVisit = new Map<ParsedVisit, string>();
  for (const [approvalId, visits] of groups) {
    if (approvalId === "_no_approval") {
      for (const visit of visits) {
        dateByVisit.set(visit, formatBeijingDate(normalizeTimestamp(visit.time)));
      }
      continue;
    }

    const approvalResult = await pool.query(
      `SELECT create_time FROM raw_approvals WHERE approval_id = $1 LIMIT 1`,
      [approvalId]
    );

    let businessDate: string;
    if (approvalResult.rows.length > 0 && approvalResult.rows[0].create_time) {
      businessDate = formatBeijingDate(approvalResult.rows[0].create_time);
    } else {
      const timestamps = visits.map((v) => normalizeTimestamp(v.time).getTime());
      businessDate = formatBeijingDate(new Date(Math.min(...timestamps)));
    }

    for (const visit of visits) {
      dateByVisit.set(visit, businessDate);
    }
  }

  for (const visit of parsedVisits) {
    result.push(dateByVisit.get(visit)!);
  }

  return result;
}

export async function processParsedVisits(
  parsedVisits: ParsedVisit[],
  source: "excel" | "dingtalk"
): Promise<ProcessResult> {
  const insertedRaw: number[] = [];
  const insertedNormalized: number[] = [];
  let skippedCount = 0;
  const userPointsMap: Record<string, { lat: number; lng: number }[]> = {};
  const geocodeFailures: GeocodeFailure[] = [];
  const affectedUserDates = new Set<string>();
  const businessDates = await computeBusinessDates(parsedVisits, source);

  for (let i = 0; i < parsedVisits.length; i++) {
    const visit = parsedVisits[i];
    const userId = visit.user_id || normalizeUserId(visit.user_name);
    const timestamp = normalizeTimestamp(visit.time);
    const lat = normalizeCoordinate(visit.lat);
    const lng = normalizeCoordinate(visit.lng);
    const geocodeStatus = lat == null || lng == null ? "failed" : "success";

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
        approval_id, sequence, trip_type, vehicle, start_odometer, end_odometer,
        reported_distance_km, visit_note, special_sign_reason, geocode_status, source_detail,
        business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
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
        visit.sequence ?? 0,
        visit.trip_type ?? null,
        visit.vehicle ?? null,
        visit.start_odometer ?? null,
        visit.end_odometer ?? null,
        visit.reported_distance_km ?? null,
        visit.visit_note ?? null,
        visit.special_sign_reason ?? null,
        geocodeStatus,
        visit.source_detail ?? null,
        businessDates[i],
      ]
    );
    insertedNormalized.push(visitResult.rows[0].id);
    affectedUserDates.add(
      JSON.stringify({ user_id: userId, business_date: businessDates[i] })
    );

    if (!userPointsMap[userId]) userPointsMap[userId] = [];
    if (lat != null && lng != null) {
      userPointsMap[userId].push({ lat, lng });
    }
  }

  let totalDistance = 0;
  for (const uid of Object.keys(userPointsMap)) {
    totalDistance += totalDistanceKm(userPointsMap[uid]);
  }

  return {
    rawInserted: insertedRaw.length,
    normalizedInserted: insertedNormalized.length,
    skipped: skippedCount,
    totalDistanceKm: parseFloat(totalDistance.toFixed(2)),
    geocodeFailures,
    affectedUserDates: Array.from(affectedUserDates).map((s) => JSON.parse(s)),
  };
}
