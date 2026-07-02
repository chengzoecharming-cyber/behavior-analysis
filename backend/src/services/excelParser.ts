import * as XLSX from "xlsx";
import { batchGeocode } from "./geocoding";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { ParsedVisit } from "../types";

export interface ParseResult {
  visits: ParsedVisit[];
  rawRows: any[];
  skippedRows: number;
}

// 钉钉审批导出表《用车里程登记&客户签到》的列索引（基于 20260618174656.xlsx）
const COL = {
  // 审批基础
  approvalId: 81, // 审批编号
  creator: 83, // 创建人（员工姓名）
  department: 89, // 创建人部门
  createTime: 82, // 创建时间

  // 行程信息
  tripType: 2, // 请选择出行方式
  vehicle: 3, // 选择出行车辆
  startOdometer: 4, // 出发里程读数

  // 汇总信息
  totalSignCount: 67, // 今日累计签到次数
  totalMileage: 68, // 今日累计里程
  specialSignReason: 72, // 特殊签到原因

  // 5 段拜访记录块（段内列索引相对该块起始）
  visitBlocks: [
    {
      time: 6,
      location: 7,
      customerTitle: 8,
      customerDetail: 9,
      customerRelated: 10,
      customerAddress: 11,
      note: 14,
      endOdometer: 15,
      continuesToNext: 17,
      signCount: 18,
      cumulativeMileage: 19,
    },
    {
      time: 12,
      location: 13,
      customerTitle: 20,
      customerDetail: 21,
      customerRelated: 22,
      customerAddress: 23,
      note: 26,
      endOdometer: 27,
      continuesToNext: 29,
      signCount: 30,
      cumulativeMileage: 31,
    },
    {
      time: 24,
      location: 25,
      customerTitle: 32,
      customerDetail: 33,
      customerRelated: 34,
      customerAddress: 35,
      note: 38,
      endOdometer: 39,
      continuesToNext: 41,
      signCount: 42,
      cumulativeMileage: 43,
    },
    {
      time: 36,
      location: 37,
      customerTitle: 44,
      customerDetail: 45,
      customerRelated: 46,
      customerAddress: 47,
      note: 50,
      endOdometer: 51,
      continuesToNext: 53,
      signCount: 54,
      cumulativeMileage: 55,
    },
    {
      time: 48,
      location: 49,
      customerTitle: 56,
      customerDetail: 57,
      customerRelated: 58,
      customerAddress: 59,
      note: 62,
      endOdometer: 63,
      continuesToNext: -1, // 最后一段无需"是否前往下一个目的地"
      signCount: 65,
      cumulativeMileage: 66,
    },
  ],

  // 末尾特殊签到块
  specialBlock: {
    time: 69,
    location: 70,
    signLocation: 71, // 打卡地
    specialReason: 72,
    customerTitle: 74,
    customerDetail: 75,
    customerRelated: 76,
    customerAddress: 77,
    altTime: 76, // 另一组当前时间
    altLocation: 77, // 另一组当前地点
    note: 78,
  },
};

export async function parseDingTalkExcel(filePath: string): Promise<ParseResult> {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[][];

  if (rows.length < 3) {
    return { visits: [], rawRows: rows, skippedRows: 0 };
  }

  const rawVisits: ParsedVisit[] = [];
  let skippedRows = 0;

  // 从第 3 行开始是数据（索引 0、1 是双行表头）
  for (let i = 2; i < rows.length; i++) {
    const row: any[] = rows[i];
    const creator = String(row[COL.creator] || "").trim();
    const department = String(row[COL.department] || "").trim();
    const approvalId = String(row[COL.approvalId] || "").trim();
    const createTime = String(row[COL.createTime] || "").trim();
    const tripType = String(row[COL.tripType] || "").trim();
    const vehicle = String(row[COL.vehicle] || "").trim();
    const startOdometer = parseNumber(row[COL.startOdometer]);
    const totalSignCount = parseNumber(row[COL.totalSignCount]);
    const totalMileage = parseNumber(row[COL.totalMileage]);
    const specialSignReason = String(row[COL.specialSignReason] || "").trim();

    if (!creator) {
      skippedRows++;
      continue;
    }

    let sequence = 0;

    // 5 段拜访记录
    for (const block of COL.visitBlocks) {
      const time = String(row[block.time] || "").trim();
      const location = String(row[block.location] || "").trim();
      if (!time || !location) continue;

      const customerName = extractCustomerName(row, block.customerTitle, block.customerDetail);

      rawVisits.push({
        user_name: creator,
        department: department || "销售部",
        time,
        location_name: truncate(location, 120),
        address: location,
        customer_name: customerName,
        lat: null,
        lng: null,
        approval_id: approvalId,
        sequence: sequence++,
        trip_type: tripType,
        vehicle,
        start_odometer: startOdometer,
        end_odometer: parseNumber(row[block.endOdometer]),
        reported_distance_km: validMileage(row[block.cumulativeMileage]),
        visit_note: String(row[block.note] || "").trim(),
        special_sign_reason: specialSignReason,
        sign_count: parseNumber(row[block.signCount]),
        continues_to_next: block.continuesToNext >= 0 ? String(row[block.continuesToNext] || "").includes("是") : undefined,
        source_detail: "dingtalk_visit",
      });
    }

    // 末尾特殊签到
    const specialTime = String(row[COL.specialBlock.time] || "").trim()
      || String(row[COL.specialBlock.altTime] || "").trim()
      || createTime;
    const specialLocation = String(row[COL.specialBlock.location] || "").trim()
      || String(row[COL.specialBlock.altLocation] || "").trim()
      || String(row[COL.specialBlock.signLocation] || "").trim();
    if (specialTime && specialLocation) {
      const customerName = extractCustomerName(
        row,
        COL.specialBlock.customerTitle,
        COL.specialBlock.customerDetail
      );

      rawVisits.push({
        user_name: creator,
        department: department || "销售部",
        time: specialTime,
        location_name: truncate(specialLocation, 120),
        address: specialLocation,
        customer_name: customerName,
        lat: null,
        lng: null,
        approval_id: approvalId,
        sequence: sequence++,
        trip_type: tripType,
        vehicle,
        start_odometer: startOdometer,
        reported_distance_km: validMileage(totalMileage),
        visit_note: String(row[COL.specialBlock.note] || "").trim(),
        special_sign_reason: specialSignReason,
        source_detail: "dingtalk_special_sign",
      });
    }
  }

  // 批量地理编码：去重地址后统一解析，减少 API 调用
  const addresses = rawVisits.map((v) => v.address).filter((a): a is string => !!a);
  const geocodeMap = await batchGeocode(addresses);

  const visits: ParsedVisit[] = rawVisits.map((v) => {
    const coords = v.address ? geocodeMap.get(v.address) ?? null : null;
    return {
      ...v,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    };
  });

  return { visits, rawRows: rows, skippedRows };
}

function extractCustomerName(row: any[], titleIdx: number, detailIdx: number): string {
  const title = String(row[titleIdx] || "").trim();
  const detail = String(row[detailIdx] || "").trim();
  const raw = title || detail;
  return cleanCustomerName(raw);
}

function cleanCustomerName(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.replace(/^客户名称[:：]/, "").trim();
  cleaned = cleaned.split("\n")[0].trim();
  return truncate(cleaned, 100);
}

function parseNumber(value: any): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, ""));
  return isNaN(n) ? undefined : n;
}

function validMileage(value: any): number | undefined {
  const n = parseNumber(value);
  if (n == null) return undefined;
  if (n < 0 || n > MAX_MILEAGE_KM) return undefined;
  return n;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}
