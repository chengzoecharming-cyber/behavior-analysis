import * as XLSX from "xlsx";
import { geocodeAddress } from "./geocoding";

export interface ParsedVisit {
  user_name: string;
  department: string;
  time: string;
  location_name: string;
  address: string;
  customer_name: string;
  lat: number | null;
  lng: number | null;
}

export interface ParseResult {
  visits: ParsedVisit[];
  rawRows: any[];
  skippedRows: number;
}

export async function parseDingTalkExcel(filePath: string): Promise<ParseResult> {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (rows.length < 3) {
    return { visits: [], rawRows: rows, skippedRows: 0 };
  }

  const visits: ParsedVisit[] = [];
  let skippedRows = 0;

  // 从第 2 行开始是数据（0 和 1 是表头）
  for (let i = 2; i < rows.length; i++) {
    const row: any[] = rows[i] as any[];
    const creator = String(row[83] || "").trim();
    const department = String(row[89] || "").trim();

    if (!creator) {
      skippedRows++;
      continue;
    }

    const visitBlocks = [
      { timeIdx: 6, locIdx: 7, custIdx: 8 },
      { timeIdx: 12, locIdx: 13, custIdx: 20 },
      { timeIdx: 24, locIdx: 25, custIdx: 32 },
      { timeIdx: 36, locIdx: 37, custIdx: 44 },
      { timeIdx: 48, locIdx: 49, custIdx: 56 },
      { timeIdx: 60, locIdx: 61, custIdx: 71 }, // 最后签到
      { timeIdx: 69, locIdx: 70, custIdx: 73 },
    ];

    for (const block of visitBlocks) {
      const time = String(row[block.timeIdx] || "").trim();
      const location = String(row[block.locIdx] || "").trim();
      const customer = String(row[block.custIdx] || "").trim();

      if (!time || !location) continue;

      const customerName = cleanCustomerName(customer);
      const coords = await geocodeAddress(location);

      visits.push({
        user_name: creator,
        department: department || "销售部",
        time,
        location_name: truncate(location, 120),
        address: location,
        customer_name: customerName,
        lat: coords?.lat ?? 0,
        lng: coords?.lng ?? 0,
      });
    }
  }

  return { visits, rawRows: rows, skippedRows };
}

function cleanCustomerName(raw: string): string {
  if (!raw) return "";
  // 去除 "客户名称:" 前缀
  let cleaned = raw.replace(/^客户名称[:：]/, "").trim();
  // 只取第一行
  cleaned = cleaned.split("\n")[0].trim();
  // 去除过长内容
  return truncate(cleaned, 100);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}
