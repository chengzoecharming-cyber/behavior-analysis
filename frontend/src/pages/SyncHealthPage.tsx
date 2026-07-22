import { useEffect, useState } from "react";
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Typography,
  Alert,
  Spin,
  Modal,
  DatePicker,
  message,
  Badge,
} from "antd";
import { Shield, RefreshCw, RotateCcw, CheckCircle } from "lucide-react";
import {
  fetchSyncHealth,
  fetchSyncAlerts,
  ackSyncAlert,
  forceSyncDateRange,
  retrySyncLog,
} from "../api";
import { SyncHealthItem, SyncAlert, SyncHealthStatus } from "../types";
import dayjs from "dayjs";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const statusMap: Record<string, { text: string; color: string }> = {
  healthy: { text: "正常", color: "success" },
  warning: { text: "警告", color: "warning" },
  error: { text: "异常", color: "error" },
};

const triggeredByMap: Record<string, string> = {
  scheduler: "定时任务",
  manual: "手动同步",
  startup: "启动补齐",
};

export default function SyncHealthPage() {
  const [healthItems, setHealthItems] = useState<SyncHealthItem[]>([]);
  const [alerts, setAlerts] = useState<SyncAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceRange, setForceRange] = useState<[string, string] | null>(null);
  const [forceModalOpen, setForceModalOpen] = useState(false);
  const [forceLoading, setForceLoading] = useState(false);
  const [ackLoading, setAckLoading] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, alertRes] = await Promise.all([
        fetchSyncHealth(14),
        fetchSyncAlerts(false),
      ]);
      setHealthItems(healthRes.items);
      setAlerts(alertRes.alerts);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "加载同步健康数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

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

  const handleForceSync = async () => {
    if (!forceRange) {
      message.warning("请选择同步日期范围");
      return;
    }
    setForceLoading(true);
    try {
      await forceSyncDateRange(forceRange[0], forceRange[1]);
      message.success("强制同步已触发");
      setForceModalOpen(false);
      await loadData();
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || "强制同步失败");
    } finally {
      setForceLoading(false);
    }
  };

  const healthCards = (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" style={{ marginBottom: 24 }}>
      {healthItems.slice(0, 8).map((item) => (
        <Card key={item.id} size="small">
          <div className="flex items-center justify-between">
            <div>
              <Text type="secondary">{item.startDate}</Text>
              <div className="mt-1">
                <Tag color={statusMap[item.healthStatus].color}>
                  {statusMap[item.healthStatus].text}
                </Tag>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold">{item.totalInstances}</div>
              <Text type="secondary">审批实例</Text>
            </div>
          </div>
          {item.issues.length > 0 && (
            <div className="mt-2">
              {item.issues.map((issue, idx) => (
                <Text key={idx} type="danger" className="block text-xs">
                  {issue}
                </Text>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );

  const alertColumns = [
    {
      title: "同步范围",
      key: "range",
      render: (_: unknown, record: SyncAlert) => (
        <Text>
          {record.startDate} ~ {record.endDate}
        </Text>
      ),
    },
    {
      title: "触发方式",
      dataIndex: "triggeredBy",
      render: (v: string) => triggeredByMap[v] || v,
    },
    {
      title: "指标",
      key: "metrics",
      render: (_: unknown, record: SyncAlert) => (
        <Space>
          <Text>实例 {record.totalInstances}</Text>
          <Text>解析 {record.parsedVisits}</Text>
          <Text>写入 {record.normalizedInserted}</Text>
          <Text type="danger">缺失 {record.missingCount}</Text>
          <Text type="warning">重复 {record.duplicateCount}</Text>
        </Space>
      ),
    },
    {
      title: "问题",
      dataIndex: "issues",
      render: (issues: string[]) => (
        <Space direction="vertical" size={0}>
          {issues.map((issue, idx) => (
            <Text key={idx} type="danger">
              {issue}
            </Text>
          ))}
        </Space>
      ),
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "操作",
      key: "action",
      render: (_: unknown, record: SyncAlert) => (
        <Button
          size="small"
          icon={<CheckCircle className="h-3 w-3" />}
          loading={ackLoading === record.id}
          onClick={() => handleAck(record.id)}
        >
          确认已处理
        </Button>
      ),
    },
  ];

  const healthColumns = [
    {
      title: "ID",
      dataIndex: "id",
      width: 60,
    },
    {
      title: "触发方式",
      dataIndex: "triggeredBy",
      width: 100,
      render: (v: string) => triggeredByMap[v] || v,
    },
    {
      title: "健康状态",
      dataIndex: "healthStatus",
      width: 100,
      render: (v: SyncHealthStatus) => {
        const { text, color } = statusMap[v] || { text: v, color: "default" };
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: "同步范围",
      key: "range",
      width: 180,
      render: (_: unknown, record: SyncHealthItem) => (
        <Text>
          {record.startDate} ~ {record.endDate}
        </Text>
      ),
    },
    {
      title: "审批实例",
      dataIndex: "totalInstances",
      width: 100,
    },
    {
      title: "解析 visits",
      dataIndex: "parsedVisits",
      width: 100,
    },
    {
      title: "写入 visits",
      dataIndex: "normalizedInserted",
      width: 100,
    },
    {
      title: "写入 raw",
      dataIndex: "rawVisitCount",
      width: 100,
    },
    {
      title: "缺失/重复",
      key: "diff",
      width: 120,
      render: (_: unknown, record: SyncHealthItem) => (
        <Space>
          <Text type={record.missingCount > 0 ? "danger" : "secondary"}>
            缺失 {record.missingCount}
          </Text>
          <Text type={record.duplicateCount > 0 ? "warning" : "secondary"}>
            重复 {record.duplicateCount}
          </Text>
        </Space>
      ),
    },
    {
      title: "问题",
      dataIndex: "issues",
      render: (issues: string[]) =>
        issues.length > 0 ? (
          <Space direction="vertical" size={0}>
            {issues.map((issue, idx) => (
              <Text key={idx} type="danger">
                {issue}
              </Text>
            ))}
          </Space>
        ) : null,
    },
    {
      title: "时间",
      dataIndex: "startedAt",
      width: 180,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "操作",
      key: "action",
      width: 100,
      render: (_: unknown, record: SyncHealthItem) =>
        record.status === "failed" || record.healthStatus !== "healthy" ? (
          <Button
            size="small"
            icon={<RotateCcw className="h-3 w-3" />}
            loading={retryingId === record.id}
            onClick={() => handleRetry(record.id)}
          >
            重试
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Shield size={24} />
          <Title level={4} style={{ margin: 0 }}>
            同步健康
          </Title>
          {alerts.length > 0 && (
            <Badge count={alerts.length} style={{ backgroundColor: "#ff4d4f" }} />
          )}
        </div>
        <Space>
          <Button onClick={() => setForceModalOpen(true)}>强制同步</Button>
          <Button
            icon={<RefreshCw className="h-4 w-4" />}
            loading={loading}
            onClick={loadData}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert message={error} type="error" showIcon style={{ marginBottom: 24 }} />
      )}

      {loading && healthItems.length === 0 ? (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : (
        <>
          <Title level={5} style={{ marginBottom: 16 }}>
            最近同步状态
          </Title>
          {healthCards}

          {alerts.length > 0 && (
            <>
              <Title level={5} style={{ marginBottom: 16, marginTop: 24 }}>
                未处理告警
              </Title>
              <Table
                rowKey="id"
                dataSource={alerts}
                columns={alertColumns}
                pagination={false}
                size="small"
                style={{ marginBottom: 24 }}
              />
            </>
          )}

          <Title level={5} style={{ marginBottom: 16, marginTop: 24 }}>
            同步记录明细
          </Title>
          <Table
            rowKey="id"
            dataSource={healthItems}
            columns={healthColumns}
            pagination={{ pageSize: 10 }}
            size="small"
          />
        </>
      )}

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
        <RangePicker
          style={{ width: "100%" }}
          onChange={(dates) => {
            if (dates && dates[0] && dates[1]) {
              setForceRange([
                dates[0].format("YYYY-MM-DD"),
                dates[1].format("YYYY-MM-DD"),
              ]);
            } else {
              setForceRange(null);
            }
          }}
        />
      </Modal>
    </div>
  );
}
