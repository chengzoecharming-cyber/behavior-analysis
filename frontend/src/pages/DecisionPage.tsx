import { useEffect, useState, useMemo, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Typography, Spin, Row, Col, Card } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import {
  fetchCompanyDashboard,
  fetchCurrentUser,
  CompanyDashboardResponse,
} from "../api";
// 图表组件懒加载：vchart 体积 2MB+，延后加载让页面骨架先渲染
const EmployeeWordCloud = lazy(() => import("../components/EmployeeWordCloud"));
const DepartmentRadarChart = lazy(() => import("../components/DepartmentRadarChart"));
const VisitCountTrendChart = lazy(() => import("../components/VisitCountTrendChart"));
const MileageAreaChart = lazy(() => import("../components/MileageAreaChart"));

// 图表加载中的占位，保持卡片高度避免布局跳动
const chartFallback = (
  <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <Spin />
  </div>
);
import {
  getCurrentBusinessWeekRange,
  getPreviousBusinessWeekRange,
  getLastTwoWeeksRange,
  getLastThreeWeeksRange,
  getLastMonthRange,
} from "../utils/businessPeriod";

const { Title, Text } = Typography;

type DateRangeMode =
  | "current_week"
  | "last_week"
  | "last_two_weeks"
  | "last_three_weeks"
  | "last_month";

const DATE_RANGE_PRESETS = [
  { key: "current_week", label: "本周" },
  { key: "last_week", label: "上周" },
  { key: "last_two_weeks", label: "过去两周" },
  { key: "last_three_weeks", label: "过去三周" },
  { key: "last_month", label: "上月" },
];

function getPresetRange(key: DateRangeMode): [string, string] {
  switch (key) {
    case "current_week":
      return getCurrentBusinessWeekRange();
    case "last_week":
      return getPreviousBusinessWeekRange();
    case "last_two_weeks":
      return getLastTwoWeeksRange();
    case "last_three_weeks":
      return getLastThreeWeeksRange();
    case "last_month":
      return getLastMonthRange();
    default:
      return getCurrentBusinessWeekRange();
  }
}

const statStyle: React.CSSProperties = {
  padding: 20,
  backgroundColor: "#fff",
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  height: "100%",
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

function DecisionPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const initialMode = (searchParams.get("mode") as DateRangeMode) || "last_month";
  const [mode, setMode] = useState<DateRangeMode>(initialMode);

  const [data, setData] = useState<CompanyDashboardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // 总览页所有角色可看全量数据，但只有 admin 可以点击内容跳转（员工卡片 → 控制台）
  const [isAdmin, setIsAdmin] = useState(false);

  const [start, end] = useMemo(() => getPresetRange(mode), [mode]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetchCompanyDashboard(start, end);
      setData(res);
    } catch (err) {
      console.error("Failed to load company dashboard:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    fetchCurrentUser()
      .then((me) => setIsAdmin(me.role === "admin"))
      .catch(() => setIsAdmin(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleModeChange = (newMode: DateRangeMode) => {
    setMode(newMode);
    const params = new URLSearchParams(searchParams);
    params.set("mode", newMode);
    setSearchParams(params);
  };

  const handleEmployeeClick = (employee: { userId: string; userName: string }) => {
    const params = new URLSearchParams();
    params.set("user", employee.userId);
    params.set("start", start);
    params.set("end", end);
    window.open(`/console?${params.toString()}`, "_blank");
  };

  return (
    <div>
      {/* Title */}
      <div style={{ marginBottom: 12 }}>
        <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          销售外勤行为分析系统
        </Title>
        <Text type="tertiary" style={{ fontSize: 14 }}>
          公司级 Dashboard：快速掌握外勤整体情况与风险分布
        </Text>
      </div>

      {/* Filter Bar */}
      <div style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 12 }}>
          {DATE_RANGE_PRESETS.map((btn) => {
            const active = mode === btn.key;
            return (
              <Button
                key={btn.key}
                theme={active ? "solid" : "light"}
                type={active ? "primary" : "tertiary"}
                onClick={() => handleModeChange(btn.key as DateRangeMode)}
              >
                {btn.label}
              </Button>
            );
          })}
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

        <div style={{ fontSize: 13, color: "#999" }}>
          统计周期：{start} ~ {end}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: "#999" }}>正在加载公司数据...</div>
        </div>
      )}

      {!loading && data && (
        <>
          {/* Summary Cards */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>总拜访次数</span>
                <span style={statValueStyle}>
                  {data.summary.totalVisits}
                  <span style={{ fontSize: 12, color: "#999" }}>次</span>
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>活跃员工数</span>
                <span style={statValueStyle}>
                  {data.summary.activeEmployees}
                  <span style={{ fontSize: 12, color: "#999" }}>人</span>
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>客户覆盖数</span>
                <span style={statValueStyle}>
                  {data.summary.customerCoverage}
                  <span style={{ fontSize: 12, color: "#999" }}>个客户</span>
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>平均拜访频率</span>
                <span style={statValueStyle}>
                  {data.summary.avgVisitFrequency}
                  <span style={{ fontSize: 12, color: "#999" }}>次/人/周</span>
                </span>
              </div>
            </Col>
          </Row>

          {/* Weekly Trend: Visits + Mileage */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <Card
                title="周拜访趋势"
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ padding: 12, height: 500 }}
              >
                <Suspense fallback={chartFallback}>
                  <VisitCountTrendChart data={data.weeklyTrend} />
                </Suspense>
              </Card>
            </Col>
            <Col span={12}>
              <Card
                title="周里程趋势"
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ padding: 12, height: 500 }}
              >
                <Suspense fallback={chartFallback}>
                  <MileageAreaChart data={data.weeklyTrend} />
                </Suspense>
              </Card>
            </Col>
          </Row>

          {/* Employee Word Cloud + Department Radar */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <Card
                title="员工活跃度"
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ padding: 12, height: 500 }}
              >
                {data.employeeWordCloud.length === 0 ? (
                  <div style={{ color: "#999", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    暂无员工数据
                  </div>
                ) : (
                  <Suspense fallback={chartFallback}>
                    <EmployeeWordCloud
                      data={data.employeeWordCloud}
                      onClick={isAdmin ? handleEmployeeClick : undefined}
                    />
                  </Suspense>
                )}
              </Card>
            </Col>
            <Col span={12}>
              <Card
                title={
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: "#1f2329" }}>
                      部门对比
                    </div>
                    <div style={{ fontSize: 12, color: "#999", fontWeight: 400, marginTop: 4 }}>
                      各维度已按部门最大值归一化，悬停查看原始值
                    </div>
                  </div>
                }
                headerLine={false}
                headerStyle={{ paddingBottom: 0 }}
                bodyStyle={{ padding: 12, height: 500 }}
              >
                {data.departmentRadar.length === 0 ? (
                  <div style={{ color: "#999", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    暂无部门数据
                  </div>
                ) : (
                  <Suspense fallback={chartFallback}>
                    <DepartmentRadarChart data={data.departmentRadar} />
                  </Suspense>
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

export default DecisionPage;
