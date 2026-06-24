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
  const [date, setDate] = useState<Dayjs | null>(null);
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

  // 从 URL 参数初始化筛选条件
  useEffect(() => {
    const userFromUrl = searchParams.get("user");
    const dateFromUrl = searchParams.get("date");
    if (userFromUrl) setUserId(userFromUrl);
    if (dateFromUrl) setDate(dayjs(dateFromUrl));
  }, [searchParams]);

  useEffect(() => {
    if (!userId) {
      setAvailableDates([]);
      return;
    }
    fetchAvailableDates(userId).then((dates) => {
      setAvailableDates(dates);
      if (!date && dates.length > 0) {
        setDate(dayjs(dates[0]));
      }
    });
  }, [userId]);

  // URL 参数或筛选条件变化时自动加载
  useEffect(() => {
    if (userId && date) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, date]);

  const loadData = async () => {
    if (!userId || !date) return;
    setLoading(true);
    try {
      const dateStr = date.format("YYYY-MM-DD");
      const start = `${dateStr}T00:00:00`;
      const end = `${dateStr}T23:59:59`;
      const [v, s, r, m, a] = await Promise.all([
        fetchVisits(userId, start, end),
        fetchStops(userId, dateStr),
        fetchRoutes(userId, dateStr),
        fetchMileage(userId, dateStr),
        fetchAnomalies(userId, dateStr),
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

  const severityColor = {
    low: "default",
    medium: "orange",
    high: "red",
  } as const;

  const disabledDate = (current: Dayjs) => {
    if (availableDates.length === 0) return true;
    const dateStr = current.format("YYYY-MM-DD");
    return !availableDates.includes(dateStr);
  };

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
                const params = new URLSearchParams(searchParams);
                if (value) params.set("user", value);
                else params.delete("user");
                setSearchParams(params);
              }}
              options={users.map((u) => ({
                value: u.user_id,
                label: `${u.user_name} (${u.department})`,
              }))}
            />
          </Col>
          <Col>
            <DatePicker
              placeholder="选择日期"
              value={date}
              onChange={(d) => {
                if (d) {
                  setDate(d);
                  const params = new URLSearchParams(searchParams);
                  params.set("date", d.format("YYYY-MM-DD"));
                  setSearchParams(params);
                }
              }}
              disabled={!userId || availableDates.length === 0}
              disabledDate={disabledDate}
            />
          </Col>
          <Col>
            <button
              onClick={loadData}
              disabled={loading || !date}
              style={{
                backgroundColor: loading || !date ? "#F3F4F6" : "#EBECED",
                color: "#0f1419",
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: loading || !date ? "not-allowed" : "pointer",
                opacity: loading || !date ? 0.6 : 1,
                transition: "background-color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!loading && date) e.currentTarget.style.backgroundColor = "#E6E7E8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = loading || !date ? "#F3F4F6" : "#EBECED";
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
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>拜访点数</span>
            <span style={statValueStyle}>{visits.length}</span>
          </div>
        </Col>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>停留点数</span>
            <span style={statValueStyle}>{stops.length}</span>
          </div>
        </Col>
        <Col span={6}>
          <div style={statStyle}>
            <span style={statLabelStyle}>总里程 (km)</span>
            <span style={statValueStyle}>{mileage?.totalKm ?? totalDistance}</span>
          </div>
        </Col>
        <Col span={6}>
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
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>Segment 数</span>
            <span style={statValueStyle}>{mileage?.segmentCount ?? 0}</span>
          </div>
        </Col>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>估算油费 (元)</span>
            <span style={statValueStyle}>{mileage?.estimatedFuelCost ?? 0}</span>
          </div>
        </Col>
        <Col span={8}>
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
                renderItem={(item) => (
                  <List.Item>
                    <Tag color={severityColor[item.severity]}>
                      {item.severity === "high" ? "高" : item.severity === "medium" ? "中" : "低"}
                    </Tag>
                    {item.description}
                  </List.Item>
                )}
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

export default Dashboard;
