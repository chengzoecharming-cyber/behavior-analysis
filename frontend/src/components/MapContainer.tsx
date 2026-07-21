import { useEffect, useMemo, useRef, useState, ReactNode } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import { Visit, Stop, Route, Anomaly } from "../types";
import { formatBeijingHHmm, formatBeijingTime } from "../utils/time";
import { isMileageRequiredTrip } from "../utils/tripType";
import { Card, Descriptions, Button, Tag, Image } from "@douyinfe/semi-ui";

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

// 稳定的空数组，避免默认参数每次渲染都生成新引用
const EMPTY_VISITS: Visit[] = [];
const EMPTY_STOPS: Stop[] = [];
const EMPTY_ROUTES: Route[] = [];
const EMPTY_ANOMALIES: Anomaly[] = [];

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

function DescItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Descriptions.Item
      itemKey={label}
      keyStyle={{ fontSize: 14, color: "#999", fontWeight: 400, marginTop: 8, marginBottom: 8 }}
    >
      <span style={{ fontSize: 14, color: "#000", fontWeight: 400 }}>{children}</span>
    </Descriptions.Item>
  );
}

function getMarkerContent(
  label: string,
  bgColor: string,
  textColor = "#fff",
  opacity = 1,
  isPublicTransport = false
) {
  // 公共交通在标记上加一个小圆点标识
  const badge = isPublicTransport
    ? `<div style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;background:#fa8c16;border:1px solid #fff;"></div>`
    : "";
  return `<div style="position:relative;width:28px;height:28px;border-radius:50%;background:${bgColor};color:${textColor};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);opacity:${opacity}">${label}${badge}</div>`;
}

function isNonDrivingVisit(visit: Visit): boolean {
  return !isMileageRequiredTrip(visit.trip_type);
}

function isPublicTransportVisit(visit: Visit): boolean {
  return (visit.trip_type || "").includes("公共交通");
}

export default function MapContainer({
  visits = EMPTY_VISITS,
  stops = EMPTY_STOPS,
  routes = EMPTY_ROUTES,
  routeGroups,
  anomalies = EMPTY_ANOMALIES,
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

        // 非驾车段用紫色虚线叠加
        const visitMap = new Map(uniqueVisits.map((v) => [v.id, v]));
        group.routes.forEach((route) => {
          const from = visitMap.get(route.from_visit_id);
          const to = visitMap.get(route.to_visit_id);
          if (
            from &&
            to &&
            (!isMileageRequiredTrip(from.trip_type) ||
              !isMileageRequiredTrip(to.trip_type))
          ) {
            const segmentPath = route.polyline
              .split(";")
              .map((pt) => {
                const [lng, lat] = pt.split(",").map(Number);
                return [lng, lat] as [number, number];
              });
            const dashedLine = new AMap.Polyline({
              path: segmentPath,
              strokeColor: "#a855f7",
              strokeWeight: 5,
              strokeOpacity: 0.9,
              strokeStyle: "dashed",
              strokeDasharray: [6, 6],
              zIndex: 10,
            });
            dashedLine.setMap(mapInstance.current);
            polylines.current.push(dashedLine);
          }
        });
      }

      // 标记点：起 / 终 / 途N
      const sorted = sortVisits(uniqueVisits);
      const startVisit = sorted[0];
      const endVisit = sorted[sorted.length - 1];
      // 当起点与终点距离很近（<100m）或只有 1 个 visit 时，同时显示起、终
      const sameStartEnd = startVisit && endVisit;

      sorted.forEach((v, idx) => {
        const isPublic = isPublicTransportVisit(v);
        const isStart = idx === 0;
        const isEnd = idx === sorted.length - 1;
        const isRunningApproval = v.approval_status === "RUNNING";
        let label: string;
        let bgColor: string;

        if (isPublic) {
          label = "公";
          bgColor = "#722ed1";
        } else if (isStart) {
          label = "起";
          bgColor = "#52c41a";
        } else if (isEnd && !isRunningApproval) {
          // 审批已结束时，最后一个点才标"终"；RUNNING 时继续用"途n"
          label = "终";
          bgColor = "#ff4d4f";
        } else {
          label = `途${idx}`;
          bgColor = "#1890ff";
        }

        // 起、终（含 RUNNING 时的虚拟终点）标记设置一定透明度，重合时也能看到下方标记
        const opacity = !isPublic && (isStart || (isEnd && !isRunningApproval)) ? 0.85 : 1;
        // 终点在重合时位于更上层，保证"终"可见
        const zIndex =
          sameStartEnd && isEnd && !isPublic && !isRunningApproval
            ? 120
            : isStart && !isPublic
            ? 110
            : isEnd && !isPublic && !isRunningApproval
            ? 100
            : isPublic
            ? 130
            : 90;

        const markerTitle = v.special_sign_reason
          ? v.location_name || v.special_sign_reason
          : v.visit_note || v.location_name;
        const marker = new AMap.Marker({
          position: [v.lng, v.lat],
          title: `${formatBeijingHHmm(v.timestamp)} ${markerTitle}`,
          content: getMarkerContent(label, bgColor, "#fff", opacity, isPublic),
          offset: new AMap.Pixel(-14, -14),
          zIndex,
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
        radius: 14,
        fillColor: "#ff4d4f",
        strokeColor: "#ff4d4f",
        fillOpacity: 0.6,
        zIndex: 80,
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
        offset: new AMap.Pixel(0, -22),
        zIndex: 81,
      });
      label.setMap(mapInstance.current);
      markers.current.push(label);
    });

    // 异常事件只在左侧列表展示，不在地图上绘制标记

    if (allVisits.length > 0) {
      mapInstance.current.setFitView();
    }
  }, [visits, stops, routes, routeGroups, anomalies, loaded]);

  // 数据真正变化时，若当前选中的 visit 已不在当前所有轨迹分组里，则关闭详情面板
  useEffect(() => {
    if (!selectedVisit) return;
    const groups = routeGroups && routeGroups.length > 0 ? routeGroups : [{ visits }];
    const ids = new Set<number>();
    groups.forEach((g) => g.visits.forEach((v) => ids.add(v.id)));
    if (!ids.has(selectedVisit.id)) {
      setSelectedVisit(null);
    }
  }, [routeGroups, visits]);

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
            headerExtraContent={
              <Button
                theme="borderless"
                type="tertiary"
                onClick={() => setSelectedVisit(null)}
                style={{ color: "#999" }}
              >
                ✕
              </Button>
            }
            bodyStyle={{ padding: 12 }}
          >
            <Descriptions row size="small">
              <DescItem label="员工姓名">{selectedVisit.user_name}</DescItem>
              <DescItem label="部门">{selectedVisit.department}</DescItem>
              <DescItem label="拜访时间">
                {formatBeijingTime(selectedVisit.timestamp)}
              </DescItem>
              {selectedVisit.customer_name && (
                <DescItem label="客户名称">{selectedVisit.customer_name}</DescItem>
              )}
              {selectedVisit.visit_note && (
                <DescItem label="本次拜访情况">{selectedVisit.visit_note}</DescItem>
              )}
              {selectedVisit.special_sign_reason && (
                <>
                  {selectedVisit.location_name && selectedVisit.location_name !== "特殊签到点" && (
                    <DescItem label="打卡地">{selectedVisit.location_name}</DescItem>
                  )}
                  <DescItem label="特殊签到原因">
                    {selectedVisit.special_sign_reason}
                  </DescItem>
                </>
              )}
              <DescItem label="详细地址">{selectedVisit.address}</DescItem>
              {selectedVisit.photos && selectedVisit.photos.length > 0 && (
                <DescItem label="里程照片和拜访客户照片">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {selectedVisit.photos.map((url, idx) => (
                      <Image
                        key={idx}
                        src={url}
                        width={80}
                        height={80}
                        style={{ borderRadius: 4, objectFit: "cover" }}
                        preview
                      />
                    ))}
                  </div>
                </DescItem>
              )}
              {selectedVisit.trip_type && (
                <DescItem label="出行方式">
                  <Tag color={isNonDrivingVisit(selectedVisit) ? "purple" : "blue"}>
                    {selectedVisit.trip_type}
                  </Tag>
                </DescItem>
              )}
              {!isNonDrivingVisit(selectedVisit) &&
                selectedVisit.reported_distance_km !== undefined && (
                  <DescItem label="填报里程">
                    {selectedVisit.reported_distance_km} km
                  </DescItem>
                )}
              {!isNonDrivingVisit(selectedVisit) && selectedVisit.vehicle && (
                <DescItem label="交通工具">{selectedVisit.vehicle}</DescItem>
              )}
            </Descriptions>
          </Card>
        </div>
      )}
    </div>
  );
}
