import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Row, Col, Table, Spin, Typography, Tag, Tooltip } from "@douyinfe/semi-ui";
import { IconInfoCircle } from "@douyinfe/semi-icons";
import dayjs from "dayjs";
import { fetchOrgOverview, OrgOverviewResponse, OrgRankingItem } from "../api";
import HeatMapContainer from "./HeatMapContainer";
import ProvinceBarChart from "./ProvinceBarChart";
import { statLabelStyle, statValueStyle } from "./statStyles";
import { Suspense, lazy } from "react";
import { useIsMobile } from "../hooks/useIsMobile";

const OverviewChart = lazy(() => import("./OverviewChart"));

const { Title } = Typography;

interface OrgQueryPanelProps {
  scope: "company" | "department" | "sub_department";
  nodeName: string;
  start: string;
  end: string;
}

function formatKm(value: number): string {
  return `${Math.round(value)}`;
}

function buildConsoleHref(record: OrgRankingItem, start: string, end: string): string {
  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  if (record.level === "person") {
    params.set("user", record.key);
  } else {
    params.set("scope", record.level === "department" ? "department" : "sub_department");
    params.set("node", record.key);
  }
  return `/console?${params.toString()}`;
}

/**
 * 「较昨日」环比徽标：previous 为 null/0（昨日无数据）时不显示。
 * 三段式：箭头与 ±% 带涨跌色（升绿降红），「较昨日」文字为灰色。
 */
function DeltaBadge({ current, previous }: { current: number; previous: number | null }) {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const up = pct >= 0;
  return (
    <span className={`delta-badge ${up ? "up" : "down"}`}>
      <span className="delta-badge-arrow">{up ? "▲" : "▼"}</span>
      <span className="delta-badge-label">较昨日</span>
      <span className="delta-badge-value">
        {up ? "+" : ""}{pct.toFixed(1)}%
      </span>
    </span>
  );
}

function OrgQueryPanel({ scope, nodeName, start, end }: OrgQueryPanelProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OrgOverviewResponse | null>(null);
  // 单日模式下的前一天数据（用于 KPI 卡「较昨日」环比徽标）；多日/个人视角不请求
  const [prevDayData, setPrevDayData] = useState<OrgOverviewResponse | null>(null);
  // 移动端（<768px）：指标卡 2×2、图表卡单列
  const isMobile = useIsMobile();

  // 行内展开状态
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [childMap, setChildMap] = useState<Record<string, OrgRankingItem[]>>({});
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set());

  // 当查询条件变化时重置展开状态
  const initializedDataRef = useRef<OrgOverviewResponse | null>(null);
  useEffect(() => {
    setExpandedKeys(new Set());
    setChildMap({});
    setLoadingChildren(new Set());
    initializedDataRef.current = null;
  }, [scope, nodeName, start, end]);

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
      accompany_count: d.accompanyCount,
      reported_distance_km: d.reportedKm,
      estimated_distance_km: Math.round(d.estimatedKm),
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

  // 默认展开“销售部”
  useEffect(() => {
    if (!data || initializedDataRef.current === data) return;
    initializedDataRef.current = data;
    const sales = data.ranking.find((r) => r.name === "销售部" && r.hasChildren);
    if (!sales) return;
    setExpandedKeys(new Set([sales.key]));
    if (childMap[sales.key] || loadingChildren.has(sales.key)) return;
    setLoadingChildren((prev) => {
      const next = new Set(prev);
      next.add(sales.key);
      return next;
    });
    const childScope = sales.level === "department" ? "department" : "sub_department";
    fetchOrgOverview(childScope, sales.key, start, end)
      .then((res) => {
        setChildMap((prev) => ({ ...prev, [sales.key]: res.ranking }));
      })
      .catch((err) => {
        console.error("Failed to load children for 销售部:", err);
      })
      .finally(() => {
        setLoadingChildren((prev) => {
          const next = new Set(prev);
          next.delete(sales.key);
          return next;
        });
      });
  }, [data, childMap, loadingChildren, start, end]);

  const dayCount = useMemo(() => {
    const s = dayjs.tz(start);
    const e = dayjs.tz(end);
    return e.diff(s, "day") + 1;
  }, [start, end]);

  const isSingleDay = dayCount === 1;

  // 单日模式：额外拉取前一天总览，供「较昨日」环比徽标使用；昨日无数据/请求失败则不显示
  useEffect(() => {
    if (!isSingleDay) {
      setPrevDayData(null);
      return;
    }
    const prevDay = dayjs.tz(start).subtract(1, "day").format("YYYY-MM-DD");
    let cancelled = false;
    fetchOrgOverview(scope, nodeName, prevDay, prevDay)
      .then((res) => {
        if (!cancelled) setPrevDayData(res);
      })
      .catch(() => {
        if (!cancelled) setPrevDayData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, nodeName, start, isSingleDay]);

  const visitFrequency = useMemo(() => {
    if (!data || dayCount <= 0) return "0";
    return (data.stats.totalVisits / dayCount).toFixed(2);
  }, [data, dayCount]);

  const avgVisitsPerEmployee = useMemo(() => {
    if (!data || data.stats.totalEmployees === 0) return "0";
    return (data.stats.totalVisits / data.stats.totalEmployees).toFixed(2);
  }, [data]);

  const customerCoverage = useMemo(() => {
    if (!data) return "0";
    return String(data.stats.totalCustomers);
  }, [data]);

  // 「较昨日」环比基数：仅单日模式取前一天数据；昨日无数据/为 0 时徽标自动隐藏
  const prevStats = isSingleDay ? prevDayData?.stats ?? null : null;
  const prevReportedKm = prevStats ? prevStats.totalReportedKm : null;
  const prevTotalVisits = prevStats ? prevStats.totalVisits : null;
  const prevAvgVisitsPerEmployee =
    prevStats && prevStats.totalEmployees > 0
      ? prevStats.totalVisits / prevStats.totalEmployees
      : null;
  const prevCustomers = prevStats ? prevStats.totalCustomers : null;

  // 懒加载下一级数据
  const loadChildren = useCallback(
    async (record: OrgRankingItem) => {
      if (record.level === "person" || childMap[record.key] || loadingChildren.has(record.key)) {
        return;
      }
      const childScope = record.level === "department" ? "department" : "sub_department";

      setLoadingChildren((prev) => {
        const next = new Set(prev);
        next.add(record.key);
        return next;
      });

      try {
        const res = await fetchOrgOverview(childScope, record.key, start, end);
        setChildMap((prev) => ({ ...prev, [record.key]: res.ranking }));
      } catch (err) {
        console.error("Failed to load children for", record.key, err);
      } finally {
        setLoadingChildren((prev) => {
          const next = new Set(prev);
          next.delete(record.key);
          return next;
        });
      }
    },
    [childMap, loadingChildren, start, end]
  );

  const handleExpand = useCallback(
    (expanded?: boolean, record?: any) => {
      if (!record || !record.key) return;
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (expanded) {
          next.add(record.key);
          loadChildren(record as OrgRankingItem);
        } else {
          next.delete(record.key);
        }
        return next;
      });
    },
    [loadChildren]
  );

  // 名称列按层级缩进：每深一级缩进 20px
  const getNameIndent = useCallback(
    (record: OrgRankingItem) => {
      const levelOrder = ["company", "department", "sub_department", "person"];
      const levelIndex = levelOrder.indexOf(record.level);
      const scopeIndex = levelOrder.indexOf(scope);
      return Math.max(0, levelIndex - scopeIndex - 1) * 20;
    },
    [scope]
  );

  const getRelativeLevel = useCallback(
    (record: OrgRankingItem) => {
      const levelOrder = ["company", "department", "sub_department", "person"];
      const levelIndex = levelOrder.indexOf(record.level);
      const scopeIndex = levelOrder.indexOf(scope);
      return Math.max(0, levelIndex - scopeIndex - 1);
    },
    [scope]
  );

  // 名称列：普通文本 + 层级字重/颜色（父级稍粗深色、子级常规），人员行用品牌紫链接
  const renderName = useCallback(
    (record: OrgRankingItem) => {
      const href = buildConsoleHref(record, start, end);
      const levelClass = `ranking-name-level-${Math.min(getRelativeLevel(record), 2)}`;
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            window.open(href, "_blank");
          }}
        >
          {record.level === "person" ? (
            <span style={{ color: "var(--primary)" }}>{record.name}</span>
          ) : (
            <span className={levelClass}>{record.name}</span>
          )}
        </a>
      );
    },
    [start, end, getRelativeLevel]
  );

  // 名称列内容最大宽度：固定列宽 150 - 左右 padding 32 - 缩进 - 展开图标 12 - 图标与文字间距 8
  const getNameMaxWidth = useCallback(
    (record: OrgRankingItem) => {
      const indent = getNameIndent(record);
      const iconWidth = record.hasChildren ? 12 : 0;
      const gap = record.hasChildren ? 8 : 0;
      return 150 - 32 - indent - iconWidth - gap;
    },
    [getNameIndent]
  );

  const rankingColumns = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        width: 150,
        render: (_: any, record: OrgRankingItem) => (
          <div
            style={{
              display: "inline-block",
              maxWidth: getNameMaxWidth(record),
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "middle",
            }}
          >
            {renderName(record)}
          </div>
        ),
      },
      {
        title: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            拜访次数
            <Tooltip content="括号内为陪同拜访次数（填写了陪同对象的打卡点数）">
              <IconInfoCircle style={{ color: "#999", cursor: "default" }} />
            </Tooltip>
          </span>
        ),
        dataIndex: "visitCount",
        width: 108,
        align: "left" as const,
        className: "num-cell",
        sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
          (a?.visitCount ?? 0) - (b?.visitCount ?? 0),
        render: (_: any, record: OrgRankingItem) => (
          <span style={{ whiteSpace: "nowrap" }}>
            {record.visitCount}
            {record.accompanyCount > 0 && (
              <span style={{ color: "#999" }}>（{record.accompanyCount}）</span>
            )}
          </span>
        ),
      },
      {
        title: "填报/估算里程",
        dataIndex: "reportedKm",
        align: "left" as const,
        className: "num-cell",
        render: (_: any, record: OrgRankingItem) => (
          <span style={{ whiteSpace: "nowrap" }}>
            {formatKm(record.reportedKm)}
            <span style={{ color: "#999", margin: "0 6px" }}>/</span>
            {formatKm(record.estimatedKm)}
          </span>
        ),
        sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
          (a?.reportedKm ?? 0) - (b?.reportedKm ?? 0),
      },
      {
        title: "风险标签",
        dataIndex: "riskTags",
        className: "risk-tag-cell",
        render: (_: any, record: OrgRankingItem) => {
          const allTags = [
            { key: "hasLowVisitCount" as const, label: "拜访量不足", color: "purple" as const },
            { key: "hasDuplicateLocation" as const, label: "重复签到", color: "cyan" as const },
            { key: "hasMileageDeviation" as const, label: "里程偏差", color: "red" as const },
            { key: "hasMileageReadingInvalid" as const, label: "填报异常", color: "orange" as const },
          ].filter((t) => record[t.key]);

          const visibleTags = allTags.slice(0, 2);
          const hiddenTags = allTags.slice(2);

          return (
            <div style={{ display: "flex", flexWrap: "nowrap", gap: 4 }}>
              {visibleTags.map((t) => (
                <Tag key={t.key} size="small" color={t.color} style={{ marginRight: 0, flexShrink: 0 }}>
                  {t.label}
                </Tag>
              ))}
              {hiddenTags.length > 0 && (
                <Tooltip content={hiddenTags.map((t) => t.label).join("、")}>
                  <Tag
                    size="small"
                    style={{
                      backgroundColor: "transparent",
                      border: "1px solid var(--border-default)",
                      color: "var(--text-tertiary)",
                      marginRight: 0,
                      flexShrink: 0,
                    }}
                  >
                    +{hiddenTags.length}
                  </Tag>
                </Tooltip>
              )}
            </div>
          );
        },
      },
    ],
    [renderName, getNameIndent, getNameMaxWidth]
  );

  const expandedRowRender = useCallback(
    (record?: OrgRankingItem) => {
      if (!record) return null;
      const children = childMap[record.key];
      if (loadingChildren.has(record.key) || !children) {
        return (
          <div style={{ padding: "8px 0 8px 4px" }}>
            <Spin size="small" />
          </div>
        );
      }
      return (
        <div style={{ width: "100%" }}>
          <Table
            columns={rankingColumns}
            dataSource={children}
            pagination={false}
            rowKey="key"
            size="small"
            showHeader={false}
            expandedRowRender={expandedRowRender}
            rowExpandable={(r?: OrgRankingItem) => !!r?.hasChildren}
            expandedRowKeys={Array.from(expandedKeys)}
            onExpand={handleExpand}
            onRow={(r?: OrgRankingItem) => ({
              className: r ? `ranking-row-level-${getRelativeLevel(r)}` : "",
            })}
          />
        </div>
      );
    },
    [childMap, loadingChildren, rankingColumns, expandedKeys, handleExpand, getRelativeLevel]
  );

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
      {/* KPI 指标区：一整块白卡 + 竖向细分隔线；单日模式显示「较昨日」环比徽标 */}
      <div className="kpi-strip">
        <div className="kpi-item">
          <span style={statLabelStyle}>填报 / 估算里程</span>
          <span style={statValueStyle}>
            <span>{stats.totalReportedKm}</span>
            <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>/</span>
            <span>{Math.round(stats.totalEstimatedKm)}</span>
            <span style={{ fontSize: 12, color: "#999" }}>km</span>
          </span>
          <DeltaBadge current={stats.totalReportedKm} previous={prevReportedKm} />
        </div>
        <div className="kpi-item">
          <span style={statLabelStyle}>拜访频率</span>
          <span style={statValueStyle}>
            {visitFrequency}
            <span style={{ fontSize: 12, color: "#999" }}>次/天</span>
          </span>
          <DeltaBadge current={stats.totalVisits} previous={prevTotalVisits} />
        </div>
        <div className="kpi-item">
          <span style={statLabelStyle}>人均拜访次数</span>
          <span style={statValueStyle}>
            {avgVisitsPerEmployee}
            <span style={{ fontSize: 12, color: "#999" }}>次/人</span>
          </span>
          <DeltaBadge
            current={stats.totalEmployees > 0 ? stats.totalVisits / stats.totalEmployees : 0}
            previous={prevAvgVisitsPerEmployee}
          />
        </div>
        <div className="kpi-item">
          <span style={statLabelStyle}>客户覆盖数</span>
          <span style={statValueStyle}>
            {customerCoverage}
            <span style={{ fontSize: 12, color: "#999" }}>个客户</span>
          </span>
          <DeltaBadge current={stats.totalCustomers} previous={prevCustomers} />
        </div>
      </div>

      {/* 拜访热力图 + 排行榜；移动端单列堆叠 */}
      <Row gutter={16} style={{ marginBottom: 16, ...(isMobile ? { rowGap: 16 } : {}) }}>
        <Col span={isMobile ? 24 : 12}>
          <div
            className="panel-bordered"
            style={{
              padding: "var(--card-padding)",
              height: isMobile ? 340 : 400,
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
        <Col span={isMobile ? 24 : 12}>
          <div
            className="org-ranking-card panel-bordered"
            style={{
              padding: "var(--card-padding)",
              height: isMobile ? 340 : 400,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Title heading={6} style={{ marginBottom: 12 }}>
              {scope === "company" && "部门排行榜"}
              {scope === "department" && "子部门排行榜"}
              {scope === "sub_department" && "人员排行榜"}
            </Title>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden", overflowY: "auto" }}>
              <Table
                columns={rankingColumns}
                dataSource={data.ranking}
                pagination={false}
                rowKey="key"
                size="small"
                  expandedRowRender={expandedRowRender}
                rowExpandable={(record?: OrgRankingItem) => !!record?.hasChildren}
                expandedRowKeys={Array.from(expandedKeys)}
                onExpand={handleExpand}
                onRow={(record?: OrgRankingItem) => ({
                  className: record ? `ranking-row-level-${getRelativeLevel(record)}` : "",
                })}
              />
            </div>
          </div>
        </Col>
      </Row>

      {/* 趋势分析 + 拜访省份分布；移动端单列堆叠 */}
      <Row gutter={16} style={{ marginBottom: 16, ...(isMobile ? { rowGap: 16 } : {}) }}>
        {!isSingleDay && (
          <Col span={isMobile ? 24 : 12}>
            <div
              className="panel-bordered"
              style={{
                padding: "var(--card-padding)",
                height: isMobile ? 300 : 340,
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
          </Col>
        )}
        <Col span={isMobile ? 24 : isSingleDay ? 24 : 12}>
          <div
            className="panel-bordered"
            style={{
              padding: "var(--card-padding)",
              height: isMobile ? 300 : 340,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Title heading={6} style={{ marginBottom: 12 }}>
              拜访省份分布
            </Title>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ProvinceBarChart data={data?.provinceDistribution ?? []} />
            </div>
          </div>
        </Col>
      </Row>
    </div>
  );
}

export default OrgQueryPanel;
