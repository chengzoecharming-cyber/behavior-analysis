import { useEffect, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DatePicker,
  Select,
  Badge,
  Tag,
  Typography,
  Empty,
  Spin,
  Divider,
  Row,
  Col,
  Space,
} from "@douyinfe/semi-ui";
import {
  IconSearch,
  IconMapPin,
  IconClock,
} from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import { fetchRiskSummary, RiskSummaryResponse, EmployeeRiskSummary } from "../api";

const { Title, Text } = Typography;

function RiskBadge({ level }: { level: "high" | "medium" | "low" }) {
  const colors = {
    high: "#F54C5C",
    medium: "#F7A046",
    low: "#27C39D",
  };
  const labels = { high: "高风险", medium: "可疑", low: "正常" };
  return (
    <Badge
      count={labels[level]}
      style={{
        backgroundColor: colors[level] + "20",
        color: colors[level],
        border: `1px solid ${colors[level]}`,
      }}
    />
  );
}

function DecisionPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [date, setDate] = useState<Date>(() => {
    const dateFromUrl = searchParams.get("date");
    return dateFromUrl ? new Date(dateFromUrl) : new Date();
  });
  const [data, setData] = useState<RiskSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [riskFilter, setRiskFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [deptFilter, setDeptFilter] = useState<string>("all");

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetchRiskSummary(dayjs(date).format("YYYY-MM-DD"));
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [date]);

  const departments = useMemo(() => {
    if (!data) return [];
    const depts = new Set<string>();
    data.employees.forEach((e) => depts.add(e.department));
    return Array.from(depts);
  }, [data]);

  const filteredEmployees = useMemo(() => {
    if (!data) return [];
    let filtered = data.employees;
    if (riskFilter !== "all") {
      filtered = filtered.filter((e) => e.risk_level === riskFilter);
    }
    if (deptFilter !== "all") {
      filtered = filtered.filter((e) => e.department === deptFilter);
    }
    return filtered;
  }, [data, riskFilter, deptFilter]);

  const groupedByRisk = useMemo(() => {
    const high = filteredEmployees.filter((e) => e.risk_level === "high");
    const medium = filteredEmployees.filter((e) => e.risk_level === "medium");
    const low = filteredEmployees.filter((e) => e.risk_level === "low");
    return { high, medium, low };
  }, [filteredEmployees]);

  const renderEmployeeCard = (emp: EmployeeRiskSummary) => (
    <div
      key={emp.user_id}
      style={{
        padding: 20,
        borderRadius: 16,
        borderLeft: `4px solid ${
          emp.risk_level === "high" ? "#F54C5C" : emp.risk_level === "medium" ? "#F7A046" : "#27C39D"
        }`,
        backgroundColor: "#fff",
        marginBottom: 12,
        cursor: "pointer",
        transition: "background-color 0.2s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "#FAFBFC";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "#fff";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: "#0f1419" }}>
            {emp.user_name}
            <span style={{ fontSize: 13, fontWeight: 400, color: "#72808a", marginLeft: 8 }}>
              {emp.department}
            </span>
          </div>
          <div style={{ fontSize: 14, color: "#333", marginBottom: 8 }}>{emp.summary_text}</div>
          <Space wrap>
            {emp.risk_reasons.map((r, i) => (
              <Tag
                key={i}
                color={r.severity === "high" ? "red" : r.severity === "medium" ? "orange" : "green"}
                style={{ marginRight: 4, marginBottom: 4, pointerEvents: "none" }}
              >
                {r.description} ({r.count})
              </Tag>
            ))}
          </Space>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 16 }}>
          <RiskBadge level={emp.risk_level} />
          <div style={{ fontSize: 24, fontWeight: 700, color: "#F54C5C", marginTop: 8 }}>
            {emp.risk_score}
          </div>
          <div style={{ fontSize: 12, color: "#999" }}>风险分</div>
        </div>
      </div>
      <Divider style={{ margin: "8px 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "#666" }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span>
            <IconMapPin style={{ marginRight: 4 }} />
            {emp.visit_count} 次拜访
          </span>
          <span>
            <IconClock style={{ marginRight: 4 }} />
            {Math.round(emp.total_stop_minutes)} 分钟停留
          </span>
          <span>{emp.total_distance_km.toFixed(1)} km</span>
        </div>
        <button
          onClick={() => {
            window.location.href = `/dashboard?user=${emp.user_id}&date=${dayjs(date).format("YYYY-MM-DD")}`;
          }}
          style={{
            backgroundColor: "#F6F8FC",
            color: "#0f1419",
            border: "none",
            borderRadius: 8,
            padding: "4px 12px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          查看轨迹
        </button>
      </div>
    </div>
  );

  return (
    <div>
      {/* Title */}
      <div style={{ marginBottom: 24 }}>
        <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          销售外勤行为决策系统
        </Title>
        <Text type="tertiary" style={{ fontSize: 14 }}>帮助管理者 10 秒内发现今日风险员工</Text>
        <div style={{ marginTop: 8, fontSize: 13, color: "#72808a" }}>
          点击员工卡片可跳转控制台查看详情与轨迹
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-6" style={{ marginBottom: 16 }}>
        <DatePicker
          value={date}
          onChange={(d) => {
            if (d) {
              const newDate = d as Date;
              setDate(newDate);
              const params = new URLSearchParams(searchParams);
              params.set("date", dayjs(newDate).format("YYYY-MM-DD"));
              setSearchParams(params);
            }
          }}
          style={{ width: 160 }}
        />
        <Select
          value={riskFilter}
          onChange={(v) => setRiskFilter(v as any)}
          style={{ width: 120 }}
          optionList={[
            { value: "all", label: "全部风险" },
            { value: "high", label: "高风险" },
            { value: "medium", label: "可疑" },
            { value: "low", label: "正常" },
          ]}
        />
        <Select
          value={deptFilter}
          onChange={(v) => setDeptFilter(v as any)}
          style={{ width: 140 }}
          optionList={[
            { value: "all", label: "全部部门" },
            ...departments.map((d) => ({ value: d, label: d })),
          ]}
        />
        <button
          onClick={loadData}
          disabled={loading}
          style={{
            backgroundColor: "#EBECED",
            color: "#0f1419",
            border: "none",
            borderRadius: 8,
            padding: "6px 16px",
            fontSize: 14,
            fontWeight: 500,
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.6 : 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "background-color 0.2s",
          }}
          onMouseEnter={(e) => {
            if (!loading) e.currentTarget.style.backgroundColor = "#E6E7E8";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "#EBECED";
          }}
        >
          <IconSearch />
          {loading ? "查询中..." : "查询"}
        </button>
      </div>

      {/* Stats */}
      {data && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={8}>
            <div
              style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16, cursor: "pointer" }}
              onClick={() => navigate(`/dashboard?risk=high&date=${dayjs(date).format("YYYY-MM-DD")}`)}
            >
              <div style={{ fontSize: 14, color: "#72808a", marginBottom: 4 }}>🔴 高风险员工</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#F54C5C" }}>
                {data.high_risk_count}
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div
              style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16, cursor: "pointer" }}
              onClick={() => navigate(`/dashboard?risk=medium&date=${dayjs(date).format("YYYY-MM-DD")}`)}
            >
              <div style={{ fontSize: 14, color: "#72808a", marginBottom: 4 }}>🟡 可疑员工</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#F7A046" }}>
                {data.medium_risk_count}
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div
              style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16, cursor: "pointer" }}
              onClick={() => navigate(`/dashboard?risk=low&date=${dayjs(date).format("YYYY-MM-DD")}`)}
            >
              <div style={{ fontSize: 14, color: "#72808a", marginBottom: 4 }}>🟢 正常员工</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: "#27C39D" }}>
                {data.low_risk_count}
              </div>
            </div>
          </Col>
        </Row>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: "#999" }}>正在计算风险分数...</div>
        </div>
      )}

      {/* Employee Lists */}
      {!loading && data && (
        <>
          {groupedByRisk.high.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <Title heading={4} style={{ color: "#F54C5C", marginBottom: 12, fontWeight: 600 }}>
                🔴 高风险员工
              </Title>
              {groupedByRisk.high.map(renderEmployeeCard)}
            </div>
          )}
          {groupedByRisk.medium.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <Title heading={4} style={{ color: "#F7A046", marginBottom: 12, fontWeight: 600 }}>
                🟡 可疑员工
              </Title>
              {groupedByRisk.medium.map(renderEmployeeCard)}
            </div>
          )}
          {groupedByRisk.low.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <Title heading={4} style={{ color: "#27C39D", marginBottom: 12, fontWeight: 600 }}>
                🟢 正常员工
              </Title>
              {groupedByRisk.low.map(renderEmployeeCard)}
            </div>
          )}
          {filteredEmployees.length === 0 && (
            <Empty description="暂无数据" />
          )}
        </>
      )}
    </div>
  );
}

export default DecisionPage;
