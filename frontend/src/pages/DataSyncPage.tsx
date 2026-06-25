import { useEffect, useState } from "react";
import { Button, Card, DatePicker, Tag, Typography, Spin, Alert } from "antd";
import { RefreshCw, PlayCircle, CheckCircle, AlertCircle } from "lucide-react";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchDingTalkStatus,
  testDingTalkConnection,
  syncDingTalk,
  DingTalkStatus,
  DingTalkSyncResult,
} from "../api";

const { Title, Text } = Typography;

function DataSyncPage() {
  const [status, setStatus] = useState<DingTalkStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [syncResult, setSyncResult] = useState<DingTalkSyncResult | null>(null);
  const [syncRange, setSyncRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(1, "day"),
    dayjs().subtract(1, "day"),
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
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          数据同步
        </Title>
        <Text type="secondary" style={{ fontSize: 14 }}>
          从钉钉 OA 自动拉取审批数据并写入系统
        </Text>
      </div>

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

export default DataSyncPage;
