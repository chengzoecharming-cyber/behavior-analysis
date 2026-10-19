import { useEffect, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import type { CrmOpportunityItem } from "../../types";

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "YOUR_AMAP_KEY";

interface CustomerMapProps {
  /** 客户点位（lat/lng 为 null 的会被跳过） */
  items: CrmOpportunityItem[];
  height?: number;
}

/**
 * 客户机会地图：客户打点（私海蓝 / 公海橙），有拜访记录的画大气泡。
 * 与 MapContainer（轨迹回放）职责不同，仅做静态点位展示。
 */
export default function CustomerMap({ items, height = 480 }: CustomerMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    AMapLoader.load({
      key: AMAP_KEY,
      version: "2.0",
      plugins: ["AMap.ToolBar", "AMap.Scale"],
    })
      .then((AMap: any) => {
        const map = new AMap.Map(mapRef.current, {
          zoom: 5,
          center: [112.5, 30.5],
        });
        map.addControl(new AMap.ToolBar());
        map.addControl(new AMap.Scale());
        mapInstance.current = map;
        setLoaded(true);
      })
      .catch((err: any) => {
        console.error("AMap load failed:", err);
        setLoadError(true);
      });

    return () => {
      mapInstance.current?.destroy();
      mapInstance.current = null;
    };
  }, []);

  // 容器尺寸变化（Sidebar 折叠/展开、窗口 resize）时通知地图实例自适应
  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const observer = new ResizeObserver(() => {
      mapInstance.current?.resize();
    });
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, [loaded]);

  useEffect(() => {
    if (!mapInstance.current || !loaded) return;
    const AMap = (window as any).AMap;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    infoWindowRef.current?.close();

    const pts = items.filter((it) => it.lat != null && it.lng != null);
    if (pts.length === 0) return;

    pts.forEach((it) => {
      const hasVisit = it.visit_count > 0;
      // 私海蓝色 / 公海橙色；有拜访的半径按拜访次数放大
      const color = it.is_in_pool ? "#fa8c16" : "#1677ff";
      const radius = hasVisit
        ? Math.min(10 + it.visit_count * 2, 28)
        : 7;

      const marker = new AMap.CircleMarker({
        center: [it.lng, it.lat],
        radius,
        fillColor: color,
        fillOpacity: hasVisit ? 0.65 : 0.55,
        strokeColor: "#fff",
        strokeWeight: 1.5,
        zIndex: hasVisit ? 110 : 100,
        cursor: "pointer",
      });
      marker.on("click", () => {
        infoWindowRef.current?.close();
        const info = new AMap.InfoWindow({
          offset: new AMap.Pixel(0, -radius - 4),
          content: `
            <div style="padding:4px 2px;font-size:13px;max-width:260px">
              <div style="font-weight:600;margin-bottom:4px">${it.name}</div>
              <div style="color:#666">${it.address}</div>
              <div style="margin-top:4px;color:#666">
                ${it.is_in_pool ? "公海" : "私海"}
                ${it.owner_name ? ` · 负责人：${it.owner_name}` : ""}
                ${it.follow_status ? ` · ${it.follow_status}` : ""}
              </div>
              <div style="margin-top:2px;color:#666">拜访次数：${it.visit_count}</div>
            </div>`,
        });
        info.open(mapInstance.current, [it.lng, it.lat]);
        infoWindowRef.current = info;
      });
      marker.setMap(mapInstance.current);
      markersRef.current.push(marker);
    });

    mapInstance.current.setFitView();
  }, [items, loaded]);

  return (
    <div
      style={{
        width: "100%",
        height,
        borderRadius: 8,
        background: "#e5e5e5",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div ref={mapRef} style={{ width: "100%", height: "100%", borderRadius: 8 }} />
      {!loaded && !loadError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#e5e5e5",
            borderRadius: 8,
          }}
        >
          地图加载中，请配置高德地图 Key 后刷新…
        </div>
      )}
      {loadError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#fff2f0",
            color: "#cf1322",
            borderRadius: 8,
            padding: 24,
            textAlign: "center",
          }}
        >
          地图加载失败，请检查高德地图 Key 是否配置正确
        </div>
      )}
    </div>
  );
}
