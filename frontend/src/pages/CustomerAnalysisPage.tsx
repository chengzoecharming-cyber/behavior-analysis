import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Progress,
  Segmented,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import {
  fetchCrmCross,
  fetchCrmFunnel,
  fetchCrmOpportunityMap,
  fetchCrmOverview,
  fetchCrmPoolHealth,
  fetchCrmRecoveryList,
  fetchCrmStuck,
  fetchCrmWordCloud,
  fetchCurrentUser,
} from "../api";
import type {
  CrmCrossItem,
  CrmCrossResponse,
  CrmCrossType,
  CrmFunnelResponse,
  CrmOpportunityMapResponse,
  CrmOverview,
  CrmPoolHealthResponse,
  CrmPoolHealthRow,
  CrmRecoveryItem,
  CrmRecoveryListResponse,
  CrmStuckItem,
  CrmStuckResponse,
  CrmStuckKind,
  CrmWordCloudItem,
} from "../types";
import FollowWordCloud from "../components/crm/FollowWordCloud";
import CustomerMap from "../components/crm/CustomerMap";

const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  enterprise_domestic: "国内企业",
  agent_domestic: "国内代理商",
  terminal_overseas: "海外终端",
  agent_overseas: "海外代理商",
};

const CROSS_TYPE_LABELS: Record<CrmCrossType, string> = {
  follow_only: "只跟不访",
  visit_only: "只访不跟",
  both: "都有跟进与拜访",
  unmatched: "待确认（未匹配到 CRM）",
};

const STUCK_KIND_LABELS: Record<CrmStuckKind, string> = {
  approval_stuck: "审批卡死",
  zombie: "躺尸客户",
};

/** 公海挽回关注的高阶段（与后端 RECOVERY_STAGES 一致） */
const RECOVERY_STAGES = ["方案/报价", "已发合同", "合同回传", "付款/发货", "已经交付"];

/** 阶段漏斗展示顺序：按业务推进顺序，其余状态（含无阶段）归「其他」列在最后（「初步接触\拜访」是 CRM 里的原始值） */
const FUNNEL_STAGE_ORDER = ["初步接触\\拜访", "初步意向", "方案/报价", "已发合同", "合同回传", "付款/发货", "已经交付"];

export default function CustomerAnalysisPage() {
  const [overview, setOverview] = useState<CrmOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [funnel, setFunnel] = useState<CrmFunnelResponse | null>(null);

  // 「公海挽回」Tab 仅 admin 可见
  const [isAdmin, setIsAdmin] = useState(false);

  const [crossType, setCrossType] = useState<CrmCrossType>("follow_only");
  const [cross, setCross] = useState<CrmCrossResponse | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossPage, setCrossPage] = useState(1);
  const [crossPageSize, setCrossPageSize] = useState(20);

  const [words, setWords] = useState<CrmWordCloudItem[]>([]);
  const [wordsLoading, setWordsLoading] = useState(true);

  const [stuckKind, setStuckKind] = useState<CrmStuckKind>("approval_stuck");
  const [stuck, setStuck] = useState<CrmStuckResponse | null>(null);
  const [stuckLoading, setStuckLoading] = useState(false);
  const [stuckPage, setStuckPage] = useState(1);
  const [stuckPageSize, setStuckPageSize] = useState(20);

  // 机会地图数据量大且后端限流解析坐标，切到该 Tab 时才首次加载
  const [mapData, setMapData] = useState<CrmOpportunityMapResponse | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapRequested, setMapRequested] = useState(false);

  // 公海挽回（admin）
  const [recoveryStage, setRecoveryStage] = useState("");
  const [recoveryOwner, setRecoveryOwner] = useState("");
  const [recovery, setRecovery] = useState<CrmRecoveryListResponse | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryPage, setRecoveryPage] = useState(1);
  const [recoveryPageSize, setRecoveryPageSize] = useState(20);

  // 私海健康度
  const [poolHealth, setPoolHealth] = useState<CrmPoolHealthResponse | null>(null);
  const [poolHealthLoading, setPoolHealthLoading] = useState(false);

  useEffect(() => {
    fetchCrmOverview()
      .then(setOverview)
      .catch(() => message.error("总览数据加载失败"))
      .finally(() => setOverviewLoading(false));
    fetchCrmWordCloud()
      .then(setWords)
      .catch(() => message.error("词云数据加载失败"))
      .finally(() => setWordsLoading(false));
    fetchCrmFunnel()
      .then(setFunnel)
      .catch(() => message.error("阶段漏斗加载失败"));
    setPoolHealthLoading(true);
    fetchCrmPoolHealth()
      .then(setPoolHealth)
      .catch(() => message.error("私海健康度加载失败"))
      .finally(() => setPoolHealthLoading(false));
    fetchCurrentUser()
      .then((me) => setIsAdmin(me.role === "admin"))
      .catch(() => setIsAdmin(false));
  }, []);

  const loadCross = useCallback(async (type: CrmCrossType, page: number, pageSize: number) => {
    setCrossLoading(true);
    try {
      setCross(await fetchCrmCross(type, page, pageSize));
    } catch {
      message.error("交叉数据加载失败");
    } finally {
      setCrossLoading(false);
    }
  }, []);

  const loadStuck = useCallback(async (kind: CrmStuckKind, page: number, pageSize: number) => {
    setStuckLoading(true);
    try {
      setStuck(await fetchCrmStuck(kind, page, pageSize));
    } catch {
      message.error("躺尸/卡死数据加载失败");
    } finally {
      setStuckLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCross(crossType, crossPage, crossPageSize);
  }, [crossType, crossPage, crossPageSize, loadCross]);

  useEffect(() => {
    loadStuck(stuckKind, stuckPage, stuckPageSize);
  }, [stuckKind, stuckPage, stuckPageSize, loadStuck]);

  const loadRecovery = useCallback(
    async (stage: string, owner: string, page: number, pageSize: number) => {
      setRecoveryLoading(true);
      try {
        setRecovery(await fetchCrmRecoveryList(stage, owner, page, pageSize));
      } catch {
        message.error("公海挽回清单加载失败");
      } finally {
        setRecoveryLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!isAdmin) return;
    loadRecovery(recoveryStage, recoveryOwner, recoveryPage, recoveryPageSize);
  }, [isAdmin, recoveryStage, recoveryOwner, recoveryPage, recoveryPageSize, loadRecovery]);

  const loadMap = useCallback(async () => {
    setMapLoading(true);
    try {
      const data = await fetchCrmOpportunityMap();
      setMapData(data);
      if (data.geocoded_new > 0) {
        message.info(`本次新解析 ${data.geocoded_new} 条坐标，继续点击刷新可补全剩余客户`);
      }
    } catch {
      message.error("机会地图数据加载失败");
    } finally {
      setMapLoading(false);
    }
  }, []);

  const onTabChange = (key: string) => {
    if (key === "map" && !mapRequested) {
      setMapRequested(true);
      loadMap();
    }
  };

  const geocodedCount = useMemo(
    () => mapData?.list.filter((it) => it.lat != null && it.lng != null).length ?? 0,
    [mapData]
  );

  const overviewTab = (
    <Spin spinning={overviewLoading}>
      {overview && (
        <>
          {overview.snapshot_date && (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
              CRM 数据快照：{overview.snapshot_date}（手工导出导入，非实时）
            </Typography.Text>
          )}
          <Row gutter={[16, 16]}>
            <Col xs={12} md={8} lg={4}>
              <Card><Statistic title="客户总数" value={overview.total} /></Card>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Card><Statistic title="私海客户" value={overview.private_count} valueStyle={{ color: "#1677ff" }} /></Card>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Card><Statistic title="公海客户" value={overview.pool_count} valueStyle={{ color: "#fa8c16" }} /></Card>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Card>
                <Statistic
                  title="未跟进占比"
                  value={overview.unfollowed_ratio * 100}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: overview.unfollowed_ratio > 0.3 ? "#cf1322" : undefined }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {overview.unfollowed_count} 家从未跟进
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Card><Statistic title="审批中" value={overview.approving_count} /></Card>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Card><Statistic title="近 30 天新增" value={overview.new_30d_count} valueStyle={{ color: "#52c41a" }} /></Card>
            </Col>
          </Row>
          <Card title="客户类型分布" style={{ marginTop: 16 }}>
            <Space size="large" wrap>
              {Object.entries(overview.by_type).map(([key, n]) => (
                <Statistic
                  key={key}
                  title={CUSTOMER_TYPE_LABELS[key] ?? key}
                  value={n}
                />
              ))}
              {Object.keys(overview.by_type).length === 0 && (
                <Typography.Text type="secondary">暂无类型数据</Typography.Text>
              )}
            </Space>
          </Card>
          {funnel && (
            <Card
              title="阶段漏斗"
              style={{ marginTop: 16 }}
              extra={
                funnel.snapshot_date && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    快照 {funnel.snapshot_date}
                  </Typography.Text>
                )
              }
            >
              {(() => {
                // 按业务推进顺序排列；其余状态（含无阶段）合并为「其他」列在最后
                const byStage = new Map(funnel.stages.map((s) => [s.stage, s]));
                const ordered = FUNNEL_STAGE_ORDER.filter((s) => byStage.has(s)).map((s) => byStage.get(s)!);
                const others = funnel.stages.filter((s) => !FUNNEL_STAGE_ORDER.includes(s.stage));
                if (others.length > 0) {
                  ordered.push({
                    stage: "其他",
                    private_count: others.reduce((a, s) => a + s.private_count, 0),
                    pool_count: others.reduce((a, s) => a + s.pool_count, 0),
                  });
                }
                const maxTotal = Math.max(1, ...ordered.map((s) => s.private_count + s.pool_count));
                return ordered.map((s) => (
                  <div key={s.stage} style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ width: 88, flexShrink: 0 }}>{s.stage}</div>
                    <div style={{ flex: 1, display: "flex", height: 18 }}>
                      <div
                        style={{
                          width: `${((s.private_count / maxTotal) * 100).toFixed(2)}%`,
                          minWidth: s.private_count > 0 ? 2 : 0,
                          background: "#1677ff",
                          borderRadius: "2px 0 0 2px",
                        }}
                      />
                      <div
                        style={{
                          width: `${((s.pool_count / maxTotal) * 100).toFixed(2)}%`,
                          minWidth: s.pool_count > 0 ? 2 : 0,
                          background: "#fa8c16",
                          borderRadius: "0 2px 2px 0",
                        }}
                      />
                    </div>
                    <div style={{ width: 140, flexShrink: 0, textAlign: "right", fontSize: 12 }}>
                      <span style={{ color: "#1677ff" }}>私海 {s.private_count}</span>
                      {" / "}
                      <span style={{ color: "#fa8c16" }}>公海 {s.pool_count}</span>
                    </div>
                  </div>
                ));
              })()}
            </Card>
          )}
        </>
      )}
    </Spin>
  );

  const crossColumns = [
    { title: "客户名称", dataIndex: "customer_name", key: "customer_name" },
    {
      title: "CRM 跟进次数",
      dataIndex: "follow_count",
      key: "follow_count",
      width: 140,
      sorter: (a: CrmCrossItem, b: CrmCrossItem) => a.follow_count - b.follow_count,
    },
    {
      title: "实际拜访次数",
      dataIndex: "visit_count",
      key: "visit_count",
      width: 140,
      sorter: (a: CrmCrossItem, b: CrmCrossItem) => a.visit_count - b.visit_count,
    },
    { title: "负责人/拜访人", dataIndex: "owner_name", key: "owner_name", width: 200, render: (v: string | null) => v || "-" },
    {
      title: "来源",
      dataIndex: "in_crm",
      key: "in_crm",
      width: 100,
      render: (inCrm: boolean) =>
        inCrm ? <Tag color="blue">CRM</Tag> : <Tag color="purple">仅拜访记录</Tag>,
    },
  ];

  const crossTab = (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card><Statistic title="只跟不访（有跟进无拜访）" value={cross?.only_follow_count ?? "-"} valueStyle={{ color: "#faad14" }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="只访不跟（有拜访无跟进）" value={cross?.only_visit_count ?? "-"} valueStyle={{ color: "#722ed1" }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="跟进与拜访都有" value={cross?.both_count ?? "-"} valueStyle={{ color: "#52c41a" }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="待确认（未匹配到 CRM）" value={cross?.unmatched_count ?? "-"} valueStyle={{ color: "#8c8c8c" }} /></Card>
        </Col>
      </Row>
      <Card
        style={{ marginTop: 16 }}
        title="客户明细"
        extra={
          <Segmented
            value={crossType}
            onChange={(v) => {
              setCrossType(v as CrmCrossType);
              setCrossPage(1);
            }}
            options={(Object.keys(CROSS_TYPE_LABELS) as CrmCrossType[]).map((k) => ({
              label: CROSS_TYPE_LABELS[k],
              value: k,
            }))}
          />
        }
      >
        <Table<CrmCrossItem>
          rowKey={(r) => `${r.customer_name}|${r.in_crm}`}
          loading={crossLoading}
          columns={crossColumns}
          dataSource={cross?.list ?? []}
          pagination={{
            current: crossPage,
            pageSize: crossPageSize,
            total: cross?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 家客户`,
            onChange: (p, ps) => {
              setCrossPage(p);
              setCrossPageSize(ps);
            },
          }}
        />
      </Card>
    </>
  );

  const wordCloudTab = (
    <Card title="跟进纪要词频（领域词典 + 高频二元组）">
      <Spin spinning={wordsLoading}>
        <FollowWordCloud data={words} height={420} />
      </Spin>
    </Card>
  );

  const stuckColumns = [
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (kind: CrmStuckKind) =>
        kind === "approval_stuck" ? (
          <Tag color="red">审批卡死</Tag>
        ) : (
          <Tag color="orange">躺尸客户</Tag>
        ),
    },
    { title: "客户名称", dataIndex: "customer_name", key: "customer_name" },
    { title: "负责人", dataIndex: "owner_name", key: "owner_name", width: 140, render: (v: string | null) => v || "-" },
    { title: "状态", dataIndex: "status", key: "status", width: 140, render: (v: string | null) => v || "-" },
    {
      title: "滞留天数",
      dataIndex: "days",
      key: "days",
      width: 110,
      sorter: (a: CrmStuckItem, b: CrmStuckItem) => a.days - b.days,
      render: (d: number) => `${d} 天`,
    },
    {
      title: "最近拜访",
      dataIndex: "last_visit_time",
      key: "last_visit_time",
      width: 120,
      render: (v: string | null) => (v ? v.slice(0, 10) : "-"),
    },
  ];

  const stuckTab = (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card><Statistic title="审批卡死（审批中超 7 天）" value={stuck?.approval_stuck_count ?? "-"} valueStyle={{ color: "#cf1322" }} /></Card>
        </Col>
        <Col xs={24} md={12}>
          <Card><Statistic title="躺尸客户（私海超 30 天未跟进）" value={stuck?.zombie_count ?? "-"} valueStyle={{ color: "#fa8c16" }} /></Card>
        </Col>
      </Row>
      <Card
        style={{ marginTop: 16 }}
        title="明细清单"
        extra={
          <Segmented
            value={stuckKind}
            onChange={(v) => {
              setStuckKind(v as CrmStuckKind);
              setStuckPage(1);
            }}
            options={(Object.keys(STUCK_KIND_LABELS) as CrmStuckKind[]).map((k) => ({
              label: STUCK_KIND_LABELS[k],
              value: k,
            }))}
          />
        }
      >
        <Table<CrmStuckItem>
          rowKey={(r) => `${r.kind}|${r.customer_id}`}
          loading={stuckLoading}
          columns={stuckColumns}
          dataSource={stuck?.list ?? []}
          pagination={{
            current: stuckPage,
            pageSize: stuckPageSize,
            total: stuck?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setStuckPage(p);
              setStuckPageSize(ps);
            },
          }}
        />
      </Card>
    </>
  );

  const recoveryColumns = [
    { title: "客户名称", dataIndex: "name", key: "name" },
    {
      title: "阶段",
      dataIndex: "follow_status",
      key: "follow_status",
      width: 110,
      render: (v: string) => {
        const color =
          v === "合同回传" ? "green" : v === "已发合同" ? "geekblue" : v === "方案/报价" ? "gold" : "default";
        return <Tag color={color}>{v}</Tag>;
      },
    },
    { title: "最后负责人", dataIndex: "last_owner", key: "last_owner", width: 110, render: (v: string | null) => v || "-" },
    {
      title: "退回时间",
      dataIndex: "return_pool_time",
      key: "return_pool_time",
      width: 110,
      render: (v: string | null) => (v ? v.slice(0, 10) : "-"),
    },
    { title: "退回原因", dataIndex: "return_pool_reason", key: "return_pool_reason", ellipsis: true, render: (v: string | null) => v || "-" },
    {
      title: "最近跟进",
      dataIndex: "latest_follow_up_time",
      key: "latest_follow_up_time",
      width: 110,
      render: (v: string | null) => (v ? v.slice(0, 10) : "-"),
    },
    {
      title: "累计掉保次数",
      dataIndex: "return_pool_times",
      key: "return_pool_times",
      width: 120,
      render: (v: number | null) => v ?? "-",
    },
    { title: "区域", dataIndex: "region", key: "region", width: 100, render: (v: string | null) => v || "-" },
  ];

  const recoveryTab = (
    <>
      <Row gutter={[16, 16]}>
        {RECOVERY_STAGES.map((s) => (
          <Col xs={12} md={4} key={s}>
            <Card>
              <Statistic
                title={s}
                value={recovery?.summary?.[s] ?? "-"}
                valueStyle={{ color: s === "合同回传" ? "#52c41a" : s === "已发合同" ? "#1677ff" : "#faad14" }}
              />
            </Card>
          </Col>
        ))}
      </Row>
      <Card
        style={{ marginTop: 16 }}
        title="公海挽回清单（高阶段被掉保客户，按离成交距离排序）"
        extra={
          <Space>
            <Segmented
              value={recoveryStage}
              onChange={(v) => {
                setRecoveryStage(v as string);
                setRecoveryPage(1);
              }}
              options={[
                { label: "全部阶段", value: "" },
                ...RECOVERY_STAGES.map((s) => ({ label: s, value: s })),
              ]}
            />
            <Input.Search
              placeholder="按最后负责人搜索"
              allowClear
              style={{ width: 180 }}
              onSearch={(v) => {
                setRecoveryOwner(v.trim());
                setRecoveryPage(1);
              }}
            />
          </Space>
        }
      >
        <Table<CrmRecoveryItem>
          rowKey={(r) => `${r.name}|${r.follow_status}`}
          loading={recoveryLoading}
          columns={recoveryColumns}
          dataSource={recovery?.list ?? []}
          pagination={{
            current: recoveryPage,
            pageSize: recoveryPageSize,
            total: recovery?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 家客户`,
            onChange: (p, ps) => {
              setRecoveryPage(p);
              setRecoveryPageSize(ps);
            },
          }}
        />
      </Card>
    </>
  );

  const poolHealthColumns = [
    { title: "负责人", dataIndex: "owner_name", key: "owner_name", width: 120 },
    { title: "私海数", dataIndex: "private_count", key: "private_count", width: 90, sorter: (a: CrmPoolHealthRow, b: CrmPoolHealthRow) => a.private_count - b.private_count },
    {
      title: "零跟进数",
      dataIndex: "zero_follow_count",
      key: "zero_follow_count",
      width: 100,
      sorter: (a: CrmPoolHealthRow, b: CrmPoolHealthRow) => a.zero_follow_count - b.zero_follow_count,
      render: (v: number, r: CrmPoolHealthRow) => (
        <span style={{ color: r.private_count > 0 && v / r.private_count > 0.8 ? "#cf1322" : undefined }}>{v}</span>
      ),
    },
    { title: "30 天无跟进", dataIndex: "stale_30d_count", key: "stale_30d_count", width: 110 },
    { title: "历史被掉保数", dataIndex: "dropped_count", key: "dropped_count", width: 120 },
    {
      title: "掉保率",
      dataIndex: "drop_ratio",
      key: "drop_ratio",
      width: 160,
      render: (v: number) => (
        <Progress
          percent={+(v * 100).toFixed(1)}
          size="small"
          status={v > 0.5 ? "exception" : "normal"}
          format={(p) => `${p}%`}
        />
      ),
    },
  ];

  const poolHealthTab = (
    <Spin spinning={poolHealthLoading && !poolHealth}>
      {poolHealth && (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Card><Statistic title="私海总数" value={poolHealth.company.private_count} valueStyle={{ color: "#1677ff" }} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card>
                <Statistic
                  title="零跟进率"
                  value={poolHealth.company.zero_follow_ratio * 100}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: poolHealth.company.zero_follow_ratio > 0.5 ? "#cf1322" : undefined }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {poolHealth.company.zero_follow_count} 家从未跟进
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card>
                <Statistic
                  title="30 天无跟进率"
                  value={poolHealth.company.stale_30d_ratio * 100}
                  precision={1}
                  suffix="%"
                  valueStyle={{ color: poolHealth.company.stale_30d_ratio > 0.5 ? "#cf1322" : undefined }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {poolHealth.company.stale_30d_count} 家超 30 天未跟进
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="累计被掉保（公海）" value={poolHealth.company.dropped_count} valueStyle={{ color: "#fa8c16" }} /></Card>
            </Col>
          </Row>
          <Card title="负责人私海健康度排行（按掉保率降序，>50% 标红）" style={{ marginTop: 16 }}>
            <Table<CrmPoolHealthRow>
              rowKey="owner_name"
              columns={poolHealthColumns}
              dataSource={poolHealth.rows}
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 人` }}
            />
          </Card>
        </>
      )}
    </Spin>
  );

  const mapTab = (
    <Card
      title="客户机会地图"
      extra={
        <Space>
          <Typography.Text type="secondary">
            已解析坐标 {geocodedCount} / {mapData?.total ?? 0}
            {mapData ? `（待解析 ${mapData.pending_count}，解析失败 ${mapData.failed_count}）` : ""}
          </Typography.Text>
          <Button
            icon={<ReloadOutlined />}
            loading={mapLoading}
            onClick={loadMap}
          >
            刷新（继续解析坐标）
          </Button>
        </Space>
      }
    >
      <Spin spinning={mapLoading && !mapData}>
        <div style={{ marginBottom: 8 }}>
          <Space size="middle">
            <Tag color="#1677ff">私海客户</Tag>
            <Tag color="#fa8c16">公海客户</Tag>
            <Typography.Text type="secondary">气泡越大表示实际拜访次数越多</Typography.Text>
          </Space>
        </div>
        <CustomerMap items={mapData?.list ?? []} height={520} />
      </Spin>
    </Card>
  );

  return (
    <div>
      <div className="section-title">
        <Space>
          客户分析
          <Tag color="gold">WIP</Tag>
        </Space>
      </div>
      <Tabs
        defaultActiveKey="overview"
        onChange={onTabChange}
        items={[
          { key: "overview", label: "总览", children: overviewTab },
          { key: "cross", label: "客户×拜访交叉", children: crossTab },
          { key: "wordcloud", label: "沟通词云", children: wordCloudTab },
          { key: "stuck", label: "躺尸与审批卡死", children: stuckTab },
          ...(isAdmin ? [{ key: "recovery", label: "公海挽回", children: recoveryTab }] : []),
          { key: "pool-health", label: "私海健康度", children: poolHealthTab },
          { key: "map", label: "机会地图", children: mapTab },
        ]}
      />
    </div>
  );
}
