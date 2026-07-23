import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import {
  fetchLineageApprovals,
  fetchLineageDetail,
  LineageApprovalItem,
  LineageDetail,
  LineageQualityRecord,
} from "../api";

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

// 步骤标题颜色
const STEP_COLORS = ["#1677ff", "#722ed1", "#13c2c2"];

function severityTag(severity: string) {
  if (severity === "ERROR") return <Tag color="red">ERROR</Tag>;
  if (severity === "WARNING") return <Tag color="orange">WARNING</Tag>;
  return <Tag color="blue">INFO</Tag>;
}

function fmtTime(v?: string | null): string {
  if (!v) return "-";
  const d = dayjs(v);
  return d.isValid() ? d.format("YYYY-MM-DD HH:mm:ss") : String(v);
}

/** 第①步：钉钉原始表单（中文标签 + 可读值） */
function RawFormStep({ detail }: { detail: LineageDetail }) {
  const fields = detail.rawForm;
  if (!fields.length) return <Empty description="无原始表单数据" />;
  return (
    <Table
      size="small"
      rowKey={(_, i) => String(i)}
      pagination={false}
      dataSource={fields}
      columns={[
        {
          title: "表单项",
          dataIndex: "name",
          width: 220,
          render: (v: string, r) => (
            <Space size={4}>
              <Text strong={r.isLocation}>{v}</Text>
              {r.isLocation && <Tag color="blue">定位</Tag>}
            </Space>
          ),
        },
        {
          title: "类型",
          dataIndex: "componentType",
          width: 170,
          render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text>,
        },
        {
          title: "值",
          dataIndex: "displayValue",
          render: (v: string, r) =>
            r.empty ? <Text type="secondary">（空）</Text> : <Text style={{ whiteSpace: "pre-wrap" }}>{v}</Text>,
        },
      ]}
    />
  );
}

/** 第②③步对照：重新解析 vs 已入库 */
function CompareStep({ detail }: { detail: LineageDetail }) {
  const maxRows = Math.max(detail.parsedVisits.length, detail.storedVisits.length);
  if (maxRows === 0) return <Empty description="该审批单没有解析出任何签到点" />;

  const rows = Array.from({ length: maxRows }, (_, i) => ({
    key: i,
    seq: i + 1,
    parsed: detail.parsedVisits[i],
    stored: detail.storedVisits[i],
  }));

  const cell = (v: unknown) =>
    v === undefined || v === null || v === "" || v === "null" ? (
      <Text type="secondary">-</Text>
    ) : (
      <Text style={{ fontSize: 12 }}>{String(v)}</Text>
    );

  return (
    <Table
      size="small"
      rowKey="key"
      pagination={false}
      dataSource={rows}
      columns={[
        { title: "#", dataIndex: "seq", width: 40 },
        {
          title: "② 重新解析（当前代码）",
          children: [
            { title: "时间", key: "p_time", width: 150, render: (_, r) => cell(r.parsed?.time) },
            { title: "客户", key: "p_cust", render: (_, r) => cell(r.parsed?.customer_name) },
            { title: "位置", key: "p_loc", width: 110, render: (_, r) => cell(r.parsed?.location_name) },
            { title: "拜访情况", key: "p_note", render: (_, r) => cell(r.parsed?.visit_note) },
          ],
        },
        {
          title: "③ 已入库 visits",
          children: [
            { title: "时间", key: "s_time", width: 150, render: (_, r) => cell(fmtTime(r.stored?.timestamp)) },
            { title: "客户", key: "s_cust", render: (_, r) => cell(r.stored?.customer_name) },
            { title: "位置", key: "s_loc", width: 110, render: (_, r) => cell(r.stored?.location_name) },
            {
              title: "地理编码",
              key: "s_geo",
              width: 90,
              render: (_, r) =>
                r.stored?.geocode_status ? (
                  <Tag color={r.stored.geocode_status === "success" ? "green" : "orange"}>
                    {r.stored.geocode_status}
                  </Tag>
                ) : (
                  cell(undefined)
                ),
            },
          ],
        },
      ]}
    />
  );
}

/** 质量问题列表 */
function QualityStep({ records }: { records: LineageQualityRecord[] }) {
  if (!records.length) return <Empty description="该审批单没有质量问题记录 ✓" />;
  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={records}
      columns={[
        { title: "级别", dataIndex: "severity", width: 90, render: severityTag },
        { title: "检查类型", dataIndex: "check_type", width: 140, render: (v: string) => <Tag>{v}</Tag> },
        { title: "说明", dataIndex: "message", render: (v: string) => <Text style={{ fontSize: 12 }}>{v}</Text> },
        {
          title: "原始值",
          dataIndex: "raw_value",
          width: 160,
          render: (v?: string) => (v ? <Text code style={{ fontSize: 11 }}>{v}</Text> : <Text type="secondary">-</Text>),
        },
      ]}
    />
  );
}

export default function DataLineagePage() {
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null]>([null, null]);
  const [userFilter, setUserFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [items, setItems] = useState<LineageApprovalItem[]>([]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<LineageDetail | null>(null);

  const load = useCallback(async (p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const res = await fetchLineageApprovals({
        start: range[0] ? range[0].format("YYYY-MM-DD") : undefined,
        end: range[1] ? range[1].format("YYYY-MM-DD") : undefined,
        user: userFilter.trim() || undefined,
        limit: ps,
        offset: (p - 1) * ps,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error("加载血缘列表失败", err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, range, userFilter]);

  useEffect(() => {
    load(1, pageSize);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, userFilter]);

  const openDetail = async (approvalId: string) => {
    setDrawerOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const d = await fetchLineageDetail(approvalId);
      setDetail(d);
    } catch (err) {
      console.error("加载血缘详情失败", err);
    } finally {
      setDetailLoading(false);
    }
  };

  const columns: ColumnsType<LineageApprovalItem> = [
    {
      title: "审批单号",
      dataIndex: "approvalId",
      render: (v: string, r) => (
        <a onClick={() => openDetail(r.approvalId)} style={{ fontFamily: "monospace", fontSize: 12 }}>
          {v}
        </a>
      ),
    },
    { title: "员工", dataIndex: "userName", width: 90, render: (v?: string) => v || <Text type="secondary">-</Text> },
    { title: "部门", dataIndex: "department", width: 140, ellipsis: true },
    { title: "创建时间", dataIndex: "createTime", width: 160, render: fmtTime },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string | undefined, r) => (
        <Tag color={v === "COMPLETED" ? "green" : "default"}>
          {v ?? "-"}
          {r.result ? `/${r.result}` : ""}
        </Tag>
      ),
    },
    { title: "签到点数", dataIndex: "visitCount", width: 90, align: "right" },
    {
      title: "质量问题",
      key: "quality",
      width: 120,
      render: (_, r) =>
        r.qualityErrorCount + r.qualityWarningCount === 0 ? (
          <Text type="secondary">无</Text>
        ) : (
          <Space size={8}>
            {r.qualityErrorCount > 0 && <Badge count={r.qualityErrorCount} color="red" title="ERROR" />}
            {r.qualityWarningCount > 0 && <Badge count={r.qualityWarningCount} color="orange" title="WARNING" />}
          </Space>
        ),
    },
  ];

  return (
    <div>
      <Card
        title={
          <Space>
            <Title level={5} style={{ margin: 0 }}>数据血缘查看器</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              看每张钉钉审批单：① 原始表单长什么样 → ② 系统怎么解析 → ③ 最终存成什么
            </Text>
          </Space>
        }
      >
        <Space style={{ marginBottom: 16 }} wrap>
          <RangePicker value={range} onChange={(v) => setRange(v ?? [null, null])} />
          <Input.Search
            placeholder="按员工姓名过滤"
            allowClear
            style={{ width: 200 }}
            onSearch={(v) => setUserFilter(v)}
          />
        </Space>

        <Table
          size="small"
          rowKey="approvalId"
          loading={loading}
          columns={columns}
          dataSource={items}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 张审批单`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
              load(p, ps);
            },
          }}
        />
      </Card>

      <Drawer
        title={
          detail ? (
            <Space direction="vertical" size={2}>
              <Text strong style={{ fontFamily: "monospace" }}>{detail.approvalId}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {detail.meta.userName || "（姓名缺失）"} · {detail.meta.department ?? "-"} ·{" "}
                {fmtTime(detail.meta.createTime)}
              </Text>
            </Space>
          ) : (
            "加载中..."
          )
        }
        width={980}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        {detailLoading ? (
          <div style={{ textAlign: "center", padding: 60 }}>
            <Spin size="large" />
          </div>
        ) : detail ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            {!detail.parseOk && (
              <Alert
                type="warning"
                showIcon
                message="重新解析失败或未产出签到点"
                description={detail.parseError}
              />
            )}

            <Descriptions size="small" column={4} bordered>
              <Descriptions.Item label="状态">{detail.meta.status ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="审批结果">{detail.meta.result ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{fmtTime(detail.meta.finishTime)}</Descriptions.Item>
              <Descriptions.Item label="签到点">
                解析 {detail.parsedVisits.length} / 入库 {detail.storedVisits.length}
              </Descriptions.Item>
            </Descriptions>

            <Collapse
              defaultActiveKey={["compare", "raw"]}
              items={[
                {
                  key: "compare",
                  label: (
                    <Text strong style={{ color: STEP_COLORS[1] }}>
                      ②③ 解析结果 ↔ 入库数据对照
                    </Text>
                  ),
                  children: <CompareStep detail={detail} />,
                },
                {
                  key: "raw",
                  label: (
                    <Text strong style={{ color: STEP_COLORS[0] }}>
                      ① 钉钉原始表单（{detail.rawForm.length} 个表单项）
                    </Text>
                  ),
                  children: <RawFormStep detail={detail} />,
                },
                {
                  key: "quality",
                  label: (
                    <Text strong style={{ color: detail.qualityRecords.length ? "#cf1322" : "#13c2c2" }}>
                      质量问题（{detail.qualityRecords.length}）
                    </Text>
                  ),
                  children: <QualityStep records={detail.qualityRecords} />,
                },
              ]}
            />
          </Space>
        ) : (
          <Empty description="未找到该审批单" />
        )}
      </Drawer>
    </div>
  );
}
