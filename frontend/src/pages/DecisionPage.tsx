import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DatePicker,
  Select,
  Badge,
  Tag,
  Typography,
  Empty,
  Spin,
  Row,
  Col,
  Space,
} from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import { fetchRiskSummary, RiskSummaryResponse, EmployeeRiskSummary } from "../api";

const { Title, Text } = Typography;

const levelConfig = {
  high: { color: "#F54C5C", bg: "#FFF2F0", label: "高" },
  medium: { color: "#F7A046", bg: "#FFF7E6", label: "中" },
  low: { color: "#27C39D", bg: "#F0FFF9", label: "低" },
};

function DecisionPage() {
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

  const renderEmployeeCard = (emp: EmployeeRiskSummary) => {
    const cfg = levelConfig[emp.risk_level];
    return (
      <Col key={emp.user_id} xs={24} sm={12} lg={8} xxl={6}>
        <div
          onClick={() => {
            window.location.href = `/dashboard?user=${emp.user_id}&date=${dayjs(date).format(
              "YYYY-MM-DD"
            )}`;
          }}
          style={{
            backgroundColor: "#fff",
            borderRadius: 12,
            padding: 16,
            cursor: "pointer",
            transition: "all 0.2s ease",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
            e.currentTarget.style.transform = "translateY(-2px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <Space align="center">
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: cfg.color,
                  display: "inline-block",
                }}
              />
              <span style={{ fontSize: 16, fontWeight: 600, color: "#0f1419" }}>
                {emp.user_name}
              </span>
              <Text type="tertiary" size="small">
                {emp.department}
              </Text>
            </Space>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: cfg.color }}>
                {emp.risk_score}
              </div>
              <div style={{ fontSize: 12, color: "#999" }}>风险分</div>
            </div>
          </div>

          {/* Risk count & tags */}
          <div style={{ marginTop: 12 }}>
            <Space wrap>
              <Badge
                count={`${emp.anomaly_count} 个异常`}
                style={{
                  backgroundColor: cfg.bg,
                  color: cfg.color,
                  fontSize: 12,
                  fontWeight: 500,
                }}
              />
              {emp.risk_reasons.slice(0, 3).map((r, i) => (
                <Tag
                  key={i}
                  size="small"
                  color={
                    r.severity === "high" ? "red" : r.severity === "medium" ? "orange" : "green"
                  }
                  style={{ marginRight: 0 }}
                >
                  {r.type === "low_visit_count"
                    ? "拜访量不足"
                    : r.type === "duplicate_location"
                    ? "重复签到"
                    : r.type === "mileage_deviation"
                    ? "里程偏差"
                    : r.type === "long_stop"
                    ? "停留过长"
                    : r.type === "route_detour"
                    ? "路径绕行"
                    : r.type === "long_idle"
                    ? "长时间未移动"
                    : r.type === "invalid_trip_type"
                    ? "异常出行方式"
                    : r.type === "missing_special_reason"
                    ? "特殊签到缺原因"
                    : r.type}
                  {r.count > 1 ? `(${r.count})` : ""}
                </Tag>
              ))}
              {emp.risk_reasons.length > 3 && (
                <Tag size="small" style={{ marginRight: 0 }}>
                  +{emp.risk_reasons.length - 3}
                </Tag>
              )}
            </Space>
          </div>

          {/* Footer stats */}
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #f0f0f0",
              fontSize: 13,
              color: "#666",
              display: "flex",
              gap: 16,
            }}
          >
            <span>{emp.visit_count} 次拜访</span>
            <span>{Math.round(emp.total_stop_minutes)} 分钟停留</span>
            <span>{emp.total_distance_km.toFixed(1)} km</span>
          </div>
        </div>
      </Col>
    );
  };

  return (
    <div>
      {/* Title */}
      <div style={{ marginBottom: 24 }}>
        <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          销售外勤行为决策系统
        </Title>
        <Text type="tertiary" style={{ fontSize: 14 }}>
          帮助管理者 10 秒内发现今日风险员工
        </Text>
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
              style={{
                padding: 20,
                backgroundColor: levelConfig.high.bg,
                borderRadius: 16,
                cursor: "pointer",
              }}
              onClick={() => setRiskFilter("high")}
            >
              <div style={{ fontSize: 14, color: levelConfig.high.color, marginBottom: 4 }}>
                高风险员工
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: levelConfig.high.color }}>
                {data.high_risk_count}
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div
              style={{
                padding: 20,
                backgroundColor: levelConfig.medium.bg,
                borderRadius: 16,
                cursor: "pointer",
              }}
              onClick={() => setRiskFilter("medium")}
            >
              <div style={{ fontSize: 14, color: levelConfig.medium.color, marginBottom: 4 }}>
                可疑员工
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: levelConfig.medium.color }}>
                {data.medium_risk_count}
              </div>
            </div>
          </Col>
          <Col span={8}>
            <div
              style={{
                padding: 20,
                backgroundColor: levelConfig.low.bg,
                borderRadius: 16,
                cursor: "pointer",
              }}
              onClick={() => setRiskFilter("low")}
            >
              <div style={{ fontSize: 14, color: levelConfig.low.color, marginBottom: 4 }}>
                正常员工
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: levelConfig.low.color }}>
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

      {/* Employee Grid */}
      {!loading && data && (
        <>
          {filteredEmployees.length === 0 ? (
            <Empty description="暂无数据" />
          ) : (
            <Row gutter={[16, 16]}>
              {filteredEmployees.map(renderEmployeeCard)}
            </Row>
          )}
        </>
      )}
    </div>
  );
}

export default DecisionPage;
