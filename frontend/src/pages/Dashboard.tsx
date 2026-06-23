import { useEffect, useMemo, useState } from "react";
import { Card, DatePicker, Select, Button, Statistic, Row, Col, Slider, List, Tag } from "antd";
import dayjs, { Dayjs } from "dayjs";
import { fetchUsers, fetchAvailableDates, fetchVisits, fetchStops, fetchMileage, fetchAnomalies } from "../api";
import { User, Visit, Stop, Anomaly, MileageStats } from "../types";

function Dashboard() {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState<string>();
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [mileage, setMileage] = useState<MileageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [sliderValue, setSliderValue] = useState(0);

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
    try {
      const dateStr = date.format("YYYY-MM-DD");
      const start = `${dateStr}T00:00:00`;
      const end = `${dateStr}T23:59:59`;
      const [v, s, m, a] = await Promise.all([
        fetchVisits(userId, start, end),
        fetchStops(userId, dateStr),
        fetchMileage(userId, dateStr),
        fetchAnomalies(userId, dateStr),
      ]);
      setVisits(v);
      setStops(s);
      setMileage(m);
      setAnomalies(a);
      setSliderValue(0);
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

  const currentVisit = visits[Math.floor(sliderValue)];

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

  return (
    <div>
      <Card title="筛选条件" style={{ marginBottom: 16 }}>
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
              查询
            </Button>
          </Col>
          {availableDates.length > 0 && (
            <Col style={{ color: "#888" }}>
              该员工共有 {availableDates.length} 天有数据
            </Col>
          )}
        </Row>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="拜访点数" value={visits.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="停留点数" value={stops.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="总里程 (km)"
              value={mileage?.totalKm ?? totalDistance}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="异常事件"
              value={anomalies.length}
              valueStyle={{
                color: anomalies.length > 0 ? "#cf1322" : "#3f8600",
              }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="Segment 数"
              value={mileage?.segmentCount ?? 0}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="估算油费 (元)"
              value={mileage?.estimatedFuelCost ?? 0}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="总停留时长 (min)"
              value={stops.reduce((sum, s) => sum + s.duration_minutes, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={16}>
          <Card title="时间轴预览">
            <Slider
              min={0}
              max={Math.max(0, visits.length - 1)}
              value={sliderValue}
              onChange={setSliderValue}
              disabled={visits.length === 0}
              tooltip={{ formatter: (idx) =>
                idx !== undefined && visits[idx as number]
                  ? dayjs(visits[idx as number].timestamp).format("HH:mm")
                  : ""
              }}
            />
            {currentVisit && (
              <div style={{ marginTop: 8 }}>
                <strong>{dayjs(currentVisit.timestamp).format("HH:mm")}</strong> —
                {currentVisit.location_name}（{currentVisit.customer_name}）
              </div>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card title="异常事件">
            {anomalies.length === 0 ? (
              <div style={{ color: "#999" }}>暂无异常</div>
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
          </Card>
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
