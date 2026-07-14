import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DatePicker,
  Button,
  Tag,
  Typography,
  Spin,
  Row,
  Col,
  Modal,
  Select,
  Table,
  Card,
} from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import {
  fetchRiskSummary,
  fetchRiskSummaryRange,
  fetchRegionalOverview,
  fetchDepartments,
  RegionalOverviewResponse,
  RiskSummaryResponse,
  EmployeeRiskSummary,
} from "../api";
import HeatMapContainer from "../components/HeatMapContainer";

const { Title, Text } = Typography;

type RiskLevel = "high" | "medium" | "low";
type DateRangeMode = "today" | "yesterday" | "week" | "month" | "custom";

function getWeekRange(): { start: string; end: string } {
  const today = dayjs.tz();
  // 计算本周一（中国习惯）
  const day = today.day(); // 0=周日, 1=周一, ...
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = today.add(mondayOffset, "day").startOf("day");
  const yesterday = today.subtract(1, "day").startOf("day");
  return {
    start: monday.format("YYYY-MM-DD"),
    end: yesterday.format("YYYY-MM-DD"),
  };
}

function getMonthRange(): { start: string; end: string } {
  const today = dayjs.tz();
  const firstDay = today.startOf("month");
  const yesterday = today.subtract(1, "day");
  return { start: firstDay.format("YYYY-MM-DD"), end: yesterday.format("YYYY-MM-DD") };
}

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

  // 从 URL 初始化模式与范围
  const initialMode = (searchParams.get("mode") as DateRangeMode) || "yesterday";
  const initialDate = searchParams.get("date");
  const initialStart = searchParams.get("start");
  const initialEnd = searchParams.get("end");

  const [mode, setMode] = useState<DateRangeMode>(initialMode);
  const [date, setDate] = useState<Date>(() => {
    if (initialDate) return new Date(initialDate);
    if (initialMode === "today") return new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  });
  const [customRange, setCustomRange] = useState<Date[]>(() => {
    if (initialStart && initialEnd) {
      return [new Date(initialStart), new Date(initialEnd)];
    }
    const yesterday = dayjs.tz().subtract(1, "day").toDate();
    return [yesterday, yesterday];
  });

  const [data, setData] = useState<RiskSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // 弹窗状态
  const [modalVisible, setModalVisible] = useState(false);
  const [modalLevel, setModalLevel] = useState<RiskLevel | null>(null);

  // 区域拜访热力图状态（独立日期范围）
  const [regionalData, setRegionalData] = useState<RegionalOverviewResponse | null>(null);
  const [regionalLoading, setRegionalLoading] = useState(false);
  const [regionalDepartment, setRegionalDepartment] = useState<string>("all");
  const [regionalRange, setRegionalRange] = useState<Date[]>(() => {
    const yesterday = dayjs.tz().subtract(1, "day").toDate();
    return [yesterday, yesterday];
  });
  const [allDepartments, setAllDepartments] = useState<string[]>([]);

  // 当前生效的查询范围
  const currentRange = useMemo<{ start: string; end: string; isRange: boolean }>(() => {
    if (mode === "today") {
      const d = dayjs.tz(date).format("YYYY-MM-DD");
      return { start: d, end: d, isRange: false };
    }
    if (mode === "yesterday") {
      const d = dayjs.tz(date).format("YYYY-MM-DD");
      return { start: d, end: d, isRange: false };
    }
    if (mode === "week") {
      return { ...getWeekRange(), isRange: true };
    }
    if (mode === "month") {
      return { ...getMonthRange(), isRange: true };
    }
    if (customRange.length === 2) {
      return {
        start: dayjs.tz(customRange[0]).format("YYYY-MM-DD"),
        end: dayjs.tz(customRange[1]).format("YYYY-MM-DD"),
        isRange: true,
      };
    }
    const d = dayjs.tz(date).format("YYYY-MM-DD");
    return { start: d, end: d, isRange: false };
  }, [mode, date, customRange]);

  const loadData = async () => {
    setLoading(true);
    try {
      const { start, end, isRange } = currentRange;
      if (isRange && start > end) {
        setData({
          date: `${start} ~ ${end}`,
          start_date: start,
          end_date: end,
          total_employees: 0,
          high_risk_count: 0,
          medium_risk_count: 0,
          low_risk_count: 0,
          employees: [],
          from_cache: true,
        });
        return;
      }
      let res: RiskSummaryResponse;
      if (isRange) {
        res = await fetchRiskSummaryRange(start, end);
      } else {
        res = await fetchRiskSummary(start);
      }
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, date, customRange]);

  // 加载区域拜访热力图数据
  const loadRegionalData = async () => {
    if (regionalRange.length !== 2) return;
    setRegionalLoading(true);
    try {
      const start = dayjs.tz(regionalRange[0]).format("YYYY-MM-DD");
      const end = dayjs.tz(regionalRange[1]).format("YYYY-MM-DD");
      const res = await fetchRegionalOverview(
        start,
        end,
        regionalDepartment
      );
      setRegionalData(res);
    } finally {
      setRegionalLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments().then(setAllDepartments);
  }, []);

  useEffect(() => {
    loadRegionalData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionalRange, regionalDepartment]);

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
          // 下钻到控制台统一使用单日视图，范围为选中的最后一天
          const drillDate = currentRange.end;
          window.open(
            `/console?user=${emp.user_id}&date=${drillDate}`,
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
          <span>{Math.round(emp.total_distance_km)} km</span>
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
      <div style={{ marginBottom: 12 }}>
        <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          销售外勤行为分析系统
        </Title>
        <Text type="tertiary" style={{ fontSize: 14 }}>
          帮助管理者 10 秒内发现今日风险员工
        </Text>
      </div>

      {/* Filter Bar */}
      <div style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 12 }}>
          {[
            { key: "today", label: "今天" },
            { key: "yesterday", label: "昨天" },
            { key: "week", label: "本周" },
            { key: "month", label: "本月" },
            { key: "custom", label: "自定义" },
          ].map((btn) => {
            const active = mode === btn.key;
            return (
              <Button
                key={btn.key}
                theme={active ? "solid" : "light"}
                type={active ? "primary" : "tertiary"}
                onClick={() => {
                  const newMode = btn.key as DateRangeMode;
                  setMode(newMode);
                  const params = new URLSearchParams(searchParams);
                  params.set("mode", newMode);

                  if (newMode === "today") {
                    const d = dayjs.tz().toDate();
                    setDate(d);
                    params.set("date", dayjs.tz(d).format("YYYY-MM-DD"));
                    params.delete("start");
                    params.delete("end");
                  } else if (newMode === "yesterday") {
                    const d = dayjs.tz().subtract(1, "day").toDate();
                    setDate(d);
                    params.set("date", dayjs.tz(d).format("YYYY-MM-DD"));
                    params.delete("start");
                    params.delete("end");
                  } else if (newMode === "week") {
                    const { start, end } = getWeekRange();
                    params.set("start", start);
                    params.set("end", end);
                    params.delete("date");
                  } else if (newMode === "month") {
                    const { start, end } = getMonthRange();
                    params.set("start", start);
                    params.set("end", end);
                    params.delete("date");
                  } else if (newMode === "custom" && customRange.length === 2) {
                    params.set("start", dayjs.tz(customRange[0]).format("YYYY-MM-DD"));
                    params.set("end", dayjs.tz(customRange[1]).format("YYYY-MM-DD"));
                    params.delete("date");
                  }
                  setSearchParams(params);
                }}
              >
                {btn.label}
              </Button>
            );
          })}
          {mode === "custom" && (
            <DatePicker
              type="dateRange"
              value={customRange as any}
              onChange={(range) => {
                const r = range as Date[] | null;
                if (r && r[0] && r[1]) {
                  setCustomRange([r[0], r[1]]);
                  const params = new URLSearchParams(searchParams);
                  params.set("start", dayjs.tz(r[0]).format("YYYY-MM-DD"));
                  params.set("end", dayjs.tz(r[1]).format("YYYY-MM-DD"));
                  params.delete("date");
                  setSearchParams(params);
                }
              }}
              style={{ width: 280 }}
            />
          )}
          <Button
            icon={<IconSearch />}
            onClick={loadData}
            loading={loading}
            theme="light"
            type="primary"
          >
            查询
          </Button>
        </div>

        {(() => {
          if (mode === "week") {
            return (
              <div style={{ fontSize: 13, color: "#F7A046" }}>
                提示：本周统计不包含今天
              </div>
            );
          }
          if (mode === "month") {
            return (
              <div style={{ fontSize: 13, color: "#F7A046" }}>
                提示：本月统计不包含今天
              </div>
            );
          }
          if (mode === "custom" && customRange.length === 2) {
            const today = dayjs.tz().startOf("day");
            const end = dayjs.tz(customRange[1]).startOf("day");
            if (end.isSame(today) || end.isAfter(today)) {
              return (
                <div style={{ fontSize: 13, color: "#F7A046" }}>
                  提示：范围包含今天，部分数据为实时计算，结果可能随数据更新变化
                </div>
              );
            }
          }
          if (!loading && data && data.total_employees === 0) {
            return (
              <div style={{ fontSize: 13, color: "#999" }}>
                当前范围暂无数据
              </div>
            );
          }
          return null;
        })()}
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

      {/* Regional Visit Heat Map */}
      {!loading && data && (
        <div style={{ marginTop: 32 }}>
          <Title heading={3} style={{ marginBottom: 16, fontWeight: 600 }}>
            区域拜访分析
          </Title>

          {/* Filter Area */}
          <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
            <DatePicker
              type="dateRange"
              value={regionalRange}
              onChange={(range) => {
                const r = range as Date[] | null;
                if (r && r[0] && r[1]) {
                  setRegionalRange([r[0], r[1]]);
                }
              }}
              style={{ width: 280 }}
            />
            <Select
              style={{ width: 260 }}
              value={regionalDepartment}
              onChange={(value) => setRegionalDepartment(value as string)}
              optionList={[
                { value: "all", label: "全部部门" },
                ...allDepartments.map((name) => {
                  const stat = regionalData?.departments.find((d) => d.name === name);
                  return {
                    value: name,
                    label: stat
                      ? `${name} (${stat.visitCount}次 / ${stat.employeeCount}人)`
                      : name,
                  };
                }),
              ]}
              loading={regionalLoading}
            />
          </div>

          {/* Heat Map + Department Table */}
          <Row gutter={16}>
            <Col span={16}>
              <Card
                title="区域拜访热力图"
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ padding: 12, height: 520 }}
                loading={regionalLoading}
              >
                <HeatMapContainer points={regionalData?.heatMapPoints ?? []} />
              </Card>
            </Col>
            <Col span={8}>
              <Card
                title="部门分布"
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ paddingTop: 12, height: 520, overflow: "auto" }}
                loading={regionalLoading}
              >
                <Table
                  dataSource={regionalData?.departments ?? []}
                  columns={[
                    {
                      title: "部门 / 区域",
                      dataIndex: "name",
                      render: (text: string, record: any) => {
                        const key = record.key as string;
                        const isSub = key.includes("-");
                        const params = new URLSearchParams();
                        params.set("scope", isSub ? "sub_department" : "department");
                        params.set("node", key);
                        const start = dayjs.tz(regionalRange[0]).format("YYYY-MM-DD");
                        const end = dayjs.tz(regionalRange[1]).format("YYYY-MM-DD");
                        params.set("start", start);
                        params.set("end", end);
                        return (
                          <a
                            href={`/console?${params.toString()}`}
                            onClick={(e) => {
                              e.preventDefault();
                              window.open(`/console?${params.toString()}`, "_blank");
                            }}
                          >
                            <Tag style={{ cursor: "pointer" }}>{text}</Tag>
                          </a>
                        );
                      },
                    },
                    {
                      title: "拜访次数",
                      dataIndex: "visitCount",
                      sorter: (a: any, b: any) => a.visitCount - b.visitCount,
                    },
                    {
                      title: "涉及员工",
                      dataIndex: "employeeCount",
                    },
                  ]}
                  rowKey="name"
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
          </Row>
        </div>
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
