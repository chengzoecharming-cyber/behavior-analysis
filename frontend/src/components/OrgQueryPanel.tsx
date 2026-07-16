import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Row, Col, Table, Spin, Typography, Tag } from "@douyinfe/semi-ui";
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

function OrgQueryPanel({ scope, nodeName, start, end }: OrgQueryPanelProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OrgOverviewResponse | null>(null);

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

  const visitFrequency = useMemo(() => {
    if (!data || dayCount <= 0) return "0";
    return (data.stats.totalVisits / dayCount).toFixed(2);
  }, [data, dayCount]);

  const estimatedFuelCost = useMemo(() => {
    if (!data) return "0.00";
    return (data.stats.totalEstimatedKm * 0.8).toFixed(2);
  }, [data]);

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

  const renderName = useCallback(
    (record: OrgRankingItem) => {
      const href = buildConsoleHref(record, start, end);
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            window.open(href, "_blank");
          }}
        >
          {record.level === "person" ? (
            <span style={{ color: "#0066ff" }}>{record.name}</span>
          ) : (
            <Tag style={{ cursor: "pointer" }}>{record.name}</Tag>
          )}
        </a>
      );
    },
    [start, end]
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

  // 名称列内容最大宽度：固定列宽 170 - 左右 padding 32 - 缩进 - 展开图标 12 - 图标与文字间距 8
  const getNameMaxWidth = useCallback(
    (record: OrgRankingItem) => {
      const indent = getNameIndent(record);
      const iconWidth = record.hasChildren ? 12 : 0;
      const gap = record.hasChildren ? 8 : 0;
      return 170 - 32 - indent - iconWidth - gap;
    },
    [getNameIndent]
  );

  const rankingColumns = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        width: 170,
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
        title: "拜访次数",
        dataIndex: "visitCount",
        width: 110,
        sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
          (a?.visitCount ?? 0) - (b?.visitCount ?? 0),
      },
      {
        title: "填报/估算里程",
        dataIndex: "reportedKm",
        render: (_: any, record: OrgRankingItem) => (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Tag
              size="small"
              style={{
                backgroundColor: "#f5f5f5",
                border: "1px solid #d9d9d9",
                color: "#333333",
                fontSize: 12,
              }}
            >
              {formatKm(record.reportedKm)}
            </Tag>
            <span style={{ color: "#999" }}>/</span>
            <Tag
              size="small"
              style={{
                backgroundColor: "#f5f5f5",
                border: "1px solid #d9d9d9",
                color: "#333333",
                fontSize: 12,
              }}
            >
              {formatKm(record.estimatedKm)}
            </Tag>
          </div>
        ),
        sorter: (a?: OrgRankingItem, b?: OrgRankingItem) =>
          (a?.reportedKm ?? 0) - (b?.reportedKm ?? 0),
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
        <div>
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

      {/* 趋势图：仅时间段展示 */}
      {!isSingleDay && (
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
      )}

      {/* 热力图 + 排行榜 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={14}>
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
        <Col span={10}>
          <div
            className="org-ranking-card"
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
    </div>
  );
}

export default OrgQueryPanel;
