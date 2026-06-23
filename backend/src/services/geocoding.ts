const AMAP_KEY = process.env.AMAP_KEY || "";

interface GeoResult {
  lat: number;
  lng: number;
}

// 城市级近似坐标表（demo 用，无需精确）
const CITY_COORDS: Record<string, GeoResult> = {
  深圳: { lat: 22.5431, lng: 114.0579 },
  广州: { lat: 23.1291, lng: 113.2644 },
  东莞: { lat: 23.0207, lng: 113.7518 },
  惠州: { lat: 23.1107, lng: 114.4168 },
  珠海: { lat: 22.2707, lng: 113.5767 },
  上海: { lat: 31.2304, lng: 121.4737 },
  苏州: { lat: 31.2989, lng: 120.5853 },
  昆山: { lat: 31.3856, lng: 120.9807 },
  宁波: { lat: 29.8750, lng: 121.5500 },
  台州: { lat: 28.6564, lng: 121.4208 },
  温州: { lat: 27.9943, lng: 120.6994 },
  杭州: { lat: 30.2741, lng: 120.1551 },
  嘉兴: { lat: 30.7461, lng: 120.7555 },
  海宁: { lat: 30.5111, lng: 120.6812 },
  南京: { lat: 32.0603, lng: 118.7969 },
  无锡: { lat: 31.4912, lng: 120.3119 },
  济南: { lat: 36.6510, lng: 117.1205 },
  莱芜: { lat: 36.2144, lng: 117.6780 },
  青岛: { lat: 36.0671, lng: 120.3826 },
  天津: { lat: 39.0842, lng: 117.2008 },
  北京: { lat: 39.9042, lng: 116.4074 },
  郑州: { lat: 34.7466, lng: 113.6253 },
  洛阳: { lat: 34.6587, lng: 112.4343 },
  肇庆: { lat: 23.0469, lng: 112.4653 },
  济宁: { lat: 35.4151, lng: 116.3974 },
  长沙: { lat: 28.2280, lng: 112.9388 },
  武汉: { lat: 30.5928, lng: 114.3055 },
  成都: { lat: 30.5728, lng: 104.0668 },
  西安: { lat: 34.3416, lng: 108.9398 },
  // 区县
  宝安: { lat: 22.5533, lng: 113.8831 },
  龙岗: { lat: 22.7209, lng: 114.2478 },
  浦东: { lat: 31.2214, lng: 121.5444 },
  松江: { lat: 31.0322, lng: 121.2288 },
  塘厦: { lat: 22.8107, lng: 114.1034 },
  长安: { lat: 22.8163, lng: 113.8031 },
  石岩: { lat: 22.6774, lng: 113.9411 },
  即墨: { lat: 36.3904, lng: 120.4473 },
  惠山: { lat: 31.2960, lng: 120.2960 },
  涧西: { lat: 34.6582, lng: 112.3957 },
  中原: { lat: 34.7484, lng: 113.6129 },
  宁海: { lat: 29.2880, lng: 121.4295 },
  // 省份兜底
  广东: { lat: 23.1291, lng: 113.2644 },
  江苏: { lat: 32.0603, lng: 118.7969 },
  浙江: { lat: 30.2741, lng: 120.1551 },
  山东: { lat: 36.6758, lng: 117.0009 },
  河南: { lat: 34.7466, lng: 113.6253 },
  河北: { lat: 38.0423, lng: 114.5149 },
  湖南: { lat: 28.2282, lng: 112.9388 },
  湖北: { lat: 30.5931, lng: 114.3054 },
  福建: { lat: 26.0745, lng: 119.2965 },
  四川: { lat: 30.5723, lng: 104.0665 },
  安徽: { lat: 31.8612, lng: 117.2849 },
  江西: { lat: 28.6820, lng: 115.8579 },
  陕西: { lat: 34.3416, lng: 108.9398 },
};

export async function geocodeAddress(address: string): Promise<GeoResult | null> {
  // 优先尝试高德（如果有配置且平台匹配）
  if (AMAP_KEY && AMAP_KEY !== "YOUR_AMAP_KEY") {
    const gaode = await geocodeWithGaode(address);
    if (gaode) return gaode;

    // 高德失败后，回退到城市级坐标
    return geocodeWithCityFallback(address);
  }

  // 没有高德 Key：直接用城市级近似坐标，避免 Nominatim 长时间超时
  return geocodeWithCityFallback(address);
}

async function geocodeWithGaode(address: string): Promise<GeoResult | null> {
  try {
    const url =
      `https://restapi.amap.com/v3/geocode/geo?` +
      `address=${encodeURIComponent(address)}&key=${AMAP_KEY}`;
    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.status === "1" && data.geocodes?.length > 0) {
      const location = data.geocodes[0].location;
      const [lng, lat] = location.split(",").map(Number);
      return { lat, lng };
    }
  } catch (err) {
    console.warn("Gaode geocoding failed:", err);
  }
  return null;
}

function geocodeWithCityFallback(address: string): GeoResult | null {
  if (!address) return null;
  for (const [name, coords] of Object.entries(CITY_COORDS)) {
    if (name.length >= 2 && address.includes(name)) {
      // 加一点随机偏移，避免同城市点完全重叠
      const jitter = 0.04;
      return {
        lat: coords.lat + (Math.random() - 0.5) * jitter,
        lng: coords.lng + (Math.random() - 0.5) * jitter,
      };
    }
  }
  return null;
}
