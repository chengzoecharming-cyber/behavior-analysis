import { useEffect, useMemo, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import { Visit, Stop, Route, Anomaly } from "../types";
import dayjs from "dayjs";
import { Card, Descriptions } from "antd";

export interface RouteGroup {
  key: string;
  label?: string;
  color: string;
  routes: Route[];
  visits: Visit[];
}

interface MapContainerProps {
  visits?: Visit[];
  stops?: Stop[];
  routes?: Route[];
  routeGroups?: RouteGroup[];
  anomalies?: Anomaly[];
  progress?: number;
  progressMap?: Record<string, number>;
}

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "YOUR_AMAP_KEY";

function deduplicateVisits(visits: Visit[]): Visit[] {
  const seen = new Set<string>();
  return visits.filter((v) => {
    const key = v.approval_id
      ? `${v.user_id}|${v.approval_id}|${v.sequence ?? 0}`
      : `${v.user_id}|${v.timestamp}|${v.lat}|${v.lng}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getPassedPath(fullPath: [number, number][], progress: number): [number, number][] {
  if (fullPath.length === 0) return [];
  if (progress <= 0) return [fullPath[0]];
  if (progress >= 1) return fullPath;

  const targetIndex = progress * (fullPath.length - 1);
  const currentIndex = Math.floor(targetIndex);
  const ratio = targetIndex - currentIndex;
  const start = fullPath[currentIndex];
  const end = fullPath[Math.min(currentIndex + 1, fullPath.length - 1)];
  const currentPos: [number, number] = [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
  return [...fullPath.slice(0, currentIndex + 1), currentPos];
}

function sortVisits(visits: Visit[]): Visit[] {
  return [...visits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

function buildRoutePath(routes: Route[]): [number, number][] {
  let fullPath: [number, number][] = [];
  routes.forEach((r, idx) => {
    const pts = r.polyline.split(";").map((pt) => {
      const [lng, lat] = pt.split(",").map(Number);
      return [lng, lat] as [number, number];
    });
    if (idx === 0) {
      fullPath = pts;
    } else {
      const last = fullPath[fullPath.length - 1];
      const first = pts[0];
      if (last && first && last[0] === first[0] && last[1] === first[1]) {
        fullPath.push(...pts.slice(1));
      } else {
        fullPath.push(...pts);
      }
    }
  });
  return fullPath;
}

function getMarkerContent(label: string, bgColor: string, textColor = "#fff") {
  return `<div style="width:20px;height:20px;border-radius:50%;background:${bgColor};color:${textColor};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)">${label}</div>`;
}

export default function MapContainer({
  visits = [],
  stops = [],
  routes = [],
  routeGroups,
  anomalies = [],
  progress = 1,
  progressMap,
}: MapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markers = useRef<any[]>([]);
  const polylines = useRef<any[]>([]);
  const coloredLinesRef = useRef<Record<string, any>>({});
  const fullPathMap = useRef<Record<string, [number, number][]>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<Visit | null>(null);

  const { displayGroups, activeProgressMap } = useMemo(() => {
    const multi = routeGroups && routeGroups.length > 0;
    return {
      displayGroups: multi
        ? routeGroups!
        : [{ key: "__SINGLE__", color: "#1890ff", routes, visits }],
      activeProgressMap: multi ? progressMap ?? {} : { __SINGLE__: progress },
    };
  }, [routeGroups, routes, visits, progressMap, progress]);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    AMapLoader.load({
      key: AMAP_KEY,
      version: "2.0",
      plugins: ["AMap.ToolBar", "AMap.Scale"],
    })
      .then((AMap: any) => {
        const map = new AMap.Map(mapRef.current, {
          zoom: 12,
          center: [116.397428, 39.90923],
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

  useEffect(() => {
    if (!mapInstance.current || !loaded) return;
    const AMap = (window as any).AMap;

    markers.current.forEach((m) => m.setMap(null));
    polylines.current.forEach((p) => p.setMap(null));
    markers.current = [];
    polylines.current = [];
    coloredLinesRef.current = {};
    fullPathMap.current = {};
    setSelectedVisit(null);

    const allVisits: Visit[] = [];
    const visitIds = new Set<number>();

    displayGroups.forEach((group) => {
      const uniqueVisits = deduplicateVisits(group.visits).filter(
        (v) => v.lat != null && v.lng != null && (v.lat !== 0 || v.lng !== 0)
      );

      uniqueVisits.forEach((v) => {
        if (!visitIds.has(v.id)) {
          visitIds.add(v.id);
          allVisits.push(v);
        }
      });

      // 构建轨迹路径
      let path: [number, number][] = [];
      if (group.routes.length > 0) {
        path = buildRoutePath(group.routes);
      } else if (uniqueVisits.length > 1) {
        path = uniqueVisits.map((v) => [v.lng, v.lat] as [number, number]);
      }
      fullPathMap.current[group.key] = path;

      const currentProgress = activeProgressMap[group.key] ?? 1;

      if (path.length > 0) {
        // 灰色底线
        const grayLine = new AMap.Polyline({
          path,
          strokeColor: "#d9d9d9",
          strokeWeight: 4,
          strokeOpacity: 0.8,
        });
        grayLine.setMap(mapInstance.current);
        polylines.current.push(grayLine);

        // 彩色已走过路线
        const initialPath = getPassedPath(path, currentProgress);
        const colorLine = new AMap.Polyline({
          path: initialPath,
          strokeColor: group.color,
          strokeWeight: 5,
          strokeOpacity: 0.9,
          showDir: true,
        });
        colorLine.setMap(mapInstance.current);
        polylines.current.push(colorLine);
        coloredLinesRef.current[group.key] = colorLine;
      }

      // 标记点：起 / 终 / 途N
      const sorted = sortVisits(uniqueVisits);
      sorted.forEach((v, idx) => {
        const isStart = idx === 0;
        const isEnd = idx === sorted.length - 1;
        let label: string;
        let bgColor: string;

        if (isStart) {
          label = "起";
          bgColor = "#52c41a";
        } else if (isEnd) {
          label = "终";
          bgColor = "#ff4d4f";
        } else {
          label = `途${idx}`;
          bgColor = "#1890ff";
        }

        const marker = new AMap.Marker({
          position: [v.lng, v.lat],
          title: `${dayjs(v.timestamp).format("HH:mm")} ${v.location_name}`,
          content: getMarkerContent(label, bgColor),
          offset: new AMap.Pixel(-10, -10),
        });
        marker.on("click", () => setSelectedVisit(v));
        marker.setMap(mapInstance.current);
        markers.current.push(marker);
      });
    });

    // 停留点（只绘制一次）
    stops.forEach((s) => {
      const circle = new AMap.CircleMarker({
        center: [s.lng, s.lat],
        radius: 10,
        fillColor: "#ff4d4f",
        strokeColor: "#ff4d4f",
        fillOpacity: 0.6,
      });
      circle.setMap(mapInstance.current);
      markers.current.push(circle);

      const label = new AMap.Text({
        text: `${s.duration_minutes}分`,
        position: [s.lng, s.lat],
        style: {
          backgroundColor: "#ff4d4f",
          color: "#fff",
          padding: "1px 4px",
          borderRadius: "4px",
          fontSize: "10px",
        },
        offset: new AMap.Pixel(0, -18),
      });
      label.setMap(mapInstance.current);
      markers.current.push(label);
    });

    // 异常标记
    anomalies.forEach((a) => {
      if (a.lat == null || a.lng == null) return;
      const marker = new AMap.Marker({
        position: [a.lng, a.lat],
        title: a.description,
        icon: "https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png",
      });
      marker.setMap(mapInstance.current);
      markers.current.push(marker);
    });

    if (allVisits.length > 0) {
      mapInstance.current.setFitView();
    }
  }, [visits, stops, routes, routeGroups, anomalies, loaded]);

  useEffect(() => {
    if (!loaded) return;
    Object.entries(coloredLinesRef.current).forEach(([key, line]) => {
      const fullPath = fullPathMap.current[key];
      const p = activeProgressMap[key] ?? 1;
      if (fullPath && line) {
        line.setPath(getPassedPath(fullPath, p));
      }
    });
  }, [progress, progressMap, loaded, activeProgressMap]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 8,
        background: "#e5e5e5",
        position: "relative",
      }}
    >
      <div
        ref={mapRef}
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 8,
        }}
      />
      {!loaded && !loadError && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
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
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
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
      {selectedVisit && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            width: 320,
            zIndex: 10,
          }}
        >
          <Card
            title="拜访详情"
            size="small"
            extra={
              <button
                onClick={() => setSelectedVisit(null)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 16,
                  color: "#999",
                }}
              >
                ✕
              </button>
            }
            styles={{ body: { padding: 12 } }}
          >
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="员工姓名">
                {selectedVisit.user_name}
              </Descriptions.Item>
              <Descriptions.Item label="部门">
                {selectedVisit.department}
              </Descriptions.Item>
              <Descriptions.Item label="拜访时间">
                {dayjs(selectedVisit.timestamp).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="客户名称">
                {selectedVisit.customer_name}
              </Descriptions.Item>
              <Descriptions.Item label="地点名称">
                {selectedVisit.location_name}
              </Descriptions.Item>
              <Descriptions.Item label="详细地址">
                {selectedVisit.address}
              </Descriptions.Item>
              <Descriptions.Item label="数据来源">
                {selectedVisit.source}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </div>
      )}
    </div>
  );
}
