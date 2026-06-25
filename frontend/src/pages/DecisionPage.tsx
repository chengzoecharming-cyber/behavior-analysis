import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DatePicker,
  Tag,
  Typography,
  Spin,
  Row,
  Col,
  Modal,
} from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import { fetchRiskSummary, RiskSummaryResponse, EmployeeRiskSummary } from "../api";

const { Title, Text } = Typography;

type RiskLevel = "high" | "medium" | "low";

const levelConfig: Record<RiskLevel, { color: string; bg: string; label: string }> = {
  high: { color: "#F54C5C", bg: "#FFF2F0", label: "高风险" },
  medium: { color: "#F7A046", bg: "#FFFBE6", label: "可疑" },
  low: { color: "#27C39D", bg: "#F0FFF9", label: "正常" },
};

const tagStyleMap: Record<string, React.CSSProperties> = {
  high: { backgroundColor: "#FBE7E4", color: "#751B2F" },
  medium: { backgroundColor: "#FDF4E3", color: "#7A4A0F" },
  low: { backgroundColor: "#E4F7ED", color: "#1D5C3D" },
};

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

  // 弹窗状态
  const [modalVisible, setModalVisible] = useState(false);
  const [modalLevel, setModalLevel] = useState<RiskLevel | null>(null);

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

  const openRiskModal = (level: RiskLevel) => {
    setModalLevel(level);
    setModalVisible(true);
  };

  const closeRiskModal = () => {
    setModalVisible(false);
    setModalLevel(null);
  };

  const modalEmployees = useMemo(() => {
    if (!data || !modalLevel) return [];
    return data.employees.filter((e) => e.risk_level === modalLevel);
  }, [data, modalLevel]);

  const renderRiskTags = (emp: EmployeeRiskSummary) => {
    const tags: React.ReactNode[] = [];
    const reasons = emp.risk_reasons.slice(0, 3);
    const hasMore = emp.risk_reasons.length > 3;

    reasons.forEach((r, i) => {
      tags.push(
        <Tag
          key={i}
          size="small"
          style={{
            ...tagStyleMap[r.severity],
            alignSelf: "flex-start",
            marginRight: 0,
            borderRadius: 4,
          }}
        >
          {riskTypeLabels[r.type] || r.type}
          {r.count > 1 ? `(${r.count})` : ""}
        </Tag>
      );
    });

    if (hasMore) {
      tags.push(
        <Tag
          key="more"
          size="small"
          style={{
            alignSelf: "flex-start",
            marginRight: 0,
            borderRadius: 4,
            backgroundColor: "#f5f5f5",
            color: "#666",
            border: "1px solid #e8e8e8",
          }}
        >
          +{emp.risk_reasons.length - 3}
        </Tag>
      );
    }

    while (tags.length < 3) {
      tags.push(
        <div key={`empty-${tags.length}`} style={{ height: 22, alignSelf: "flex-start" }} />
      );
    }

    return tags;
  };

  const renderEmployeeCard = (emp: EmployeeRiskSummary) => {
    const cfg = levelConfig[emp.risk_level];
    return (
      <div
        key={emp.user_id}
        onClick={() => {
          window.open(
            `/dashboard?user=${emp.user_id}&date=${dayjs(date).format("YYYY-MM-DD")}`,
            "_blank"
          );
        }}
        style={{
          backgroundColor: "#fff",
          borderRadius: 12,
          padding: 16,
          height: 240,
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#0f1419" }}>
            {emp.user_name}
          </span>
          <div style={{ fontSize: 28, fontWeight: 700, color: cfg.color }}>
            {emp.risk_score}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 8,
            marginBottom: 12,
            minHeight: 80,
          }}
        >
          {renderRiskTags(emp)}
        </div>

        <div
          style={{
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
    );
  };

  const renderStatCard = (level: RiskLevel, count: number) => {
    const cfg = levelConfig[level];
    return (
      <div
        onClick={() => openRiskModal(level)}
        style={{
          padding: 20,
          backgroundColor: "#fff",
          borderRadius: 16,
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
        <div style={{ fontSize: 14, color: "#72808a", marginBottom: 4 }}>{cfg.label}</div>
        <div style={{ fontSize: 32, fontWeight: 700, color: cfg.color }}>{count}</div>
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
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-6" style={{ marginBottom: 24 }}>
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

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: "#999" }}>正在计算风险分数...</div>
        </div>
      )}

      {/* Risk Cards */}
      {!loading && data && (
        <Row gutter={16}>
          <Col span={8}>{renderStatCard("high", data.high_risk_count)}</Col>
          <Col span={8}>{renderStatCard("medium", data.medium_risk_count)}</Col>
          <Col span={8}>{renderStatCard("low", data.low_risk_count)}</Col>
        </Row>
      )}

      {/* Risk Detail Modal */}
      <Modal
        title={
          modalLevel ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>{levelConfig[modalLevel].label}</span>
              <Tag
                size="small"
                style={{
                  backgroundColor: "#f0f0f0",
                  color: "#666",
                  border: "none",
                  borderRadius: 4,
                }}
              >
                {modalEmployees.length}人
              </Tag>
            </div>
          ) : (
            ""
          )
        }
        visible={modalVisible}
        onCancel={closeRiskModal}
        footer={null}
        size="large"
        width={1000}
        className="risk-modal"
      >
        <div
          style={{
            fontSize: 13,
            color: "#999",
            marginBottom: 16,
          }}
        >
          提示：分值越高，风险越高
        </div>
        {modalEmployees.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "#999" }}>暂无数据</div>
        ) : (
          <div className="employee-grid">
            {modalEmployees.map(renderEmployeeCard)}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default DecisionPage;
