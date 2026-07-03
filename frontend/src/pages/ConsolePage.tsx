import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Select,
  Row,
  Col,
  List,
  Tag,
  Tabs,
  TabPane,
  DatePicker,
} from "@douyinfe/semi-ui";
import { IconPlayCircle, IconPause, IconRedo } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import {
  fetchUsers,
  fetchAvailableDates,
  fetchVisits,
  fetchStops,
  fetchRoutes,
  fetchMileage,
  fetchAnomalies,
  fetchUserOverview,
  AvailableDate,
  UserOverviewResult,
  DailyOverview,
} from "../api";
import { User, Visit, Stop, Route, Anomaly, MileageStats } from "../types";
import MapContainer from "../components/MapContainer";
import HeatMapContainer from "../components/HeatMapContainer";
import { Suspense, lazy } from "react";

const OverviewChart = lazy(() => import("../components/OverviewChart"));

const MAX_MILEAGE_KM = parseFloat(import.meta.env.VITE_MILEAGE_MAX_KM || "5000");

const ROUTE_COLORS = [
  "#1890ff",
  "#fadb14",
  "#52c41a",
  "#fa8c16",
  "#722ed1",
  "#eb2f96",
  "#13c2c2",
  "#f5222d",
];

interface ApprovalGroup {
  key: string;
  label: string;
  visits: Visit[];
  routes: Route[];
  stops: Stop[];
  anomalies: Anomaly[];
  mileage: MileageStats;
}

const statStyle: React.CSSProperties = {
  padding: 20,
  backgroundColor: "#fff",
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const statLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#72808a",
  fontWeight: 500,
};

const statValueStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#0f1419",
};

function getDefaultOverviewRange(): [string, string] {
  const today = dayjs.tz();
  const start = today.startOf("month").format("YYYY-MM-DD");
  let end = today.subtract(1, "day").format("YYYY-MM-DD");
  if (end < start) {
    end = start;
  }
  return [start, end];
}

function fillDailyRange(
  daily: DailyOverview[],
  start: string,
  end: string
): DailyOverview[] {
  const map = new Map(daily.map((d) => [d.date, d]));
  const result: DailyOverview[] = [];
  const s = dayjs.tz(start);
  const e = dayjs.tz(end);
  for (let d = s; d.isBefore(e) || d.isSame(e); d = d.add(1, "day")) {
    const ds = d.format("YYYY-MM-DD");
    result.push(
      map.get(ds) ?? {
        date: ds,
        visit_count: 0,
        stop_minutes: 0,
        reported_distance_km: 0,
        estimated_distance_km: 0,
        anomaly_count: 0,
      }
    );
  }
  return result;
}

function ConsolePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string>();
  const [viewMode, setViewMode] = useState<"calendar" | "overview">("calendar");
  const [availableDateInfos, setAvailableDateInfos] = useState<AvailableDate[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [mileage, setMileage] = useState<MileageStats | null>(null);
  const [routeProgressMap, setRouteProgressMap] = useState<Record<string, number>>({});
  const [playingRoutes, setPlayingRoutes] = useState<Set<string>>(new Set());

  // 周期总览状态
  const [overviewRange, setOverviewRange] = useState<[string, string]>(() =>
    getDefaultOverviewRange()
  );
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewData, setOverviewData] = useState<UserOverviewResult | null>(null);
  const [overviewVisits, setOverviewVisits] = useState<Visit[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchUsers().then((data) => {
      if (!cancelled) setUsers(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const userFromUrl = searchParams.get("user");
    const dateFromUrl = searchParams.get("date");
    if (userFromUrl) setUserId(userFromUrl);
    if (dateFromUrl) {
      setSelectedDate(dateFromUrl);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!userId) {
      setAvailableDateInfos([]);
      return;
    }
    fetchAvailableDates(userId, true).then((infos) => {
      setAvailableDateInfos(infos);
      if (infos.length === 0) {
        setSelectedDate(null);
        return;
      }
      // 若当前选中日期不在列表中，默认选最近一天
      const dateExists = infos.some((info) => info.date === selectedDate);
      const targetDate = dateExists
        ? selectedDate!
        : infos[0].date;
      setSelectedDate(targetDate);
      const params = new URLSearchParams(searchParams);
      params.set("date", targetDate);
      setSearchParams(params);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 选中用户或日期变化时自动加载当日数据
  useEffect(() => {
    if (!userId || !selectedDate) return;
    loadDataFor(userId, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, selectedDate]);

  const loadDataFor = async (targetUserId: string, targetDate: string) => {
    try {
      const dateStr = targetDate;
      const start = `${dateStr}T00:00:00`;
      const end = `${dateStr}T23:59:59`;
      const [v, s, r, m, a] = await Promise.all([
        fetchVisits(targetUserId, start, end),
        fetchStops(targetUserId, start, end),
        fetchRoutes(targetUserId, start, end),
        fetchMileage(targetUserId, start, end),
        fetchAnomalies(targetUserId, start, end),
      ]);
      setVisits(v);
      setStops(s);
      setRoutes(r);
      setMileage(m);
      setAnomalies(a);
    } catch (err) {
      console.error("Failed to load console data:", err);
    }
  };

  const loadOverview = async (targetUserId: string, start: string, end: string) => {
    setOverviewLoading(true);
    try {
      const [overview, visitsRange] = await Promise.all([
        fetchUserOverview(targetUserId, start, end),
        fetchVisits(targetUserId, `${start}T00:00:00`, `${end}T23:59:59`),
      ]);
      setOverviewData(overview);
      setOverviewVisits(visitsRange);
    } catch (err) {
      console.error("Failed to load user overview:", err);
    } finally {
      setOverviewLoading(false);
    }
  };

  useEffect(() => {
    if (!userId || viewMode !== "overview") return;
    loadOverview(userId, overviewRange[0], overviewRange[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, viewMode, overviewRange]);


  const totalDistance = useMemo(() => {
    let total = 0;
    for (let i = 1; i < visits.length; i++) {
      total += haversine(
        visits[i - 1].lat,
        visits[i - 1].lng,
        visits[i].lat,
        visits[i].lng
      );
    }
    return total.toFixed(2);
  }, [visits]);

  // 按 approval_id 分组，支持按审批单切换轨迹视图
  const approvalGroups = useMemo<ApprovalGroup[]>(() => {
    const groups = new Map<string, ApprovalGroup>();
    const allKey = "__ALL__";
    groups.set(allKey, {
      key: allKey,
      label: "全天总览",
      visits,
      routes,
      stops,
      anomalies,
      mileage: mileage ?? {
        user_id: userId || "",
        totalKm: parseFloat(totalDistance) || 0,
        reportedDistanceKm: 0,
        segmentCount: routes.length,
        estimatedFuelCost: parseFloat((parseFloat(totalDistance) * 0.8).toFixed(2)) || 0,
      },
    });

    const byApproval = new Map<string, Visit[]>();
    for (const v of visits) {
      const key = v.approval_id || "__NO_APPROVAL__";
      if (!byApproval.has(key)) byApproval.set(key, []);
      byApproval.get(key)!.push(v);
    }

    for (const [key, groupVisits] of byApproval) {
      const groupVisitIds = new Set(groupVisits.map((v) => v.id));
      const groupRoutes = routes.filter(
        (r) => groupVisitIds.has(r.from_visit_id) && groupVisitIds.has(r.to_visit_id)
      );
      const groupStops = stops.filter((s) =>
        s.visit_ids.some((id) => groupVisitIds.has(id))
      );
      const groupAnomalies = anomalies.filter((a) =>
        a.related_visit_ids.some((id) => groupVisitIds.has(id))
      );
      const reportedValues = groupVisits
        .map((v) => v.reported_distance_km)
        .filter((d): d is number => d != null && d > 0 && d <= MAX_MILEAGE_KM);
      const reportedDistanceKm = reportedValues.length > 0 ? Math.max(...reportedValues) : 0;
      const totalKm = groupRoutes.reduce((sum, r) => sum + r.distance_km, 0);

      groups.set(key, {
        key,
        label: key === "__NO_APPROVAL__" ? "未关联审批" : `审批 ${key.slice(-8)}`,
        visits: groupVisits,
        routes: groupRoutes,
        stops: groupStops,
        anomalies: groupAnomalies,
        mileage: {
          user_id: userId || "",
          totalKm: parseFloat(totalKm.toFixed(2)),
          reportedDistanceKm: parseFloat(reportedDistanceKm.toFixed(2)),
          segmentCount: groupRoutes.length,
          estimatedFuelCost: parseFloat((totalKm * 0.8).toFixed(2)),
        },
      });
    }

    return Array.from(groups.values());
  }, [visits, routes, stops, anomalies, mileage, userId, totalDistance]);

  const overviewGroup =
    approvalGroups.find((g) => g.key === "__ALL__") || approvalGroups[0];

  const routeGroups = useMemo(
    () =>
      approvalGroups
        .filter((g) => g.key !== "__ALL__")
        .map((g, idx) => ({
          ...g,
          color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
        })),
    [approvalGroups]
  );

  // 避免父组件无关 re-render 导致 MapContainer routeGroups 引用变化
  const mapRouteGroups = useMemo(
    () =>
      routeGroups.map((g) => ({
        key: g.key,
        label: g.label,
        color: g.color,
        routes: g.routes,
        visits: g.visits,
      })),
    [routeGroups]
  );

  // 数据变化时重置各轨迹播放进度
  useEffect(() => {
    setRouteProgressMap({});
    setPlayingRoutes(new Set());
  }, [visits]);

  // 周期总览：按坐标聚合拜访热度
  const heatMapPoints = useMemo(() => {
    const pointMap = new Map<string, { lat: number; lng: number; count: number }>();
    for (const v of overviewVisits) {
      if (v.lat == null || v.lng == null) continue;
      const key = `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;
      if (!pointMap.has(key)) {
        pointMap.set(key, { lat: v.lat, lng: v.lng, count: 0 });
      }
      pointMap.get(key)!.count += 1;
    }
    return Array.from(pointMap.values());
  }, [overviewVisits]);

  const routeProgressRef = useRef<Record<string, number>>({});
  routeProgressRef.current = routeProgressMap;

  useEffect(() => {
    if (playingRoutes.size === 0) return;

    let startTime: number | null = null;
    const startProgressMap = new Map<string, number>();
    for (const key of Array.from(playingRoutes)) {
      const current = routeProgressRef.current[key] ?? 1;
      startProgressMap.set(key, current >= 1 ? 0 : current);
    }

    let animationFrameId: number;

    const animate = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      let stillPlaying = false;
      const next: Record<string, number> = {};

      for (const key of Array.from(playingRoutes)) {
        const startProgress = startProgressMap.get(key) ?? 0;
        const newProgress = Math.min(1, startProgress + elapsed / 10000);
        next[key] = newProgress;
        if (newProgress < 1) stillPlaying = true;
      }

      setRouteProgressMap((prev) => ({ ...prev, ...next }));

      if (stillPlaying) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        setPlayingRoutes(new Set());
      }
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [playingRoutes]);

  // 日历视图：生成连续日期轴（从最早到最晚有数据日期），无数据置灰
  const calendarDates = useMemo(() => {
    if (availableDateInfos.length === 0) return [];
    const sorted = [...availableDateInfos].sort((a, b) => a.date.localeCompare(b.date));
    const min = dayjs.tz(sorted[0].date);
    const max = dayjs.tz(sorted[sorted.length - 1].date);
    const infoMap = new Map(availableDateInfos.map((i) => [i.date, i]));
    const dates: AvailableDate[] = [];
    for (let d = min; d.isBefore(max) || d.isSame(max); d = d.add(1, "day")) {
      const dateStr = d.format("YYYY-MM-DD");
      const info = infoMap.get(dateStr);
      dates.push(info ?? { date: dateStr, has_anomaly: false });
    }
    return dates;
  }, [availableDateInfos]);

  const dateAxisRef = useRef<HTMLDivElement>(null);

  const scrollDateAxis = (direction: "left" | "right") => {
    if (!dateAxisRef.current) return;
    const scrollAmount = 200;
    dateAxisRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const handleToday = () => {
    const today = dayjs.tz().format("YYYY-MM-DD");
    // 优先选今天；今天无数据则选最近的有数据日期
    const target =
      availableDateInfos.find((i) => i.date === today)?.date ||
      availableDateInfos.reduce((prev, curr) =>
        Math.abs(dayjs.tz(curr.date).diff(today, "day")) <
        Math.abs(dayjs.tz(prev.date).diff(today, "day"))
          ? curr
          : prev
      ).date;
    setSelectedDate(target);
    const params = new URLSearchParams(searchParams);
    params.set("date", target);
    setSearchParams(params);
  };

  const selectDate = (dateStr: string) => {
    if (!availableDateInfos.some((i) => i.date === dateStr)) return;
    setSelectedDate(dateStr);
    const params = new URLSearchParams(searchParams);
    params.set("date", dateStr);
    setSearchParams(params);
  };

  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  const toggleRoutePlaying = (key: string) => {
    setPlayingRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if ((routeProgressMap[key] ?? 0) >= 1) {
          setRouteProgressMap((p) => ({ ...p, [key]: 0 }));
        }
      }
      return next;
    });
  };

  const resetAllRoutes = () => {
    const keys = routeGroups.map((g) => g.key);
    const reset: Record<string, number> = {};
    keys.forEach((k) => (reset[k] = 0));
    setRouteProgressMap(reset);
    setPlayingRoutes(new Set(keys));
  };

  return (
    <div>
      {/* 顶部查询区 */}
      <div style={{ paddingBottom: 12 }}>
        {/* Tabs：距下方内容 12px */}
        <div style={{ marginBottom: 12 }}>
          <Tabs
            type="line"
            activeKey={viewMode}
            onChange={(key) => setViewMode(key as "calendar" | "overview")}
            style={{ marginBottom: 0 }}
            contentStyle={{ padding: 0 }}
          >
            <TabPane itemKey="calendar" tab="日历视图" />
            <TabPane itemKey="overview" tab="周期总览" />
          </Tabs>
        </div>

        <Row type="flex" gutter={16} align="middle">
          <Col style={{ flex: "0 0 auto" }}>
            <Select
              placeholder="选择员工"
              style={{ width: 200 }}
              value={userId}
              onChange={(value) => {
                const v = value as string | undefined;
                setUserId(v);
                setVisits([]);
                setStops([]);
                setRoutes([]);
                setAnomalies([]);
                setMileage(null);
                setSelectedDate(null);
                setViewMode("calendar");
                const params = new URLSearchParams(searchParams);
                if (v) params.set("user", v);
                else params.delete("user");
                params.delete("date");
                setSearchParams(params);
              }}
              optionList={users.map((u) => ({
                value: u.user_id,
                label: (
                  <div>
                    <div>{u.user_name}</div>
                    {u.department && (
                      <div style={{ fontSize: 12, color: "var(--semi-color-text-2)" }}>
                        {u.department}
                      </div>
                    )}
                  </div>
                ),
                user_name: u.user_name,
                department: u.department,
              }))}
              renderSelectedItem={(option: any) => <span>{option.user_name}</span>}
            />
          </Col>
          <Col style={{ flex: "1", minWidth: 0 }}>
            {viewMode === "calendar" && !userId && (
              <div style={{ color: "#999" }}>请先选择员工</div>
            )}

            {viewMode === "calendar" && userId && calendarDates.length === 0 && (
              <div style={{ color: "#999" }}>该员工暂无数据</div>
            )}

            {viewMode === "calendar" && userId && calendarDates.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={handleToday}
                  style={{
                    backgroundColor: "#fff",
                    border: "1px solid #d9d9d9",
                    borderRadius: 6,
                    padding: "4px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  今天
                </button>
                <button
                  onClick={() => scrollDateAxis("left")}
                  style={{
                    backgroundColor: "#fff",
                    border: "1px solid #d9d9d9",
                    borderRadius: 6,
                    padding: "4px 10px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  &lt;
                </button>
                <div
                  ref={dateAxisRef}
                  style={{
                    display: "flex",
                    gap: 6,
                    overflowX: "auto",
                    flex: 1,
                    padding: "4px 0",
                  }}
                >
                  {calendarDates.map((info) => {
                    const d = dayjs.tz(info.date);
                    const hasData = availableDateInfos.some((i) => i.date === info.date);
                    const isActive = selectedDate === info.date;
                    return (
                      <button
                        key={info.date}
                        onClick={() => selectDate(info.date)}
                        disabled={!hasData}
                        style={{
                          flexShrink: 0,
                          width: 56,
                          padding: "6px 0",
                          borderRadius: 8,
                          border: "none",
                          backgroundColor: isActive ? "#1890ff" : hasData ? "#fff" : "#f5f5f5",
                          color: isActive ? "#fff" : hasData ? "#0f1419" : "#bbb",
                          cursor: hasData ? "pointer" : "not-allowed",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                          fontSize: 12,
                          position: "relative",
                        }}
                      >
                        <span>{weekdayLabels[d.day()]}</span>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{d.format("MM-DD")}</span>
                        {info.has_anomaly && (
                          <span
                            style={{
                              position: "absolute",
                              top: 2,
                              right: 2,
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              backgroundColor: "#F54C5C",
                            }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => scrollDateAxis("right")}
                  style={{
                    backgroundColor: "#fff",
                    border: "1px solid #d9d9d9",
                    borderRadius: 6,
                    padding: "4px 10px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  &gt;
                </button>
              </div>
            )}

            {viewMode === "overview" && !userId && (
              <div style={{ color: "#999" }}>请先选择员工</div>
            )}

            {viewMode === "overview" && userId && (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <DatePicker
                  type="dateRange"
                  value={[
                    dayjs.tz(overviewRange[0]).toDate(),
                    dayjs.tz(overviewRange[1]).toDate(),
                  ]}
                  onChange={(dates) => {
                    const r = dates as Date[] | null;
                    if (r && r[0] && r[1]) {
                      setOverviewRange([
                        dayjs.tz(r[0]).format("YYYY-MM-DD"),
                        dayjs.tz(r[1]).format("YYYY-MM-DD"),
                      ]);
                    }
                  }}
                  disabledDate={(current) =>
                    !!current && dayjs.tz(current).isAfter(dayjs.tz(), "day")
                  }
                />
                {overviewLoading && <span style={{ color: "#999" }}>加载中...</span>}
              </div>
            )}
          </Col>
        </Row>

        {viewMode === "overview" && userId && (
          <OverviewPanel
            range={overviewRange}
            data={overviewData}
            heatMapPoints={heatMapPoints}
          />
        )}
      </div>

      {viewMode === "calendar" && selectedDate && (
        <>
          {/* 统计卡片 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>拜访点数</span>
                <span style={statValueStyle}>{overviewGroup.visits.length}</span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>总里程 vs 估算里程</span>
                <span style={statValueStyle}>
                  <span style={{ color: overviewGroup.mileage.reportedDistanceKm ? "#0f1419" : "#999" }}>
                    {overviewGroup.mileage.reportedDistanceKm || "未填报"}
                  </span>
                  <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>vs</span>
                  <span>{Math.round(overviewGroup.mileage.totalKm)}</span>
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>Segment 数</span>
                <span style={statValueStyle}>{overviewGroup.mileage.segmentCount}</span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>估算油费 (元)</span>
                <span style={statValueStyle}>{overviewGroup.mileage.estimatedFuelCost}</span>
              </div>
            </Col>
          </Row>

          {/* Anomalies + Map */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <div style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16, height: "100%" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#0f1419" }}>异常事件</div>
                  <div
                    style={{
                      fontSize: 24,
                      fontWeight: 700,
                      color: overviewGroup.anomalies.length > 0 ? "#F54C5C" : "#27C39D",
                    }}
                  >
                    {overviewGroup.anomalies.length}
                  </div>
                </div>
                {overviewGroup.anomalies.length === 0 ? (
                  <div style={{ color: "#999", fontSize: 14 }}>暂无异常</div>
                ) : (
                  <List
                    size="small"
                    dataSource={overviewGroup.anomalies}
                    split={false}
                    renderItem={(item) => <AnomalyItem item={item} />}
                  />
                )}
              </div>
            </Col>
            <Col span={16}>
              <div
                style={{
                  padding: 12,
                  backgroundColor: "#fff",
                  borderRadius: 16,
                  height: "500px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, color: "#0f1419", marginBottom: 8 }}>
                  轨迹地图
                </div>
                <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                  <MapContainer
                    routeGroups={mapRouteGroups}
                    stops={overviewGroup.stops}
                    anomalies={overviewGroup.anomalies}
                    progressMap={routeProgressMap}
                  />
                  {routeGroups.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        left: 12,
                        zIndex: 10,
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        backgroundColor: "rgba(255, 255, 255, 0.92)",
                        padding: "6px 12px",
                        borderRadius: 20,
                        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
                      }}
                    >
                      {routeGroups.map((g) => {
                        const isPlaying = playingRoutes.has(g.key);
                        return (
                          <button
                            key={g.key}
                            onClick={() => toggleRoutePlaying(g.key)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: 18,
                              color: g.color,
                              display: "flex",
                              alignItems: "center",
                              padding: 0,
                            }}
                            title={`${g.label} ${isPlaying ? "暂停" : "播放"}`}
                          >
                            {isPlaying ? <IconPause /> : <IconPlayCircle />}
                          </button>
                        );
                      })}
                      <button
                        onClick={resetAllRoutes}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 16,
                          color: "#0f1419",
                          display: "flex",
                          alignItems: "center",
                          padding: 0,
                        }}
                        title="全部重放"
                      >
                        <IconRedo />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

interface OverviewPanelProps {
  range: [string, string];
  data: UserOverviewResult | null;
  heatMapPoints: { lat: number; lng: number; count: number }[];
}

function OverviewPanel({
  range,
  data,
  heatMapPoints,
}: OverviewPanelProps) {
  const filled = useMemo(
    () => fillDailyRange(data?.daily ?? [], range[0], range[1]),
    [data, range]
  );
  // 估算里程只显示整数，填报里程保持原精度
  const chartData = useMemo(
    () =>
      filled.map((d) => ({
        ...d,
        estimated_distance_km: Math.round(d.estimated_distance_km),
      })),
    [filled]
  );
  const totals = data?.totals;

  return (
    <div style={{ marginTop: 16 }}>
      {!data ? (
        <div style={{ color: "#999" }}>选择时间范围加载数据</div>
      ) : (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>总拜访数</span>
                <span style={statValueStyle}>{totals?.visit_count ?? 0}</span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>总停留时长</span>
                <span style={statValueStyle}>
                  {((totals?.stop_minutes ?? 0) / 60).toFixed(1)}h
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>填报 / 估算里程</span>
                <span style={statValueStyle}>
                  <span>{totals?.reported_distance_km ?? 0}</span>
                  <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>/</span>
                  <span>{Math.round(totals?.estimated_distance_km ?? 0)}</span>
                  <span style={{ fontSize: 12, color: "#999" }}>km</span>
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>异常事件</span>
                <span
                  style={{
                    ...statValueStyle,
                    color: (totals?.anomaly_count ?? 0) > 0 ? "#F54C5C" : "#27C39D",
                  }}
                >
                  {totals?.anomaly_count ?? 0}
                </span>
              </div>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={24}>
              <div style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                  每日趋势
                </div>
                <Suspense fallback={<div style={{ height: 320 }}>加载图表中...</div>}>
                  <OverviewChart data={chartData} />
                </Suspense>
              </div>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={24}>
              <div
                style={{
                  padding: 20,
                  backgroundColor: "#fff",
                  borderRadius: 16,
                  height: 460,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                  拜访热度
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <HeatMapContainer points={heatMapPoints} />
                </div>
              </div>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const anomalySeverityText = {
  high: "高",
  medium: "中",
  low: "低",
};

const anomalySeverityColor = {
  high: "red",
  medium: "orange",
  low: "green",
};

function AnomalyItem({ item }: { item: Anomaly }) {
  const m = item.metadata || {};

  // 涉及两地：mileage_deviation / route_detour
  if (m.from_location && m.to_location) {
    const isMileage = item.type === "mileage_deviation";
    const title = `${m.from_location} → ${m.to_location}`;
    const description = isMileage
      ? `填报 ${m.reported_distance_km ?? "-"}km vs 高德 ${
          m.gaode_distance_km != null ? Math.round(m.gaode_distance_km) : "-"
        }km · 偏差 ${
          m.deviation_rate != null ? `${(m.deviation_rate * 100).toFixed(1)}%` : "-"
        }`
      : `实际 ${Math.round(m.actual_distance_km ?? 0)}km vs 直线 ${Math.round(
          m.straight_distance_km ?? 0
        )}km`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 长时间未移动
  if (item.type === "long_idle" && item.start_time && item.end_time) {
    const start = dayjs.tz(item.start_time);
    const end = dayjs.tz(item.end_time);
    const minutes = end.diff(start, "minute");
    const title = `${minutes}min无移动记录`;
    const description = `${start.format("YYYY-MM-DD HH:mm")} - ${end.format("YYYY-MM-DD HH:mm")}`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 签到次数不足
  if (item.type === "low_visit_count") {
    const match = item.description.match(/过去\s*5\s*个工作日累计签到\s*(\d+)\s*次/);
    const count = match ? match[1] : "?";
    const title = "签到次数不足";
    const description = `过去 5 个工作日累计签到 ${count} 次`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 其他异常：按类型给出标题
  const title = ANOMALY_TYPE_TITLES[item.type] || "异常";
  return renderAnomalyRow(item.severity, title, item.description);
}

function renderAnomalyRow(
  severity: "low" | "medium" | "high",
  title: string,
  description: string
) {
  return (
    <List.Item style={{ padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
        <Tag color={anomalySeverityColor[severity] as any} style={{ flexShrink: 0, marginTop: 2 }}>
          {anomalySeverityText[severity]}
        </Tag>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#0f1419",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={title}
          >
            {title}
          </div>
          <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>{description}</div>
        </div>
      </div>
    </List.Item>
  );
}

const ANOMALY_TYPE_TITLES: Record<string, string> = {
  duplicate_location: "重复签到",
  long_stop: "停留过长",
  invalid_trip_type: "异常出行方式",
  missing_special_reason: "特殊签到缺原因",
};

export default ConsolePage;
