import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "fs";
import { pool } from "../db";
import { RawVisitRow, ParsedVisit } from "../types";
import { parseDingTalkExcel } from "../services/excelParser";
import { processParsedVisits, GeocodeFailure } from "../services/normalization";

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads", { recursive: true });
}

const upload = multer({ dest: "uploads/" });
const router = Router();

interface UploadResponse {
  success: boolean;
  rawInserted?: number;
  normalizedInserted?: number;
  skipped?: number;
  totalDistanceKm?: number;
  preview?: ParsedVisit[];
  isDingTalk?: boolean;
  geocodeFailures?: GeocodeFailure[];
  geocodeFailureSamples?: GeocodeFailure[];
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
    const processResult = await processParsedVisits(
      parsedVisits,
      isDingTalk ? "dingtalk" : "excel"
    );

    const response: UploadResponse = {
      success: true,
      rawInserted: processResult.rawInserted,
      normalizedInserted: processResult.normalizedInserted,
      skipped: processResult.skipped,
      totalDistanceKm: processResult.totalDistanceKm,
      geocodeFailures: processResult.geocodeFailures,
      geocodeFailureSamples: processResult.geocodeFailures.slice(0, 5),
    };

    res.json(response);
  } catch (err) {
    console.error("Failed to upload excel:", err);
    res.status(500).json({ error: "Failed to process file" });
  }
});

export default router;
