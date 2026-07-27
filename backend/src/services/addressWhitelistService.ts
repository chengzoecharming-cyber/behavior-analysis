import { pool } from "../db";
import { Visit } from "../types";
import { geocodeAddress } from "./geocoding";
import { haversineDistance } from "./distance";

const HOME_RADIUS_KM = 0.5; // 半径兜底：500 米
const MIN_SUBSTRING_MATCH_LENGTH = 8; // 子串匹配最小长度（去除空格后）
const LCS_MATCH_RATIO = 0.8; // 最长公共子序列占 home 长度的比例阈值

/** 员工住址信息：文本地址 + 导入时持久化的坐标（坐标优先，避免运行时实时地理编码） */
export interface HomeAddressInfo {
  address: string;
  lat: number | null;
  lng: number | null;
}

/** 公司地址白名单条目 */
export interface CompanyAddress {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

// 地理编码结果缓存（仅缓存成功结果；失败不缓存，避免一次限流/抖动毒化整个检测周期）
const geocodeCache = new Map<string, { lat: number; lng: number }>();
// 防止同一地址并发多次请求高德
const geocodeInProgress = new Map<string, Promise<{ lat: number; lng: number } | null>>();

function normalizeAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[,.，。]/g, "");
}

/**
 * 计算两个字符串的最长公共子序列（LCS）长度。
 * 允许字符不连续但保持顺序，适合处理地址中插入门牌号、楼栋号等干扰。
 */
function longestCommonSubsequenceLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // 为节省内存，使用滚动数组
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
      } else {
        current[j] = Math.max(previous[j], current[j - 1]);
      }
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function hasSubstringMatch(visitAddress: string, homeAddress: string): boolean {
  const home = normalizeAddress(homeAddress);
  if (!home || home.length < MIN_SUBSTRING_MATCH_LENGTH) return false;

  const visit = normalizeAddress(visitAddress);
  if (!visit) return false;

  // 双向包含：住址包含 visit 或 visit 包含住址
  if (home.includes(visit) || visit.includes(home)) return true;

  // 地址中常插入门牌号、楼栋号等，导致双向包含失败。
  // 使用最长公共子序列（LCS）兜底：若 home 的字符有较高比例保持顺序出现在 visit 中，则视为同一地点。
  const lcsLength = longestCommonSubsequenceLength(home, visit);
  return lcsLength >= home.length * LCS_MATCH_RATIO;
}

export async function loadUserHomeAddresses(userIds: string[]): Promise<Map<string, HomeAddressInfo>> {
  const map = new Map<string, HomeAddressInfo>();
  if (userIds.length === 0) return map;

  const result = await pool.query(
    `SELECT user_id, home_address, home_lat, home_lng FROM users WHERE user_id = ANY($1)`,
    [userIds]
  );
  for (const row of result.rows) {
    if (row.home_address) {
      map.set(row.user_id, {
        address: row.home_address,
        lat: row.home_lat ?? null,
        lng: row.home_lng ?? null,
      });
    }
  }
  return map;
}

/** 加载公司地址白名单（名称 + 地址 + 坐标） */
export async function loadCompanyAddresses(): Promise<CompanyAddress[]> {
  const result = await pool.query(
    `SELECT name, address, lat, lng FROM company_addresses`
  );
  return result.rows.map((row) => ({
    name: row.name,
    address: row.address,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
  }));
}

/** 加载全部员工的住址（跨员工匹配：任何员工的家都不算客户，用于个人维度报告） */
export async function loadAllHomeAddresses(): Promise<Map<string, HomeAddressInfo>> {
  const result = await pool.query(
    `SELECT user_id, home_address, home_lat, home_lng FROM users
     WHERE home_address IS NOT NULL AND home_address <> ''`
  );
  const map = new Map<string, HomeAddressInfo>();
  for (const row of result.rows) {
    map.set(row.user_id, {
      address: row.home_address,
      lat: row.home_lat ?? null,
      lng: row.home_lng ?? null,
    });
  }
  return map;
}

async function geocodeHomeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!address) return null;

  const cached = geocodeCache.get(address);
  if (cached !== undefined) return cached;

  const inProgress = geocodeInProgress.get(address);
  if (inProgress) return inProgress;

  const promise = geocodeAddress(address)
    .then((coords) => {
      // 只缓存成功结果；失败（限流/抖动/解析不出）不缓存，下次调用可重试
      if (coords) {
        geocodeCache.set(address, coords);
      }
      geocodeInProgress.delete(address);
      return coords;
    })
    .catch((err) => {
      console.warn("Geocode home address failed:", address, err);
      geocodeInProgress.delete(address);
      return null;
    });

  geocodeInProgress.set(address, promise);
  return promise;
}

function isWithinRadius(
  visit: Visit,
  homeCoords: { lat: number; lng: number }
): boolean {
  if (visit.lat == null || visit.lng == null) return false;
  const distanceKm = haversineDistance(visit.lat, visit.lng, homeCoords.lat, homeCoords.lng);
  return distanceKm <= HOME_RADIUS_KM;
}

/**
 * 判断一次 visit 是否命中员工住址白名单。
 * 策略：先文本匹配（子串 + LCS，适合范围/文字型地址），未命中再走坐标半径——
 * 优先使用导入时持久化的 home_lat/home_lng；缺失时才实时地理编码兜底。
 */
export async function isHomeAddress(
  visit: Visit,
  home: HomeAddressInfo
): Promise<boolean> {
  if (!home || !home.address || !home.address.trim()) return false;

  if (matchHomeTextAndStoredCoords(visit, home)) return true;

  // 文本和持久化坐标都未命中：仅在缺坐标时实时地理编码兜底
  if (home.lat == null || home.lng == null) {
    const homeCoords = await geocodeHomeAddress(home.address);
    if (homeCoords) {
      return isWithinRadius(visit, homeCoords);
    }
  }

  return false;
}

/** 同步匹配：文本 + 持久化坐标（不做实时地理编码，适合批量跨员工匹配） */
function matchHomeTextAndStoredCoords(visit: Visit, home: HomeAddressInfo): boolean {
  const textToCheck = [visit.address, visit.location_name].filter(Boolean) as string[];
  for (const text of textToCheck) {
    if (hasSubstringMatch(text, home.address)) {
      return true;
    }
  }
  if (home.lat != null && home.lng != null) {
    return isWithinRadius(visit, { lat: home.lat, lng: home.lng });
  }
  return false;
}

/**
 * 判断一次 visit 是否命中公司地址白名单（对全体员工生效）。
 * 文本匹配公司名/地址，或坐标落在半径内。
 */
export function isCompanyAddress(visit: Visit, companies: CompanyAddress[]): boolean {
  if (companies.length === 0) return false;
  const textToCheck = [visit.address, visit.location_name].filter(Boolean) as string[];

  for (const company of companies) {
    for (const text of textToCheck) {
      if (hasSubstringMatch(text, company.address)) return true;
      // 公司名通常更短（如「创维数字大厦」），直接做包含判断
      const name = normalizeAddress(company.name);
      if (name.length >= 4 && normalizeAddress(text).includes(name)) return true;
    }
    if (company.lat != null && company.lng != null) {
      if (isWithinRadius(visit, { lat: company.lat, lng: company.lng })) return true;
    }
  }
  return false;
}

/**
 * 批量判断一组 visit 是否命中员工住址白名单。
 * 任何员工的家都不算客户：先匹配拜访人自己的住址（含实时地理编码兜底），
 * 未命中再同步匹配其他员工的住址（仅文本 + 已持久化坐标，不触发实时解析）。
 * 用于重复签到检测前快速过滤。
 */
export async function batchFilterHomeVisits(
  visits: Visit[],
  homeAddressMap: Map<string, HomeAddressInfo>
): Promise<Set<number>> {
  const homeVisitIds = new Set<number>();
  const allHomes = [...homeAddressMap.values()];

  await Promise.all(
    visits.map(async (visit) => {
      const ownHome = homeAddressMap.get(visit.user_id);
      if (ownHome && (await isHomeAddress(visit, ownHome))) {
        homeVisitIds.add(visit.id);
        return;
      }
      // 跨员工匹配：例如出差留宿在同事家小区，同样不应计入客户
      for (const home of allHomes) {
        if (home === ownHome) continue;
        if (matchHomeTextAndStoredCoords(visit, home)) {
          homeVisitIds.add(visit.id);
          return;
        }
      }
    })
  );

  return homeVisitIds;
}

/**
 * 批量判断一组 visit 是否命中公司地址白名单（对全体员工生效）。
 * 报告客户统计中应排除公司签到。
 */
export function batchFilterCompanyVisits(
  visits: Visit[],
  companies: CompanyAddress[]
): Set<number> {
  const companyVisitIds = new Set<number>();
  if (companies.length === 0) return companyVisitIds;

  for (const visit of visits) {
    if (isCompanyAddress(visit, companies)) {
      companyVisitIds.add(visit.id);
    }
  }
  return companyVisitIds;
}

export function clearAddressWhitelistCache(): void {
  geocodeCache.clear();
}
