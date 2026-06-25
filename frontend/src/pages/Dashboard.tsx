import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DatePicker, Select, Row, Col, List, Tag } from "antd";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchUsers,
  fetchAvailableDates,
  fetchVisits,
  fetchStops,
  fetchRoutes,
  fetchMileage,
  fetchAnomalies,
} from "../api";
import { User, Visit, Stop, Route, Anomaly, MileageStats } from "../types";
import MapContainer from "../components/MapContainer";

function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string>();
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [mileage, setMileage] = useState<MileageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapPlaying, setMapPlaying] = useState(false);
  const [mapProgress, setMapProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchUsers().then((data) => {
      if (!cancelled) setUsers(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 从 URL 参数初始化筛选条件，并标记是否需要自动加载
  const [initialLoaded, setInitialLoaded] = useState(false);

  useEffect(() => {
    const userFromUrl = searchParams.get("user");
    const dateFromUrl = searchParams.get("date");
    const startFromUrl = searchParams.get("start");
    const endFromUrl = searchParams.get("end");
    if (userFromUrl) setUserId(userFromUrl);
    if (startFromUrl && endFromUrl) {
      setDateRange([dayjs(startFromUrl), dayjs(endFromUrl)]);
    } else if (dateFromUrl) {
      const d = dayjs(dateFromUrl);
      setDateRange([d, d]);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!userId) {
      setAvailableDates([]);
      return;
    }
    fetchAvailableDates(userId).then((dates) => {
      setAvailableDates(dates);
      // 如果当前没有选日期范围，自动填充昨天单日（不自动加载）
      setDateRange((prev) => {
        if (prev) return prev;
        const yesterday = dayjs().subtract(1, "day");
        const params = new URLSearchParams(searchParams);
        params.set("start", yesterday.format("YYYY-MM-DD"));
        params.set("end", yesterday.format("YYYY-MM-DD"));
        params.delete("date");
        setSearchParams(params);
        return [yesterday, yesterday];
      });
    });
  }, [userId]);

  // 首次从 URL 进入时自动加载一次（例如从决策系统跳转）
  useEffect(() => {
    if (initialLoaded) return;
    const userFromUrl = searchParams.get("user");
    const dateFromUrl = searchParams.get("date");
    const startFromUrl = searchParams.get("start");
    const endFromUrl = searchParams.get("end");
    if (userFromUrl && (dateFromUrl || (startFromUrl && endFromUrl))) {
      setInitialLoaded(true);
      setUserId(userFromUrl);
      const start = dayjs(startFromUrl || dateFromUrl);
      const end = dayjs(endFromUrl || dateFromUrl);
      setDateRange([start, end]);
      setTimeout(() => {
        loadDataFor(userFromUrl, [start, end]);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const loadDataFor = async (targetUserId: string, targetRange: [Dayjs, Dayjs]) => {
    setLoading(true);
    try {
      const start = targetRange[0].format("YYYY-MM-DD");
      const end = targetRange[1].format("YYYY-MM-DD");
      const startTime = `${start}T00:00:00`;
      const endTime = `${end}T23:59:59`;
      const [v, s, r, m, a] = await Promise.all([
        fetchVisits(targetUserId, startTime, endTime),
        fetchStops(targetUserId, startTime, endTime),
        fetchRoutes(targetUserId, startTime, endTime),
        fetchMileage(targetUserId, startTime, endTime),
        fetchAnomalies(targetUserId, startTime, endTime),
      ]);
      setVisits(v);
      setStops(s);
      setRoutes(r);
      setMileage(m);
      setAnomalies(a);
      setMapProgress(0);
      setMapPlaying(false);
    } finally {
      setLoading(false);
    }
  };

  const loadData = async () => {
    if (!userId || !dateRange) return;
    await loadDataFor(userId, dateRange);
  };

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

  return (
    <div>
      {/* Filter Bar */}
      <div style={{ marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <Select
              placeholder="选择员工"
              style={{ width: 200 }}
              value={userId}
              onChange={(value) => {
                setUserId(value);
                setVisits([]);
                setStops([]);
                setRoutes([]);
                setAnomalies([]);
                setMileage(null);
                setDateRange(null);
                const params = new URLSearchParams(searchParams);
                if (value) params.set("user", value);
                else params.delete("user");
                params.delete("date");
                params.delete("start");
                params.delete("end");
                setSearchParams(params);
              }}
              options={users.map((u) => ({
                value: u.user_id,
                label: `${u.user_name} (${u.department})`,
              }))}
            />
          </Col>
          <Col>
            <DatePicker.RangePicker
              placeholder={["开始日期", "结束日期"]}
              value={dateRange}
              onChange={(range) => {
                if (range && range[0] && range[1]) {
                  const newRange: [Dayjs, Dayjs] = [range[0], range[1]];
                  setDateRange(newRange);
                  setVisits([]);
                  setStops([]);
                  setRoutes([]);
                  setAnomalies([]);
                  setMileage(null);
                  const params = new URLSearchParams(searchParams);
                  params.set("start", newRange[0].format("YYYY-MM-DD"));
                  params.set("end", newRange[1].format("YYYY-MM-DD"));
                  params.delete("date");
                  setSearchParams(params);
                }
              }}
              disabled={!userId || availableDates.length === 0}
            />
          </Col>
          <Col>
            <button
              onClick={loadData}
              disabled={loading || !dateRange}
              style={{
                backgroundColor: loading || !dateRange ? "#F3F4F6" : "#EBECED",
                color: "#0f1419",
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: loading || !dateRange ? "not-allowed" : "pointer",
                opacity: loading || !dateRange ? 0.6 : 1,
                transition: "background-color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!loading && dateRange) e.currentTarget.style.backgroundColor = "#E6E7E8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = loading || !dateRange ? "#F3F4F6" : "#EBECED";
              }}
            >
              {loading ? "查询中..." : "查询"}
            </button>
          </Col>
          {availableDates.length > 0 && (
            <Col style={{ color: "#72808a", fontSize: 13 }}>
              该员工共有 {availableDates.length} 天有数据
            </Col>
          )}
        </Row>
      </div>

      {/* Stats Row 1 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>拜访点数</span>
            <span style={statValueStyle}>{visits.length}</span>
          </div>
        </Col>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>停留点数</span>
            <span style={statValueStyle}>{stops.length}</span>
          </div>
        </Col>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>异常事件</span>
            <span style={{ ...statValueStyle, color: anomalies.length > 0 ? "#F54C5C" : "#27C39D" }}>
              {anomalies.length}
            </span>
          </div>
        </Col>
      </Row>

      {/* Stats Row 2 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>总里程 vs 估算里程</span>
            <span style={statValueStyle}>
              <span style={{ color: mileage?.reportedDistanceKm ? "#0f1419" : "#999" }}>
                {mileage?.reportedDistanceKm || "未填报"}
              </span>
              <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>vs</span>
              <span>{mileage?.totalKm ?? totalDistance}</span>
            </span>
          </div>
        </Col>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>Segment 数</span>
            <span style={statValueStyle}>{mileage?.segmentCount ?? 0}</span>
          </div>
        </Col>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>估算油费 (元)</span>
            <span style={statValueStyle}>{mileage?.estimatedFuelCost ?? 0}</span>
          </div>
        </Col>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>总停留时长 (min)</span>
            <span style={statValueStyle}>{stops.reduce((sum, s) => sum + s.duration_minutes, 0)}</span>
          </div>
        </Col>
      </Row>

      {/* Anomalies + Map */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <div style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16, height: "100%" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#0f1419", marginBottom: 12 }}>
              异常事件
            </div>
            {anomalies.length === 0 ? (
              <div style={{ color: "#999", fontSize: 14 }}>暂无异常</div>
            ) : (
              <List
                size="small"
                dataSource={anomalies}
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
            <div style={{ flex: 1, minHeight: 0 }}>
              <MapContainer
                visits={visits}
                stops={stops}
                routes={routes}
                anomalies={anomalies}
                playing={mapPlaying}
                progress={mapProgress}
                onProgressChange={setMapProgress}
              />
            </div>
          </div>
        </Col>
      </Row>
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
    const subtitle = isMileage
      ? `填报 ${m.reported_distance_km ?? "-"}km vs 高德 ${m.gaode_distance_km ?? "-"}km · 偏差 ${
          m.deviation_rate != null ? `${(m.deviation_rate * 100).toFixed(1)}%` : "-"
        }`
      : `实际 ${(m.actual_distance_km ?? 0).toFixed(2)}km vs 直线 ${(m.straight_distance_km ?? 0).toFixed(
          2
        )}km`;

    return (
      <List.Item style={{ padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
          <Tag color={anomalySeverityColor[item.severity]} style={{ flexShrink: 0, marginTop: 2 }}>
            {anomalySeverityText[item.severity]}
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
            <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>{subtitle}</div>
          </div>
        </div>
      </List.Item>
    );
  }

  // 其他异常：左侧 tag + description
  return (
    <List.Item style={{ padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
        <Tag color={anomalySeverityColor[item.severity]} style={{ flexShrink: 0, marginTop: 2 }}>
          {anomalySeverityText[item.severity]}
        </Tag>
        <div style={{ fontSize: 14, color: "#0f1419", lineHeight: 1.5 }}>{item.description}</div>
      </div>
    </List.Item>
  );
}

export default Dashboard;
