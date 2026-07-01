import * as XLSX from "xlsx";
import { pool } from "../db";
import { ParsedVisit } from "../types";
import { totalDistanceKm } from "./distance";
import { parseDateTimeAsBeijing } from "../utils/timezone";

export interface GeocodeFailure {
  row: number;
  location: string;
  user: string;
}

export interface ProcessResult {
  rawInserted: number;
  normalizedInserted: number;
  skipped: number;
  totalDistanceKm: number;
  geocodeFailures: GeocodeFailure[];
}

export function normalizeUserId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

export function normalizeTimestamp(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return XLSX.SSF.parse_date_code(value);
  }
  return parseDateTimeAsBeijing(value);
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

export async function processParsedVisits(
  parsedVisits: ParsedVisit[],
  source: "excel" | "dingtalk"
): Promise<ProcessResult> {
  const insertedRaw: number[] = [];
  const insertedNormalized: number[] = [];
  let skippedCount = 0;
  const userPointsMap: Record<string, { lat: number; lng: number }[]> = {};
  const geocodeFailures: GeocodeFailure[] = [];

  for (let i = 0; i < parsedVisits.length; i++) {
    const visit = parsedVisits[i];
    const userId = normalizeUserId(visit.user_name);
    const timestamp = normalizeTimestamp(visit.time);
    const geocodeStatus =
      visit.lat == null || visit.lng == null ? "failed" : "success";

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
        reported_distance_km, visit_note, special_sign_reason, geocode_status, source_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING id`,
      [
        rawVisitId,
        userId,
        visit.user_name,
        visit.department,
        timestamp,
        visit.lat ?? 0,
        visit.lng ?? 0,
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
      ]
    );
    insertedNormalized.push(visitResult.rows[0].id);

    if (!userPointsMap[userId]) userPointsMap[userId] = [];
    if (visit.lat && visit.lng) {
      userPointsMap[userId].push({ lat: visit.lat, lng: visit.lng });
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
  };
}
