import { useEffect, useState } from "react";
import { Card, DatePicker, Select, Button, Slider, Row, Col, Space } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchUsers,
  fetchAvailableDates,
  fetchVisits,
  fetchStops,
  fetchRoutes,
  fetchAnomalies,
} from "../api";
import { User, Visit, Stop, Route, Anomaly } from "../types";
import MapContainer from "../components/MapContainer";

function MapPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string>();
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    fetchUsers().then(setUsers);
  }, []);

  useEffect(() => {
    if (!userId) {
      setAvailableDates([]);
      setDate(null);
      return;
    }
    fetchAvailableDates(userId).then((dates) => {
      setAvailableDates(dates);
      if (dates.length > 0) {
        setDate(dayjs(dates[0]));
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
        fetchStops(userId, dateStr),
        fetchRoutes(userId, dateStr),
        fetchAnomalies(userId, dateStr),
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
    return !availableDates.includes(dateStr);
  };

  return (
    <div
      style={{
        height: "calc(100vh - 112px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
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
            <Button type="primary" onClick={loadData} loading={loading} disabled={!date}>
              加载轨迹
            </Button>
          </Col>
          {availableDates.length > 0 && (
            <Col style={{ color: "#888" }}>
              该员工共有 {availableDates.length} 天有数据
            </Col>
          )}
        </Row>
      </Card>

      <Card
        style={{ flex: 1, minHeight: 0 }}
        styles={{
          body: {
            height: "100%",
            padding: 0,
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        <div style={{ flex: 1, minHeight: 0, padding: 12 }}>
          <MapContainer
            visits={visits}
            stops={stops}
            routes={routes}
            anomalies={anomalies}
            playing={playing}
            progress={progress}
            onProgressChange={setProgress}
          />
        </div>

        <Space
          direction="vertical"
          style={{ width: "100%", padding: 16, borderTop: "1px solid #f0f0f0" }}
        >
          <Space>
            <Button
              type="primary"
              icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => setPlaying(!playing)}
              disabled={visits.length === 0}
            >
              {playing ? "暂停" : "播放"}
            </Button>
            <span>
              {visits[Math.min(progress, visits.length - 1)]
                ? dayjs(
                    visits[Math.min(progress, visits.length - 1)].timestamp
                  ).format("HH:mm")
                : "--:--"}
            </span>
          </Space>
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
                ? dayjs(
                    visits[Math.min(Math.floor(v as number), visits.length - 1)]
                      .timestamp
                  ).format("HH:mm")
                : ""
            }}
          />
        </Space>
      </Card>
    </div>
  );
}

export default MapPage;
