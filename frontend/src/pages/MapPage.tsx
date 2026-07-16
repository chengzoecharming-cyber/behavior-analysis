import { useEffect, useRef, useState } from "react";
import { DatePicker, Select, Slider, Row, Col } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchUsers,
  fetchAvailableDates,
  fetchVisits,
  fetchStops,
  fetchRoutes,
  fetchAnomalies,
  AvailableDate,
} from "../api";
import { User, Visit, Stop, Route, Anomaly } from "../types";
import { formatBeijingHHmm } from "../utils/time";
import MapContainer from "../components/MapContainer";

function MapPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string>();
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([]);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const progressRef = useRef(progress);
  progressRef.current = progress;

  useEffect(() => {
    if (!playing) return;

    let startTime: number | null = null;
    const maxProgress = Math.max(0, visits.length - 1);
    const startProgress = progressRef.current >= maxProgress ? 0 : progressRef.current;
    let animationFrameId: number;

    const animate = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const duration = 10000;
      const newProgress = Math.min(maxProgress, startProgress + (elapsed / duration) * maxProgress);

      setProgress(newProgress);

      if (newProgress < maxProgress) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        setPlaying(false);
      }
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [playing, visits.length]);

  useEffect(() => {
    fetchUsers().then(setUsers);
  }, []);

  useEffect(() => {
    if (!userId) {
      setAvailableDates([]);
      setDate(null);
      return;
    }
    fetchAvailableDates({ userId }).then((dates) => {
      setAvailableDates(dates);
      if (dates.length > 0) {
        setDate(dayjs.tz(dates[0].date));
      } else {
        setDate(null);
      }
    });
  }, [userId]);

  const loadData = async () => {
    if (!userId || !date) return;
    setLoading(true);
    setPlaying(false);
    setProgress(0);
    try {
      const dateStr = date.format("YYYY-MM-DD");
      const start = `${dateStr}T00:00:00`;
      const end = `${dateStr}T23:59:59`;
      const [v, s, r, a] = await Promise.all([
        fetchVisits(userId, start, end),
        fetchStops(userId, start, end),
        fetchRoutes(userId, start, end),
        fetchAnomalies(userId, start, end),
      ]);
      setVisits(v);
      setStops(s);
      setRoutes(r);
      setAnomalies(a);
    } finally {
      setLoading(false);
    }
  };

  const disabledDate = (current: Dayjs) => {
    if (availableDates.length === 0) return true;
    const dateStr = current.format("YYYY-MM-DD");
    return !availableDates.some((info) => info.date === dateStr);
  };

  return (
    <div
      style={{
        height: "calc(100vh - 112px)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {/* Filter Bar */}
      <div style={{ marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <Select
              placeholder="选择员工"
              style={{ width: 200 }}
              value={userId}
              onChange={setUserId}
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
              onChange={(d) => d && setDate(d)}
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
              {loading ? "加载中..." : "加载轨迹"}
            </button>
          </Col>
          {availableDates.length > 0 && (
            <Col style={{ color: "#72808a", fontSize: 13 }}>
              该员工共有 {availableDates.length} 天有数据
            </Col>
          )}
        </Row>
      </div>

      {/* Map Area */}
      <div style={{ flex: 1, minHeight: 0, backgroundColor: "#fff", borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, minHeight: 0, padding: 12 }}>
          <MapContainer
            visits={visits}
            stops={stops}
            routes={routes}
            anomalies={anomalies}
            progress={progress / Math.max(1, visits.length - 1)}
          />
        </div>

        <div
          style={{ padding: 16, borderTop: "1px solid #f0f0f0", display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => setPlaying(!playing)}
              disabled={visits.length === 0}
              style={{
                backgroundColor: visits.length === 0 ? "#F3F4F6" : "#EBECED",
                color: "#0f1419",
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 14,
                fontWeight: 500,
                cursor: visits.length === 0 ? "not-allowed" : "pointer",
                opacity: visits.length === 0 ? 0.6 : 1,
                display: "flex",
                alignItems: "center",
                gap: 6,
                transition: "background-color 0.2s",
              }}
              onMouseEnter={(e) => {
                if (visits.length > 0) e.currentTarget.style.backgroundColor = "#E6E7E8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = visits.length === 0 ? "#F3F4F6" : "#EBECED";
              }}
            >
              {playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              {playing ? "暂停" : "播放"}
            </button>
            <span style={{ fontSize: 14, color: "#333" }}>
              {visits[Math.min(progress, visits.length - 1)]
                ? formatBeijingHHmm(
                    visits[Math.min(progress, visits.length - 1)].timestamp
                  )
                : "--:--"}
            </span>
          </div>
          <Slider
            min={0}
            max={Math.max(0, visits.length - 1)}
            step={0.05}
            value={progress}
            onChange={(v) => {
              setProgress(v);
              if (playing) setPlaying(false);
            }}
            disabled={visits.length === 0}
            tooltip={{ formatter: (v) =>
              visits[Math.min(Math.floor(v as number), visits.length - 1)]
                ? formatBeijingHHmm(
                    visits[Math.min(Math.floor(v as number), visits.length - 1)]
                      .timestamp
                  )
                : ""
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default MapPage;
