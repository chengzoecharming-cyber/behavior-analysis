import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  DatePicker,
  Modal,
  Radio,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  CheckCircle,
  Eye,
  History,
  RefreshCw,
  RotateCcw,
  SearchCode,
  Shield,
  Zap,
} from "lucide-react";
import dayjs, { Dayjs } from "dayjs";
import {
  ackSyncAlert,
  fetchSyncAlerts,
  fetchSyncHealth,
  fetchSyncLogs,
  forceSyncDateRange,
  retrySyncLog,
} from "../api";
import { DingTalkSyncLog, SyncAlert, SyncHealthItem } from "../types";
import { DataLineagePanel } from "./DataLineagePage";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const triggeredByMap: Record<string, string> = {
  scheduler: "定时任务",
  manual: "手动同步",
  startup: "启动补齐",
};

const logStatusMap: Record<string, { text: string; color: string }> = {
  success: { text: "成功", color: "success" },
  failed: { text: "失败", color: "error" },
  running: { text: "进行中", color: "processing" },
};

const healthStatusMap: Record<string, { text: string; color: string }> = {
  healthy: { text: "正常", color: "success" },
  warning: { text: "警告", color: "warning" },
  error: { text: "异常", color: "error" },
};

/** 同步范围日期可能是 YYYY-MM-DD 或 ISO 时间戳，统一成 YYYY-MM-DD 显示 */
function fmtDate(v: string): string {
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD") : v;
}

interface OverviewTabProps {
  onViewLineage: (start: string, end: string) => void;
}

/** Tab1 同步概览：同步记录（含对账指标）+ 同步健康 badge + 未处理告警 */
function SyncOverviewTab({ onViewLineage }: OverviewTabProps) {
  const [logs, setLogs] = useState<DingTalkSyncLog[]>([]);
  const [healthItems, setHealthItems] = useState<SyncHealthItem[]>([]);
  const [alerts, setAlerts] = useState<SyncAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [ackLoading, setAckLoading] = useState<number | null>(null);
  const [forceModalOpen, setForceModalOpen] = useState(false);
  const [forceLoading, setForceLoading] = useState(false);
  const [forceRange, setForceRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [logRes, healthRes, alertRes] = await Promise.all([
        fetchSyncLogs(100),
        fetchSyncHealth(14),
        fetchSyncAlerts(false),
      ]);
      setLogs(logRes.logs);
      setHealthItems(healthRes.items);
      setAlerts(alertRes.alerts);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "加载同步数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRetry = async (id: number) => {
    setRetryingId(id);
    try {
      await retrySyncLog(id);
      message.success("已触发重试");
      await loadData();
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || "重试失败");
    } finally {
      setRetryingId(null);
    }
  };

  const handleAck = async (id: number) => {
    setAckLoading(id);
    try {
      await ackSyncAlert(id);
      message.success("已确认处理");
      await loadData();
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || "确认失败");
    } finally {
      setAckLoading(null);
    }
  };

  const handleForceSync = async () => {
    if (!forceRange || !forceRange[0] || !forceRange[1]) {
      message.warning("请选择同步日期范围");
      return;
    }
    setForceLoading(true);
    try {
      await forceSyncDateRange(forceRange[0].format("YYYY-MM-DD"), forceRange[1].format("YYYY-MM-DD"));
      message.success("强制同步已触发");
      setForceModalOpen(false);
      await loadData();
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || "强制同步失败");
    } finally {
      setForceLoading(false);
    }
  };

  // 最近一次同步的健康状态 → 收成标题旁的 badge
  const latestHealth = healthItems[0];
  const unhealthyCount = healthItems.filter((h) => h.healthStatus !== "healthy").length;

  const filteredLogs =
    statusFilter === "all" ? logs : logs.filter((log) => log.status === statusFilter);

  const columns = [
    { title: "ID", dataIndex: "id", width: 60 },
    {
      title: "触发方式",
      dataIndex: "triggered_by",
      width: 100,
      render: (v: string) => triggeredByMap[v] || v,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (v: string) => {
        const { text, color } = logStatusMap[v] || { text: v, color: "default" };
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: "同步范围",
      key: "range",
      width: 190,
      render: (_: unknown, record: DingTalkSyncLog) => (
        <Text>
          {record.start_date} ~ {record.end_date}
        </Text>
      ),
    },
    { title: "审批实例", dataIndex: "total_instances", width: 90 },
    { title: "解析", dataIndex: "parsed_visits", width: 70 },
    { title: "插入", dataIndex: "normalized_inserted", width: 70 },
    {
      title: "对账",
      key: "reconcile",
      width: 150,
      render: (_: unknown, record: DingTalkSyncLog) => {
        const missing = record.missing_count ?? 0;
        const dup = record.duplicate_count ?? 0;
        return (
          <Space size={8}>
            <Text type={missing > 0 ? "danger" : "secondary"}>缺失 {missing}</Text>
            <Text type={dup > 0 ? "warning" : "secondary"}>重复 {dup}</Text>
            {record.parse_failures > 0 && <Text type="danger">解析失败 {record.parse_failures}</Text>}
          </Space>
        );
      },
    },
    {
      title: "开始时间",
      dataIndex: "started_at",
      width: 165,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "耗时",
      key: "duration",
      width: 80,
      render: (_: unknown, record: DingTalkSyncLog) => {
        if (!record.finished_at) return "-";
        const seconds = dayjs(record.finished_at).diff(dayjs(record.started_at), "second");
        return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
      },
    },
    {
      title: "错误信息",
      dataIndex: "error_message",
      ellipsis: true,
      render: (v: string | null) =>
        v ? (
          <Text type="danger" title={v}>
            {v}
          </Text>
        ) : null,
    },
    {
      title: "操作",
      key: "action",
      width: 150,
      render: (_: unknown, record: DingTalkSyncLog) => (
        <Space size={4}>
          <Tooltip title="查看该范围的数据血缘">
            <Button
              size="small"
              type="link"
              icon={<Eye className="h-3 w-3" />}
              onClick={() => onViewLineage(record.start_date, record.end_date)}
            >
              血缘
            </Button>
          </Tooltip>
          {record.status === "failed" && (
            <Button
              size="small"
              type="link"
              icon={<RotateCcw className="h-3 w-3" />}
              loading={retryingId === record.id}
              onClick={() => handleRetry(record.id)}
            >
              重试
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* 健康摘要行 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Space size={12} wrap>
          <Space size={6}>
            <Shield size={16} />
            <Text strong>同步健康</Text>
          </Space>
          {latestHealth ? (
            <>
              <Tag color={healthStatusMap[latestHealth.healthStatus]?.color || "default"}>
                最近：{healthStatusMap[latestHealth.healthStatus]?.text || latestHealth.healthStatus}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {fmtDate(latestHealth.startDate)} ~ {fmtDate(latestHealth.endDate)} · {triggeredByMap[latestHealth.triggeredBy] || latestHealth.triggeredBy}
              </Text>
              {unhealthyCount > 0 && (
                <Badge count={unhealthyCount} color="orange" title={`近 ${healthItems.length} 次同步中有 ${unhealthyCount} 次非健康`} />
              )}
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>暂无健康数据</Text>
          )}
          {alerts.length > 0 && (
            <Badge count={alerts.length} color="red" title="未处理告警" />
          )}
        </Space>
        <Space>
          <Radio.Group
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            size="small"
          >
            <Radio.Button value="all">全部</Radio.Button>
            <Radio.Button value="success">成功</Radio.Button>
            <Radio.Button value="failed">失败</Radio.Button>
            <Radio.Button value="running">进行中</Radio.Button>
          </Radio.Group>
          <Button size="small" icon={<Zap className="h-4 w-4" />} onClick={() => setForceModalOpen(true)}>
            强制同步
          </Button>
          <Button
            size="small"
            icon={<RefreshCw className="h-4 w-4" />}
            loading={loading}
            onClick={loadData}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      {/* 未处理告警 */}
      {alerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${alerts.length} 条未处理的同步对账告警`}
          description={
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {alerts.map((a) => (
                <Space key={a.id} size={8} wrap>
                  <Text style={{ fontSize: 12 }}>
                    {fmtDate(a.startDate)} ~ {fmtDate(a.endDate)} · 缺失 {a.missingCount} · 重复 {a.duplicateCount}
                    {a.issues.length > 0 ? ` · ${a.issues.join("；")}` : ""}
                  </Text>
                  <Button
                    size="small"
                    type="link"
                    icon={<CheckCircle className="h-3 w-3" />}
                    loading={ackLoading === a.id}
                    onClick={() => handleAck(a.id)}
                  >
                    确认已处理
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    icon={<Eye className="h-3 w-3" />}
                    onClick={() => onViewLineage(a.startDate, a.endDate)}
                  >
                    看血缘
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      )}

      <Spin spinning={loading}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredLogs}
          pagination={{ pageSize: 20 }}
          size="small"
          bordered
          locale={{ emptyText: "暂无同步记录" }}
        />
      </Spin>

      <Modal
        title="强制同步指定日期"
        open={forceModalOpen}
        onOk={handleForceSync}
        onCancel={() => setForceModalOpen(false)}
        confirmLoading={forceLoading}
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            强制同步会绕过「already synced」检查，重新拉取并处理指定日期范围的数据。
          </Text>
        </div>
        <RangePicker value={forceRange as any} onChange={(v) => setForceRange(v)} style={{ width: "100%" }} />
      </Modal>
    </div>
  );
}

export default function DataSyncCenterPage() {
  const [activeTab, setActiveTab] = useState<string>("overview");
  // 血缘 Tab 的日期过滤：由「同步概览」行跳转时注入
  const [lineageRange, setLineageRange] = useState<[Dayjs | null, Dayjs | null]>([null, null]);

  const jumpToLineage = (start: string, end: string) => {
    setLineageRange([dayjs(start), dayjs(end)]);
    setActiveTab("lineage");
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <History size={24} />
        <Title level={4} style={{ margin: 0 }}>
          数据同步中心
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          钉钉审批 → 数据库 的同步情况：每次跑了没有、对没对上账、单张单数据长什么样
        </Text>
      </div>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "overview",
              label: (
                <Space size={6}>
                  <History size={14} />
                  同步概览
                </Space>
              ),
              children: <SyncOverviewTab onViewLineage={jumpToLineage} />,
            },
            {
              key: "lineage",
              label: (
                <Space size={6}>
                  <SearchCode size={14} />
                  数据血缘
                </Space>
              ),
              children: <DataLineagePanel range={lineageRange} onRangeChange={setLineageRange} />,
            },
          ]}
        />
      </Card>
    </div>
  );
}
