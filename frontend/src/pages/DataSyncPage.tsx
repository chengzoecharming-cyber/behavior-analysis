import { useEffect, useState } from "react";
import { Button, Card, DatePicker, Tag, Typography, Spin, Alert, Tabs, Radio, Space, Table } from "antd";
import { RefreshCw, PlayCircle, CheckCircle, AlertCircle, FileText } from "lucide-react";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchDingTalkStatus,
  testDingTalkConnection,
  syncDingTalk,
  fetchReportGenerationLogs,
  DingTalkStatus,
  DingTalkSyncResult,
  ReportGenerationLog,
} from "../api";
import { UploadPanel } from "./UploadPage";

const { Text } = Typography;
const { RangePicker } = DatePicker;

const reportTypeMap: Record<string, string> = {
  daily: "日报",
  weekly: "周报",
  monthly: "月报",
};

const reportScopeMap: Record<string, string> = {
  company: "公司",
  department: "部门",
  sub_department: "子部门",
  person: "个人",
};

const reportTriggerMap: Record<string, string> = {
  scheduler: "定时任务",
  manual: "手动触发",
  catchup: "启动补跑",
};

const reportStatusMap: Record<string, { text: string; color: string }> = {
  success: { text: "成功", color: "success" },
  failed: { text: "失败", color: "error" },
};

/** 日期可能是 YYYY-MM-DD 或 ISO 时间戳，统一成 YYYY-MM-DD 显示 */
function fmtDate(v: string): string {
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD") : v;
}

function SyncPanel() {
  const [status, setStatus] = useState<DingTalkStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [syncResult, setSyncResult] = useState<DingTalkSyncResult | null>(null);
  const [syncRange, setSyncRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs.tz().subtract(1, "day"),
    dayjs.tz().subtract(1, "day"),
  ]);

  const loadStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await fetchDingTalkStatus();
      setStatus(res);
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testDingTalkConnection();
      setTestResult({ success: true, ...res });
    } catch (err: any) {
      setTestResult({ success: false, error: err.response?.data?.error || err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    if (!syncRange) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await syncDingTalk(
        syncRange[0].format("YYYY-MM-DD"),
        syncRange[1].format("YYYY-MM-DD")
      );
      setSyncResult(res);
      loadStatus();
    } catch (err: any) {
      setSyncResult({
        success: false,
        error: err.response?.data?.error || err.message,
      } as any);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <Card style={{ marginBottom: 24, borderRadius: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <RefreshCw size={20} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>钉钉同步状态</span>
          <Button loading={loadingStatus} onClick={loadStatus} size="small">
            刷新
          </Button>
        </div>

        {status ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <Text type="secondary">配置状态：</Text>
              {status.configured ? (
                <Tag color="success">已配置</Tag>
              ) : (
                <Tag color="warning">未配置</Tag>
              )}
            </div>
            {status.appKey && (
              <div>
                <Text type="secondary">AppKey：</Text>
                <Text>{status.appKey}</Text>
              </div>
            )}
            {status.processCode && (
              <div>
                <Text type="secondary">审批模板：</Text>
                <Text code>{status.processCode}</Text>
              </div>
            )}
            <div>
              <Text type="secondary">AccessToken：</Text>
              {status.tokenValid ? (
                <Tag color="success">有效</Tag>
              ) : status.configured ? (
                <Tag color="error">无效</Tag>
              ) : (
                <Tag>未检查</Tag>
              )}
            </div>
            {status.tokenError && (
              <Alert
                message={status.tokenError}
                type="error"
                showIcon
                style={{ maxWidth: 600 }}
              />
            )}
            {!status.configured && (
              <Alert
                message="请在后端 .env 中配置 DINGTALK_APP_KEY、DINGTALK_APP_SECRET、DINGTALK_PROCESS_CODE"
                type="info"
                showIcon
                style={{ maxWidth: 600 }}
              />
            )}
          </div>
        ) : (
          <Spin />
        )}
      </Card>

      <Card style={{ marginBottom: 24, borderRadius: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <CheckCircle size={20} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>连接测试</span>
        </div>
        <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          先点击「测试连接」确认应用权限和审批模板是否正确，再执行正式同步。
        </Text>
        <Button
          type="primary"
          icon={<PlayCircle size={16} />}
          loading={testing}
          onClick={handleTest}
          disabled={!status?.configured}
        >
          测试连接
        </Button>

        {testResult && (
          <div style={{ marginTop: 16 }}>
            {testResult.success ? (
              <Alert
                message={testResult.message}
                type="success"
                showIcon
                description={
                  testResult.instanceCount > 0 ? (
                    <pre style={{ marginTop: 8, maxHeight: 300, overflow: "auto" }}>
                      {JSON.stringify(testResult.sample, null, 2)}
                    </pre>
                  ) : null
                }
              />
            ) : (
              <Alert message="测试失败" description={testResult.error} type="error" showIcon />
            )}
          </div>
        )}
      </Card>

      <Card style={{ borderRadius: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <RefreshCw size={20} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>手动同步</span>
        </div>
        <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
          默认同步昨天数据。也可以选择自定义范围，系统会按审批完成时间拉取并写入。
        </Text>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <DatePicker.RangePicker
            value={syncRange}
            onChange={(range) => {
              if (range && range[0] && range[1]) {
                setSyncRange([range[0], range[1]]);
              }
            }}
          />
          <Button
            type="primary"
            icon={<RefreshCw size={16} />}
            loading={syncing}
            onClick={handleSync}
            disabled={!status?.configured || !syncRange}
          >
            开始同步
          </Button>
        </div>

        {syncResult && (
          <div style={{ marginTop: 16 }}>
            {syncResult.success !== false ? (
              <Alert
                message="同步完成"
                type="success"
                showIcon
                description={
                  <div>
                    <div>审批实例数：{syncResult.totalInstances}</div>
                    <div>解析成功：{syncResult.parsedVisits}</div>
                    <div>写入拜访记录：{syncResult.normalizedInserted}</div>
                    <div>跳过重复：{syncResult.skipped}</div>
                    <div>解析失败：{syncResult.parseFailures}</div>
                    <div>地理编码失败：{syncResult.geocodeFailures?.length || 0}</div>
                  </div>
                }
              />
            ) : (
              <Alert
                message="同步失败"
                description={syncResult.error}
                type="error"
                showIcon
                icon={<AlertCircle size={16} />}
              />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/** 报告生成日志 Tab：日/周/月报每个维度一条记录，同一批共享 run_id */
function ReportGenerationTab() {
  const [logs, setLogs] = useState<ReportGenerationLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const loadData = async (
    nextPage = page,
    nextPageSize = pageSize,
    nextStatus = statusFilter,
    nextType = typeFilter,
    nextRange = range
  ) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchReportGenerationLogs({
        page: nextPage,
        pageSize: nextPageSize,
        status: nextStatus === "all" ? undefined : nextStatus,
        report_type: nextType === "all" ? undefined : nextType,
        start: nextRange?.[0]?.format("YYYY-MM-DD"),
        end: nextRange?.[1]?.format("YYYY-MM-DD"),
      });
      setLogs(res.logs);
      setTotal(res.total);
      setPage(res.page);
      setPageSize(res.pageSize);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "加载报告生成日志失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(1, pageSize, "all", "all", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilterChange = (nextStatus: string, nextType: string) => {
    setStatusFilter(nextStatus);
    setTypeFilter(nextType);
    loadData(1, pageSize, nextStatus, nextType, range);
  };

  const handleRangeChange = (v: [Dayjs | null, Dayjs | null] | null) => {
    setRange(v);
    loadData(1, pageSize, statusFilter, typeFilter, v);
  };

  const columns = [
    {
      title: "时间",
      dataIndex: "created_at",
      width: 165,
      render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
    },
    {
      title: "类型",
      dataIndex: "report_type",
      width: 80,
      render: (v: string) => reportTypeMap[v] || v,
    },
    {
      title: "周期",
      key: "period",
      width: 190,
      render: (_: unknown, record: ReportGenerationLog) => (
        <Text>
          {fmtDate(record.period_start)} ~ {fmtDate(record.period_end)}
        </Text>
      ),
    },
    {
      title: "维度",
      dataIndex: "scope",
      width: 90,
      render: (v: string) => reportScopeMap[v] || v,
    },
    { title: "名称", dataIndex: "scope_name", width: 140, ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      width: 80,
      render: (v: string) => {
        const { text, color } = reportStatusMap[v] || { text: v, color: "default" };
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: "耗时",
      dataIndex: "duration_ms",
      width: 80,
      render: (v: number | null) => {
        if (v == null) return "-";
        const seconds = Math.round(v / 1000);
        return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
      },
    },
    {
      title: "触发方式",
      dataIndex: "trigger_source",
      width: 100,
      render: (v: string) => reportTriggerMap[v] || v,
    },
    {
      title: "文档",
      dataIndex: "doc_url",
      width: 80,
      render: (v: string | null) =>
        v ? (
          <a href={v} target="_blank" rel="noreferrer">
            查看
          </a>
        ) : null,
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
  ];

  return (
    <div>
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
            <FileText size={16} />
            <Text strong>报告生成日志</Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            日/周/月报按 公司→部门→子部门→个人 逐维度生成，同一批共享 run_id
          </Text>
        </Space>
        <Space wrap>
          <Radio.Group
            value={typeFilter}
            onChange={(e) => handleFilterChange(statusFilter, e.target.value)}
            size="small"
          >
            <Radio.Button value="all">全部类型</Radio.Button>
            <Radio.Button value="daily">日报</Radio.Button>
            <Radio.Button value="weekly">周报</Radio.Button>
            <Radio.Button value="monthly">月报</Radio.Button>
          </Radio.Group>
          <Radio.Group
            value={statusFilter}
            onChange={(e) => handleFilterChange(e.target.value, typeFilter)}
            size="small"
          >
            <Radio.Button value="all">全部状态</Radio.Button>
            <Radio.Button value="success">成功</Radio.Button>
            <Radio.Button value="failed">失败</Radio.Button>
          </Radio.Group>
          <RangePicker
            size="small"
            value={range as any}
            onChange={(v) => handleRangeChange(v)}
          />
          <Button
            size="small"
            icon={<RefreshCw className="h-4 w-4" />}
            loading={loading}
            onClick={() => loadData()}
          >
            刷新
          </Button>
        </Space>
      </div>

      {error && (
        <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      <Spin spinning={loading}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={logs}
          size="small"
          bordered
          locale={{ emptyText: "暂无报告生成日志" }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => loadData(p, ps, statusFilter, typeFilter, range),
          }}
        />
      </Spin>
    </div>
  );
}

function DataSyncPage() {
  return (
    <div>
      <Tabs
        defaultActiveKey="upload"
        items={[
          {
            key: "upload",
            label: "数据上传",
            children: <UploadPanel />,
          },
          {
            key: "sync",
            label: "数据同步",
            children: <SyncPanel />,
          },
          {
            key: "report",
            label: "报告生成",
            children: <ReportGenerationTab />,
          },
        ]}
      />
    </div>
  );
}

export default DataSyncPage;
