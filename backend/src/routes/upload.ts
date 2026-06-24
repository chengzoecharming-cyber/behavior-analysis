import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "fs";
import { pool } from "../db";
import { RawVisitRow, ParsedVisit } from "../types";
import { totalDistanceKm } from "../services/distance";
import { parseDingTalkExcel } from "../services/excelParser";

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads", { recursive: true });
}

const upload = multer({ dest: "uploads/" });
const router = Router();

interface UploadResponse {
  success: boolean;
  rawInserted?: number;
  normalizedInserted?: number;
  totalDistanceKm?: number;
  preview?: ParsedVisit[];
  isDingTalk?: boolean;
  geocodeFailures?: GeocodeFailure[];
  geocodeFailureSamples?: GeocodeFailure[];
}

interface GeocodeFailure {
  row: number;
  location: string;
  user: string;
}

router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const isPreview = req.query.preview === "true";

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const firstRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[];
    const headerRow = firstRows[0] as string[];
    const isDingTalk = headerRow.some(
      (h) => String(h).includes("请选择出行方式") || String(h).includes("用车里程")
    );

    let parsedVisits: ParsedVisit[] = [];

    if (isDingTalk) {
      const result = await parseDingTalkExcel(req.file.path);
      parsedVisits = result.visits;
    } else {
      const rows = XLSX.utils.sheet_to_json<RawVisitRow>(sheet);
      parsedVisits = rows.map((r) => ({
        user_name: r.user_name,
        department: "销售部",
        time: String(r.time),
        location_name: r.location_name,
        address: r.address,
        customer_name: r.customer_name,
        lat: typeof r.lat === "number" ? r.lat : parseFloat(String(r.lat)),
        lng: typeof r.lng === "number" ? r.lng : parseFloat(String(r.lng)),
      }));
    }

    // 预览模式：只返回解析结果，不入库
    if (isPreview) {
      const response: UploadResponse = {
        success: true,
        preview: parsedVisits.slice(0, 10),
        isDingTalk,
      };
      res.json(response);
      return;
    }

    // 正式导入模式
    const insertedRaw: number[] = [];
    const insertedNormalized: number[] = [];
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
          isDingTalk ? "dingtalk" : "excel",
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
          isDingTalk ? "dingtalk" : "excel",
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
    for (const userId of Object.keys(userPointsMap)) {
      totalDistance += totalDistanceKm(userPointsMap[userId]);
    }

    const response: UploadResponse = {
      success: true,
      rawInserted: insertedRaw.length,
      normalizedInserted: insertedNormalized.length,
      totalDistanceKm: parseFloat(totalDistance.toFixed(2)),
      geocodeFailures: geocodeFailures,
      geocodeFailureSamples: geocodeFailures.slice(0, 5),
    };

    res.json(response);
  } catch (err) {
    console.error("Failed to upload excel:", err);
    res.status(500).json({ error: "Failed to process file" });
  }
});

function normalizeUserId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeTimestamp(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return XLSX.SSF.parse_date_code(value);
  }
  return new Date(value);
}

export default router;
