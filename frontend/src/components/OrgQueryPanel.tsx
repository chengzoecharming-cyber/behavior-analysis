import { useEffect, useMemo, useState } from "react";
import { Row, Col, Table, Spin, Typography } from "@douyinfe/semi-ui";
import dayjs from "dayjs";
import { fetchOrgOverview, OrgOverviewResponse, OrgRankingItem } from "../api";
import HeatMapContainer from "./HeatMapContainer";
import { Suspense, lazy } from "react";

const OverviewChart = lazy(() => import("./OverviewChart"));

const { Title } = Typography;

interface OrgQueryPanelProps {
  scope: "company" | "department" | "sub_department";
  nodeName: string;
  start: string;
  end: string;
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

function formatKm(value: number): string {
  return `${Math.round(value)}`;
}

function OrgQueryPanel({ scope, nodeName, start, end }: OrgQueryPanelProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OrgOverviewResponse | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchOrgOverview(scope, nodeName, start, end)
      .then(setData)
      .catch((err) => {
        console.error("Failed to load org overview:", err);
      })
      .finally(() => setLoading(false));
  }, [scope, nodeName, start, end]);

  const trendData = useMemo(() => {
    if (!data) return [];
    return data.trend.map((d) => ({
      date: d.date,
      visit_count: d.visitCount,
      reported_distance_km: d.reportedKm,
      estimated_distance_km: Math.round(d.estimatedKm),
      stop_minutes: d.stopMinutes,
      anomaly_count: d.anomalyCount,
    }));
  }, [data]);

  const heatMapPoints = useMemo(() => {
    if (!data) return [];
    return data.heatMapPoints.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      count: p.count,
    }));
  }, [data]);

  const dayCount = useMemo(() => {
    const s = dayjs.tz(start);
    const e = dayjs.tz(end);
    return e.diff(s, "day") + 1;
  }, [start, end]);

  const visitFrequency = useMemo(() => {
    if (!data || dayCount <= 0) return "0";
    return (data.stats.totalVisits / dayCount).toFixed(2);
  }, [data, dayCount]);

  const estimatedFuelCost = useMemo(() => {
    if (!data) return "0.00";
    return (data.stats.totalEstimatedKm * 0.8).toFixed(2);
  }, [data]);

  const rankingColumns = [
    {
      title: "名称",
      dataIndex: "name",
      render: (_: any, record: OrgRankingItem) => {
        const params = new URLSearchParams();
        params.set("start", start);
        params.set("end", end);
        if (record.level === "person") {
          params.set("user", record.key);
        } else if (record.level === "department") {
          params.set("scope", "department");
          params.set("node", record.key);
        } else if (record.level === "sub_department") {
          params.set("scope", "sub_department");
          params.set("node", record.key);
        }
        const href = `/console?${params.toString()}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              window.open(href, "_blank");
            }}
          >
            {record.name}
          </a>
        );
      },
    },
    {
      title: "拜访次数",
      dataIndex: "visitCount",
      sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
        (a?.visitCount ?? 0) - (b?.visitCount ?? 0),
    },
    {
      title: "填报/估算里程",
      dataIndex: "reportedKm",
      render: (_: any, record: OrgRankingItem) =>
        `${formatKm(record.reportedKm)} / ${formatKm(record.estimatedKm)}`,
      sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
        (a?.reportedKm ?? 0) - (b?.reportedKm ?? 0),
    },
  ];

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!data) {
    return <div style={{ padding: 40, textAlign: "center" }}>暂无数据</div>;
  }

  const { stats } = data;

  return (
    <div>
      {/* 指标卡：与个人周期总览保持一致 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>填报 / 估算里程</span>
            <span style={statValueStyle}>
              <span>{stats.totalReportedKm}</span>
              <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>/</span>
              <span>{Math.round(stats.totalEstimatedKm)}</span>
              <span style={{ fontSize: 12, color: "#999" }}>km</span>
            </span>
          </div>
        </Col>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>预估油费</span>
            <span style={statValueStyle}>
              {estimatedFuelCost}
              <span style={{ fontSize: 12, color: "#999" }}>元</span>
            </span>
          </div>
        </Col>
        <Col span={8}>
          <div style={statStyle}>
            <span style={statLabelStyle}>拜访频率</span>
            <span style={statValueStyle}>
              {visitFrequency}
              <span style={{ fontSize: 12, color: "#999" }}>次/天</span>
            </span>
          </div>
        </Col>
      </Row>

      {/* 趋势图 */}
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 16,
          padding: 20,
          marginBottom: 16,
          height: 380,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Title heading={6} style={{ marginBottom: 16 }}>
          趋势分析
        </Title>
        {trendData.length === 0 ? (
          <div style={{ color: "#999", flex: 1 }}>暂无趋势数据</div>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Suspense fallback={<Spin />}>
              <OverviewChart
                data={trendData}
                height="100%"
                onDateClick={(date) => {
                  const params = new URLSearchParams();
                  params.set("scope", scope);
                  if (nodeName) params.set("node", nodeName);
                  params.set("start", date);
                  params.set("end", date);
                  window.open(`/console?${params.toString()}`, "_blank");
                }}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* 热力图 + 排行榜 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={16}>
          <div
            style={{
              backgroundColor: "#fff",
              borderRadius: 16,
              padding: 20,
              height: 520,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Title heading={6} style={{ marginBottom: 12 }}>
              拜访热力图
            </Title>
            <div style={{ flex: 1, minHeight: 0 }}>
              <HeatMapContainer points={heatMapPoints} />
            </div>
          </div>
        </Col>
        <Col span={8}>
          <div
            style={{
              backgroundColor: "#fff",
              borderRadius: 16,
              padding: 20,
              height: 520,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Title heading={6} style={{ marginBottom: 12 }}>
              {scope === "company" && "部门排行榜"}
              {scope === "department" && "子部门排行榜"}
              {scope === "sub_department" && "人员排行榜"}
            </Title>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              <Table
                columns={rankingColumns}
                dataSource={data.ranking}
                pagination={false}
                rowKey="key"
              />
            </div>
          </div>
        </Col>
      </Row>
    </div>
  );
}

export default OrgQueryPanel;
