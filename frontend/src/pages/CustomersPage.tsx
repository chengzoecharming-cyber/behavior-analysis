import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Input,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
} from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import { fetchCrmCustomers } from "../api";
import type { CrmCustomerListItem, CrmCustomerListResponse } from "../types";

const { Text } = Typography;

const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  enterprise_domestic: "国内企业",
  agent_domestic: "国内代理商",
  terminal_overseas: "海外终端",
  agent_overseas: "海外代理商",
};

const PAGE_SIZE = 20;

export default function CustomersPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<CrmCustomerListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [pool, setPool] = useState<"" | "pool" | "private">("");
  const [owner, setOwner] = useState("");
  const [stage, setStage] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchCrmCustomers({
        keyword,
        customer_type: customerType,
        pool,
        owner,
        stage,
        page,
        pageSize: PAGE_SIZE,
      });
      setData(res);
    } catch (err) {
      console.error("加载客户列表失败:", err);
    } finally {
      setLoading(false);
    }
  }, [keyword, customerType, pool, owner, stage, page]);

  useEffect(() => {
    load();
  }, [load]);

  const resetPageAnd = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const columns = [
    {
      title: "客户名称",
      dataIndex: "name",
      render: (name: string | null, record: CrmCustomerListItem) => (
        <a
          style={{ cursor: "pointer" }}
          onClick={() => navigate(`/customers/${encodeURIComponent(record.id)}`)}
        >
          {name || "-"}
        </a>
      ),
    },
    {
      title: "类型",
      dataIndex: "customer_type",
      render: (t: string | null) =>
        t ? <Tag color="blue">{CUSTOMER_TYPE_LABELS[t] || t}</Tag> : "-",
    },
    {
      title: "公私海",
      dataIndex: "is_in_pool",
      render: (inPool: boolean) =>
        inPool ? <Tag color="orange">公海</Tag> : <Tag color="green">私海</Tag>,
    },
    {
      title: "阶段",
      dataIndex: "follow_status",
      render: (s: string | null) => s || "-",
    },
    {
      title: "负责人",
      dataIndex: "owner_name",
      render: (o: string | null) => o || "-",
    },
    {
      title: "区域",
      dataIndex: "region",
      render: (r: string | null) => r || "-",
    },
    {
      title: "跟进次数",
      dataIndex: "follow_times",
      width: 90,
    },
    {
      title: "最近跟进",
      dataIndex: "latest_follow_up_time",
      render: (t: string | null) => (t ? t.slice(0, 10) : "-"),
    },
    {
      title: "数据状态",
      dataIndex: "process_status",
      render: (s: string | null) =>
        s === "审批中" ? <Tag color="red">审批中</Tag> : s || "-",
    },
  ];

  return (
    <div style={{ backgroundColor: "#fff", padding: 24, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <Text type="tertiary" size="small">
          CRM 数据快照：{data?.snapshot_date || "未知"}（手工导入，非实时）
        </Text>
      </div>

      <Card style={{ marginTop: 16 }} bodyStyle={{ padding: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Input
            prefix={<IconSearch />}
            placeholder="搜索客户名称，回车确认"
            style={{ width: 260 }}
            value={keywordInput}
            onChange={(v) => setKeywordInput(v)}
            onEnterPress={() => resetPageAnd(() => setKeyword(keywordInput.trim()))}
            showClear
          />
          <Select
            placeholder="客户类型"
            style={{ width: 150 }}
            value={customerType}
            onChange={(v) => resetPageAnd(() => setCustomerType(String(v || "")))}
            showClear
            optionList={Object.entries(CUSTOMER_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            placeholder="公私海"
            style={{ width: 120 }}
            value={pool}
            onChange={(v) => resetPageAnd(() => setPool((v as "" | "pool" | "private") || ""))}
            showClear
            optionList={[
              { value: "private", label: "私海" },
              { value: "pool", label: "公海" },
            ]}
          />
          <Select
            placeholder="负责人"
            style={{ width: 140 }}
            value={owner}
            onChange={(v) => resetPageAnd(() => setOwner(String(v || "")))}
            showClear
            filter
            optionList={(data?.owner_options || []).map((o) => ({ value: o, label: o }))}
          />
          <Select
            placeholder="跟进阶段"
            style={{ width: 160 }}
            value={stage}
            onChange={(v) => resetPageAnd(() => setStage(String(v || "")))}
            showClear
            filter
            optionList={(data?.stage_options || []).map((s) => ({ value: s, label: s }))}
          />
          <Button onClick={() => resetPageAnd(() => setKeyword(keywordInput.trim()))} type="primary">
            查询
          </Button>
        </div>
      </Card>

      <Spin spinning={loading} style={{ display: "block", marginTop: 16 }}>
        <Table
          columns={columns}
          dataSource={data?.list || []}
          rowKey="id"
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total: data?.total || 0,
            onPageChange: (p) => setPage(p),
          }}
        />
      </Spin>
    </div>
  );
}
