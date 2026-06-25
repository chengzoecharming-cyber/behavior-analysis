import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DatePicker,
  Select,
  Tag,
  Typography,
  Empty,
  Spin,
  Row,
  Col,
  Pagination,
} from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import { fetchRiskSummary, RiskSummaryResponse, EmployeeRiskSummary } from "../api";

const { Title, Text } = Typography;

const levelConfig = {
  high: { color: "#F54C5C", label: "高风险" },
  medium: { color: "#F7A046", label: "可疑" },
  low: { color: "#27C39D", label: "正常" },
};

const PAGE_SIZE = 12;

const riskTypeLabels: Record<string, string> = {
  low_visit_count: "拜访量不足",
  duplicate_location: "重复签到",
  mileage_deviation: "里程偏差",
  long_stop: "停留过长",
  route_detour: "路径绕行",
  long_idle: "长时间未移动",
  invalid_trip_type: "异常出行方式",
  missing_special_reason: "特殊签到缺原因",
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
  const [currentPage, setCurrentPage] = useState(1);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetchRiskSummary(dayjs(date).format("YYYY-MM-DD"));
      setData(res);
      setCurrentPage(1);
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

  const pagedEmployees = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredEmployees.slice(start, start + PAGE_SIZE);
  }, [filteredEmployees, currentPage]);

  const renderEmployeeCard = (emp: EmployeeRiskSummary) => {
    const cfg = levelConfig[emp.risk_level];
    return (
      <Col key={emp.user_id} span={6}>
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
            minHeight: 160,
            cursor: "pointer",
            transition: "all 0.2s ease",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: cfg.color,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 16, fontWeight: 600, color: "#0f1419" }}>
                {emp.user_name}
              </span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: cfg.color }}>
              {emp.risk_score}
            </div>
          </div>

          {/* Risk tags */}
          <div style={{ marginTop: 12, flex: 1 }}>
            <Row gutter={[8, 8]}>
              {emp.risk_reasons.slice(0, 4).map((r, i) => (
                <Col span={12} key={i}>
                  <Tag
                    size="small"
                    color={
                      r.severity === "high" ? "red" : r.severity === "medium" ? "orange" : "green"
                    }
                    style={{ width: "100%", textAlign: "center", marginRight: 0 }}
                  >
                    {riskTypeLabels[r.type] || r.type}
                    {r.count > 1 ? `(${r.count})` : ""}
                  </Tag>
                </Col>
              ))}
              {emp.risk_reasons.length > 4 && (
                <Col span={12}>
                  <Tag size="small" style={{ width: "100%", textAlign: "center", marginRight: 0 }}>
                    +{emp.risk_reasons.length - 4}
                  </Tag>
                </Col>
              )}
            </Row>
          </div>

          {/* Footer stats */}
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #f0f0f0",
              fontSize: 12,
              color: "#888",
              display: "flex",
              gap: 12,
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

  const renderStatCard = (
    level: "high" | "medium" | "low",
    count: number
  ) => {
    const cfg = levelConfig[level];
    const isActive = riskFilter === level;
    return (
      <div
        onClick={() => setRiskFilter(isActive ? "all" : level)}
        style={{
          padding: 20,
          backgroundColor: isActive ? cfg.color : "#fff",
          borderRadius: 16,
          cursor: "pointer",
          transition: "all 0.2s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
        }}
      >
        <div style={{ fontSize: 14, color: isActive ? "rgba(255,255,255,0.8)" : "#72808a", marginBottom: 4 }}>
          {cfg.label}
        </div>
        <div style={{ fontSize: 32, fontWeight: 700, color: isActive ? "#fff" : cfg.color }}>
          {count}
        </div>
      </div>
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
          <Col span={8}>{renderStatCard("high", data.high_risk_count)}</Col>
          <Col span={8}>{renderStatCard("medium", data.medium_risk_count)}</Col>
          <Col span={8}>{renderStatCard("low", data.low_risk_count)}</Col>
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
            <>
              <Row gutter={[16, 16]}>
                {pagedEmployees.map(renderEmployeeCard)}
              </Row>
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                <Pagination
                  currentPage={currentPage}
                  pageSize={PAGE_SIZE}
                  total={filteredEmployees.length}
                  onPageChange={(page: number) => setCurrentPage(page)}
                  showSizeChanger={false}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default DecisionPage;
