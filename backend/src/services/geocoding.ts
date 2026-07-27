import { pool } from "../db";

const AMAP_KEY = process.env.AMAP_KEY || "";

export interface GeoResult {
  lat: number;
  lng: number;
}

export async function geocodeAddress(address: string): Promise<GeoResult | null> {
  if (AMAP_KEY && AMAP_KEY !== "YOUR_AMAP_KEY") {
    const gaode = await geocodeWithGaode(address);
    if (gaode) return gaode;
  }
  // 高德不可用或失败时，查询人工维护的兜底地址表
  return geocodeWithFallback(address);
}

/**
 * 带回退简化的地理编码：完整地址解析失败时，逐级截掉楼栋/单元/室等尾缀重试。
 * 适合住址这类包含「幢/单元/室」细节、高德常常解析不出的长地址。
 * 返回坐标及实际命中所用的地址串（便于人工核对精度）。
 */
export async function geocodeAddressWithSimplification(
  address: string
): Promise<{ coords: GeoResult; usedAddress: string } | null> {
  const candidates = buildSimplifiedCandidates(address);
  for (const candidate of candidates) {
    const coords = await geocodeAddress(candidate);
    if (coords) {
      return { coords, usedAddress: candidate };
    }
  }
  return null;
}

/** 生成地址候选：完整地址 + 逐级截短（去掉 幢/栋/单元/室/号楼 及其后内容） */
function buildSimplifiedCandidates(address: string): string[] {
  const candidates: string[] = [];
  let current = address.trim();
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    candidates.push(current);
    // 截掉最后一个「数字+幢/栋/单元/室/号楼」及其后内容，如 44幢2301室、57栋、19号楼一单元602
    const next = current
      .replace(/[\d０-９一二三四五六七八九十]+\s*(幢|栋|单元|室|号楼)[^幢栋单元室号楼]*$/u, "")
      .replace(/[-—\s,，]+$/g, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return candidates;
}

/**
 * 批量地理编码：对地址去重后统一解析，返回地址到坐标的映射。
 * 失败的地址会尝试查询兜底地址表，仍失败则映射为 null（不再写入 0,0）。
 */
export async function batchGeocode(addresses: string[]): Promise<Map<string, GeoResult | null>> {
  const uniqueAddresses = Array.from(new Set(addresses.filter((a) => !!a)));
  const result = new Map<string, GeoResult | null>();

  for (const address of uniqueAddresses) {
    let coords = await geocodeWithGaode(address);
    if (!coords) {
      coords = await geocodeWithFallback(address);
    }
    result.set(address, coords);
  }

  return result;
}

async function geocodeWithGaode(address: string): Promise<GeoResult | null> {
  if (!AMAP_KEY || AMAP_KEY === "YOUR_AMAP_KEY") return null;
  try {
    const url =
      `https://restapi.amap.com/v3/geocode/geo?` +
      `address=${encodeURIComponent(address)}&key=${AMAP_KEY}`;
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.status === "1" && data.geocodes?.length > 0) {
      const location = data.geocodes[0].location;
      const [lng, lat] = location.split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  } catch (err) {
    console.warn("Gaode geocoding failed:", err);
  }
  return null;
}

/**
 * 查询人工维护的兜底地址坐标表。
 * 只有在表中明确存在时才返回坐标，避免用城市中心近似坐标污染分析。
 */
async function geocodeWithFallback(address: string): Promise<GeoResult | null> {
  if (!address) return null;
  try {
    const result = await pool.query(
      `SELECT lat, lng FROM address_fallback_coordinates WHERE address = $1 LIMIT 1`,
      [address.trim()]
    );
    if (result.rows.length > 0) {
      const { lat, lng } = result.rows[0];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  } catch (err) {
    console.warn("Fallback geocoding query failed:", err);
  }
  return null;
}
