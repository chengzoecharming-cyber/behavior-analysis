import { useEffect, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import { Visit, Stop, Route, Anomaly } from "../types";
import dayjs from "dayjs";
import { Card, Descriptions } from "antd";

interface MapContainerProps {
  visits: Visit[];
  stops: Stop[];
  routes: Route[];
  anomalies?: Anomaly[];
  playing: boolean;
  progress: number;
  onProgressChange: (value: number) => void;
}

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "YOUR_AMAP_KEY";

export default function MapContainer({
  visits,
  stops,
  routes,
  anomalies = [],
  playing,
  progress,
  onProgressChange,
}: MapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markers = useRef<any[]>([]);
  const polylines = useRef<any[]>([]);
  const movingMarker = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<Visit | null>(null);

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
    const AMap = window.AMap;

    markers.current.forEach((m) => m.setMap(null));
    polylines.current.forEach((p) => p.setMap(null));
    markers.current = [];
    polylines.current = [];
    if (movingMarker.current) {
      movingMarker.current.stopMove();
      movingMarker.current.setMap(null);
      movingMarker.current = null;
    }
    setSelectedVisit(null);

    if (visits.length === 0) return;

    const path = visits.map((v) => [v.lng, v.lat]);

    routes.forEach((r) => {
      const pts = r.polyline.split(";").map((pt) => {
        const [lng, lat] = pt.split(",").map(Number);
        return [lng, lat];
      });
      const polyline = new AMap.Polyline({
        path: pts,
        strokeColor: "#1890ff",
        strokeWeight: 5,
        strokeOpacity: 0.8,
        showDir: true,
      });
      polyline.setMap(mapInstance.current);
      polylines.current.push(polyline);
    });

    if (routes.length === 0) {
      const straightLine = new AMap.Polyline({
        path,
        strokeColor: "#999",
        strokeWeight: 3,
        strokeDasharray: [5, 5],
      });
      straightLine.setMap(mapInstance.current);
      polylines.current.push(straightLine);
    }

    visits.forEach((v, idx) => {
      const marker = new AMap.Marker({
        position: [v.lng, v.lat],
        title: `${dayjs(v.timestamp).format("HH:mm")} ${v.location_name}`,
        label: {
          content: `<div style="font-size:12px;background:#fff;padding:2px 6px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.2)">${dayjs(
            v.timestamp
          ).format("HH:mm")}</div>`,
          offset: new AMap.Pixel(0, -28),
          direction: "top",
        },
        icon:
          idx === 0
            ? "https://webapi.amap.com/theme/v1.3/markers/n/start.png"
            : undefined,
      });
      marker.on("click", () => {
        setSelectedVisit(v);
      });
      marker.setMap(mapInstance.current);
      markers.current.push(marker);
    });

    stops.forEach((s) => {
      const circle = new AMap.CircleMarker({
        center: [s.lng, s.lat],
        radius: 16,
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
          padding: "2px 6px",
          borderRadius: "4px",
          fontSize: "12px",
        },
        offset: new AMap.Pixel(0, -24),
      });
      label.setMap(mapInstance.current);
      markers.current.push(label);
    });

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

    mapInstance.current.setFitView();

    movingMarker.current = new AMap.Marker({
      position: path[0],
      icon: "https://webapi.amap.com/images/car.png",
      offset: new AMap.Pixel(-13, -13),
      autoRotation: true,
    });
    movingMarker.current.setMap(mapInstance.current);
  }, [visits, stops, routes, anomalies, loaded]);

  useEffect(() => {
    if (!movingMarker.current || visits.length === 0) return;
    const path = visits.map((v) => [v.lng, v.lat]);
    const totalDuration = 10000;
    const segmentDuration = totalDuration / Math.max(1, path.length - 1);
    const currentIndex = Math.min(Math.floor(progress), path.length - 1);
    const nextIndex = Math.min(currentIndex + 1, path.length - 1);
    const ratio = progress - currentIndex;

    const start = path[currentIndex];
    const end = path[nextIndex];
    const lng = start[0] + (end[0] - start[0]) * ratio;
    const lat = start[1] + (end[1] - start[1]) * ratio;
    movingMarker.current.setPosition([lng, lat]);

    if (playing) {
      movingMarker.current.moveAlong(path, {
        duration: segmentDuration,
        autoRotation: true,
      });
      const timeout = setTimeout(() => {
        if (progress < path.length - 1) {
          onProgressChange(progress + 1);
        } else {
          onProgressChange(0);
        }
      }, segmentDuration);
      return () => clearTimeout(timeout);
    } else {
      movingMarker.current.pauseMove();
    }
  }, [playing, progress, visits, onProgressChange]);

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
