import { useEffect, useState } from "react";
import { Table, Tag, Button, Space, Typography, Alert, Spin, Radio } from "antd";
import { RefreshCw, History, RotateCcw } from "lucide-react";
import { fetchSyncLogs, retrySyncLog } from "../api";
import { DingTalkSyncLog } from "../types";
import dayjs from "dayjs";

const { Title, Text } = Typography;

const triggeredByMap: Record<string, string> = {
  scheduler: "定时任务",
  manual: "手动同步",
  startup: "启动补齐",
};

const statusMap: Record<string, { text: string; color: string }> = {
  success: { text: "成功", color: "success" },
  failed: { text: "失败", color: "error" },
  running: { text: "进行中", color: "processing" },
};

export default function SyncLogsPage() {
  const [logs, setLogs] = useState<DingTalkSyncLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const loadLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSyncLogs(100);
      setLogs(res.logs);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "加载同步记录失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  const handleRetry = async (id: number) => {
    setRetryingId(id);
    try {
      await retrySyncLog(id);
      await loadLogs();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "重试同步失败");
    } finally {
      setRetryingId(null);
    }
  };

  const filteredLogs =
    statusFilter === "all" ? logs : logs.filter((log) => log.status === statusFilter);

  const columns = [
    {
      title: "ID",
      dataIndex: "id",
      width: 60,
    },
    {
      title: "触发方式",
      dataIndex: "triggered_by",
      width: 100,
      render: (v: string) => triggeredByMap[v] || v,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string) => {
        const { text, color } = statusMap[v] || { text: v, color: "default" };
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: "同步范围",
      key: "range",
      width: 180,
      render: (_: unknown, record: DingTalkSyncLog) => (
        <Text>
          {record.start_date} ~ {record.end_date}
        </Text>
      ),
    },
    {
      title: "审批实例",
      dataIndex: "total_instances",
      width: 100,
    },
    {
      title: "解析 visits",
      dataIndex: "parsed_visits",
      width: 100,
    },
    {
      title: "插入 visits",
      dataIndex: "normalized_inserted",
      width: 100,
    },
    {
      title: "跳过/失败",
      key: "skip_fail",
      width: 120,
      render: (_: unknown, record: DingTalkSyncLog) => (
        <Space>
          <Text type="secondary">跳过 {record.skipped}</Text>
          {record.parse_failures > 0 && (
            <Text type="danger">失败 {record.parse_failures}</Text>
          )}
        </Space>
      ),
    },
    {
      title: "开始时间",
      dataIndex: "started_at",
      width: 180,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "耗时",
      key: "duration",
      width: 100,
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
      width: 100,
      render: (_: unknown, record: DingTalkSyncLog) =>
        record.status === "failed" ? (
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
          <History size={24} />
          <Title level={4} style={{ margin: 0 }}>
            钉钉同步记录
          </Title>
        </div>
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
          <Button
            icon={<RefreshCw className="h-4 w-4" />}
            loading={loading}
            onClick={loadLogs}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert
          message={error}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          closable
          onClose={() => setError(null)}
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
    </div>
  );
}
