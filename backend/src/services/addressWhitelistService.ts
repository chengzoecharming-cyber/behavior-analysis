import { pool } from "../db";
import { Visit } from "../types";
import { geocodeAddress } from "./geocoding";
import { haversineDistance } from "./distance";

const HOME_RADIUS_KM = 0.5; // 半径兜底：500 米
const MIN_SUBSTRING_MATCH_LENGTH = 8; // 子串匹配最小长度（去除空格后）
const LCS_MATCH_RATIO = 0.8; // 最长公共子序列占 home 长度的比例阈值

// 地理编码结果缓存（避免同一检测周期内重复请求）
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();
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

export async function loadUserHomeAddresses(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;

  const result = await pool.query(
    `SELECT user_id, home_address FROM users WHERE user_id = ANY($1)`,
    [userIds]
  );
  for (const row of result.rows) {
    if (row.home_address) {
      map.set(row.user_id, row.home_address);
    }
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
      geocodeCache.set(address, coords);
      geocodeInProgress.delete(address);
      return coords;
    })
    .catch((err) => {
      console.warn("Geocode home address failed:", address, err);
      geocodeCache.set(address, null);
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
 * 策略：先子串匹配（适合范围/文字型地址），子串未命中再用地理编码 + 半径兜底。
 */
export async function isHomeAddress(
  visit: Visit,
  homeAddress: string
): Promise<boolean> {
  if (!homeAddress || !homeAddress.trim()) return false;

  const textToCheck = [visit.address, visit.location_name].filter(Boolean) as string[];
  for (const text of textToCheck) {
    if (hasSubstringMatch(text, homeAddress)) {
      return true;
    }
  }

  // 子串未命中，使用坐标半径兜底
  const homeCoords = await geocodeHomeAddress(homeAddress);
  if (homeCoords) {
    return isWithinRadius(visit, homeCoords);
  }

  return false;
}

/**
 * 批量判断一组 visit 是否命中各自员工的住址白名单。
 * 用于重复签到检测前快速过滤。
 */
export async function batchFilterHomeVisits(
  visits: Visit[],
  homeAddressMap: Map<string, string>
): Promise<Set<number>> {
  const homeVisitIds = new Set<number>();

  await Promise.all(
    visits.map(async (visit) => {
      const homeAddress = homeAddressMap.get(visit.user_id);
      if (!homeAddress) return;
      if (await isHomeAddress(visit, homeAddress)) {
        homeVisitIds.add(visit.id);
      }
    })
  );

  return homeVisitIds;
}

export function clearAddressWhitelistCache(): void {
  geocodeCache.clear();
}
