import * as XLSX from "xlsx";
import { pool } from "../db";
import { ParsedVisit } from "../types";
import { parseDateTimeAsBeijing, formatBeijingDate } from "../utils/timezone";
import {
  loadUserHomeAddresses,
  loadCompanyAddresses,
  isHomeAddress,
  isCompanyAddress,
  HomeAddressInfo,
  CompanyAddress,
} from "./addressWhitelistService";

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

// 拆分多客户名：v1 的「客户名称」关联字段和 v2 的 TableField 都可能在一个打卡点
// 填多家客户，存储时用 [,，、] 连接。统计客户数/拜访次数时按分隔符拆开计。
export function splitCustomerNames(name?: string | null): string[] {
  if (!name) return [];
  return name
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// v2 占位客户名（不算真实拜访）：「虚拟客户」家族 + CRM 遗留占位选项「XX（签到用）」
// （虚拟客户/住址/公司（签到用））。业务约定：住址、公司、酒店类未真实拜访的打卡，
// 源头统一在客户字段写「虚拟客户」；「签到用」不会出现在真实客户名中，零误伤。
const PLACEHOLDER_CUSTOMER_PATTERN = /虚拟|签到用/;

// v2 拜访计数口径：逐个客户名判定，返回非占位的真实客户名列表。
// 情况B（不计拜访）= 真实客户名数为 0（空、全占位）；混合填写「真实客户A、虚拟客户」
// 时真实客户仍计入拜访（realCount = 1，不排除）。
export function splitRealCustomerNames(name?: string | null): string[] {
  return splitCustomerNames(name).filter((n) => !PLACEHOLDER_CUSTOMER_PATTERN.test(n));
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
  // 归日口径：
  // - Excel：按每条签到实际时间（北京时间）归日。
  // - 钉钉：整张审批单按「首次签到日期」归日。即使审批单跨天（如次日早上补收尾签到），
  //   所有签到也归到行程开始的那天，控制台一天只展示一次，与里程口径（按审批单
  //   首次签到日期聚合）保持一致。审批单创建时间不作为归日依据（可能补卡/提前提交），
  //   仅保留在 raw_approvals 用于对账。
  if (source !== "dingtalk") {
    return parsedVisits.map((visit) =>
      formatBeijingDate(normalizeTimestamp(visit.time))
    );
  }

  // 按 approval_id 分组，取每组最早签到时间的北京时间日期作为整组的业务日期
  const firstDateByApproval = new Map<string, string>();
  for (const visit of parsedVisits) {
    if (!visit.approval_id) continue;
    const d = formatBeijingDate(normalizeTimestamp(visit.time));
    const cur = firstDateByApproval.get(visit.approval_id);
    if (!cur || d < cur) {
      firstDateByApproval.set(visit.approval_id, d);
    }
  }

  return parsedVisits.map((visit) => {
    const own = formatBeijingDate(normalizeTimestamp(visit.time));
    if (visit.approval_id) {
      return firstDateByApproval.get(visit.approval_id) ?? own;
    }
    return own;
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

  // 批内去重（钉钉数据）：同一 approval_id+user_id+sequence 在本批次只插入第一条，
  // 其余直接跳过——此前只记质量报告不跳过，批内重复会双双入库
  const insertedKeys = new Set<string>();

  // 拜访次数统计排除打标：公司地址全批加载一次；员工住址按 userId 惰性加载并缓存
  const companyAddresses: CompanyAddress[] = await loadCompanyAddresses();
  const homeAddressCache = new Map<string, HomeAddressInfo | null>();
  const getHomeAddress = async (userId: string): Promise<HomeAddressInfo | null> => {
    if (!homeAddressCache.has(userId)) {
      const map = await loadUserHomeAddresses([userId]);
      homeAddressCache.set(userId, map.get(userId) ?? null);
    }
    return homeAddressCache.get(userId) ?? null;
  };

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
      // v2 特例：钉钉 AI总结在审批单结束后才生成，RUNNING 期入库的是兜底拼接文本，
      // 因此允许 v2 行刷新 visit_note 与 visit_detail（其他字段维持「存在即跳过」不动）。
      // IS DISTINCT FROM 保证只在内容变化时写，幂等。
      if (visit.form_version === "v2" && visit.approval_id && visit.sequence != null) {
        await pool.query(
          `UPDATE visits SET visit_note = $1, visit_detail = $2
           WHERE approval_id = $3 AND user_id = $4 AND sequence = $5
             AND (visit_note IS DISTINCT FROM $1 OR visit_detail IS DISTINCT FROM $2)`,
          [
            visit.visit_note ?? null,
            visit.visit_detail ? JSON.stringify(visit.visit_detail) : null,
            visit.approval_id,
            userId,
            visit.sequence,
          ]
        );
      }
      continue;
    }

    // 批内去重：钉钉数据同一审批单序号在本批次已插入过则跳过
    if (visit.approval_id && visit.sequence != null) {
      const key = `${visit.approval_id}|${userId}|${visit.sequence}`;
      if (insertedKeys.has(key)) {
        skippedCount++;
        continue;
      }
      insertedKeys.add(key);
    }

    // 拜访次数统计排除（不影响轨迹/停留/里程/异常）：
    // - v2 新表单：按「出行方式 × 客户名称」口径——逐个客户名判定，非占位
    //   （虚拟客户/签到用）客户名数为 0 即情况B排除，不看地址；混合填写时真实客户照计
    // - v1 旧表单 / Excel：命中员工本人住址或公司地址白名单即排除
    let excludeFromVisitCount: boolean;
    let customerCount: number;
    if (visit.form_version === "v2") {
      const realNames = splitRealCustomerNames(visit.customer_name);
      excludeFromVisitCount = realNames.length === 0;
      customerCount = realNames.length;
    } else {
      const homeAddress = await getHomeAddress(userId);
      const visitLocation = {
        address: visit.address,
        location_name: visit.location_name,
        lat,
        lng,
      };
      excludeFromVisitCount =
        (homeAddress ? await isHomeAddress(visitLocation, homeAddress) : false) ||
        isCompanyAddress(visitLocation, companyAddresses);
      // v1/Excel 未显式给出时按 customer_name 分隔符拆分计（v1 虚拟客户是真实拜访，
      // 一并计入），空名单值按 1（v1 地址制：无客户名的有效签到点仍计 1 次）
      customerCount = visit.customer_count ?? Math.max(splitCustomerNames(visit.customer_name).length, 1);
    }

    // raw_visits + visits 在同一事务写入；visits 靠部分唯一索引
    // (approval_id, user_id, sequence) 兜底防并发重复——
    // 冲突时整事务回滚，避免 raw_visits 留下孤儿行（坏数据每轮同步膨胀）
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rawResult = await client.query(
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

      const visitResult = await client.query(
        `INSERT INTO visits
         (raw_visit_id, user_id, user_name, department, timestamp, lat, lng,
          location_name, address, customer_name, source,
          approval_id, approval_status, sequence, trip_type, vehicle, start_odometer, end_odometer,
          reported_distance_km, cumulative_mileage_km, visit_note, special_sign_reason, photos, geocode_status, source_detail,
          business_date, exclude_from_visit_count, customer_count, form_version, visit_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
         ON CONFLICT (approval_id, user_id, sequence) WHERE approval_id IS NOT NULL DO NOTHING
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
          excludeFromVisitCount,
          customerCount,
          visit.form_version ?? null,
          visit.visit_detail ? JSON.stringify(visit.visit_detail) : null,
        ]
      );

      if (visitResult.rows.length === 0) {
        // 唯一约束兜底命中：并发任务已插入同一条，回滚避免 raw_visits 孤儿行
        await client.query("ROLLBACK");
        skippedCount++;
        continue;
      }

      await client.query("COMMIT");
      insertedRaw.push(rawVisitId);
      insertedNormalized.push(visitResult.rows[0].id);
      affectedUserDates.add(
        JSON.stringify({ user_id: userId, business_date: businessDates[i] })
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
