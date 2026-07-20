import { useEffect, useState, useCallback } from "react";
import {
  Table,
  Switch,
  InputNumber,
  Button,
  Toast,
  Spin,
  Typography,
  Tag,
} from "@douyinfe/semi-ui";
import { IconRefresh } from "@douyinfe/semi-icons";
import { fetchAnomalyWeights, updateAnomalyWeight } from "../api";
import { AnomalyWeight } from "../types";

const { Title, Text } = Typography;

function RulesConfigPage() {
  const [rules, setRules] = useState<AnomalyWeight[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAnomalyWeights();
      setRules(data.sort((a, b) => a.id - b.id));
    } catch (err) {
      console.error("Failed to load rules:", err);
      Toast.error("加载规则失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const handleUpdate = async (
    rule: AnomalyWeight,
    updates: Partial<Pick<AnomalyWeight, "weight" | "threshold_value" | "enabled">>
  ) => {
    setSaving((prev) => ({ ...prev, [rule.rule_key]: true }));
    try {
      const updated = await updateAnomalyWeight(rule.rule_key, updates);
      setRules((prev) =>
        prev.map((r) => (r.rule_key === updated.rule_key ? updated : r))
      );
      Toast.success(`${updated.rule_name} 已更新`);
    } catch (err) {
      console.error("Failed to update rule:", err);
      Toast.error("更新失败");
    } finally {
      setSaving((prev) => ({ ...prev, [rule.rule_key]: false }));
    }
  };

  const columns = [
    {
      title: "规则",
      dataIndex: "rule_name",
      render: (_: any, record: AnomalyWeight) => (
        <div>
          <div style={{ fontWeight: 600 }}>{record.rule_name}</div>
          <Text type="tertiary" size="small">
            {record.description}
          </Text>
        </div>
      ),
    },
    {
      title: "Key",
      dataIndex: "rule_key",
      width: 180,
    },
    {
      title: "层级",
      dataIndex: "layer",
      width: 100,
      render: (layer: string | null) => {
        const colorMap: Record<string, string> = {
          fact: "blue",
          analyze: "light-blue",
          judge: "purple",
        };
        const labelMap: Record<string, string> = {
          fact: "事实层",
          analyze: "分析层",
          judge: "判定层",
        };
        if (!layer) return <Text type="tertiary">未分类</Text>;
        return <Tag color={(colorMap[layer] || "default") as any}>{labelMap[layer] || layer}</Tag>;
      },
    },
    {
      title: "权重",
      dataIndex: "weight",
      width: 160,
      render: (_: any, record: AnomalyWeight) => (
        <InputNumber
          value={record.weight}
          min={0}
          max={1}
          step={0.01}
          disabled={!record.enabled || saving[record.rule_key]}
          onChange={(value: number | string) => {
            const num = typeof value === "string" ? parseFloat(value) : value;
            if (!isNaN(num) && num !== record.weight) {
              handleUpdate(record, { weight: num });
            }
          }}
        />
      ),
    },
    {
      title: "阈值",
      dataIndex: "threshold_value",
      width: 160,
      render: (_: any, record: AnomalyWeight) => (
        <InputNumber
          value={record.threshold_value ?? undefined}
          min={0}
          step={record.rule_key === "mileage_deviation" ? 0.05 : 1}
          disabled={!record.enabled || saving[record.rule_key] || record.threshold_value === null}
          onChange={(value: number | string) => {
            const num = typeof value === "string" ? parseFloat(value) : value;
            if (!isNaN(num) && num !== (record.threshold_value ?? 0)) {
              handleUpdate(record, { threshold_value: num });
            }
          }}
        />
      ),
    },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 100,
      render: (_: any, record: AnomalyWeight) => (
        <Switch
          checked={record.enabled}
          loading={saving[record.rule_key]}
          onChange={(checked: boolean) => handleUpdate(record, { enabled: checked })}
        />
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title heading={2} style={{ marginBottom: 8, fontWeight: 600, color: "#0f1419" }}>
          异常规则配置
        </Title>
        <Text type="tertiary" style={{ fontSize: 14 }}>
          调整异常检测权重与阈值，修改后实时生效
        </Text>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 12 }}>
        <Button icon={<IconRefresh />} onClick={loadRules} loading={loading}>
          刷新
        </Button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: "#999" }}>加载规则中...</div>
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={rules}
          pagination={false}
          rowKey="rule_key"
          style={{ backgroundColor: "#fff", borderRadius: 12, padding: 16 }}
        />
      )}

      <div style={{ marginTop: 24, padding: 16, backgroundColor: "#fff", borderRadius: 12 }}>
        <Title heading={5} style={{ marginBottom: 12 }}>
          评分说明
        </Title>
        <Text type="tertiary">
          风险分 = Σ(判定层规则权重 × 命中次数 × 100)，最高 100 分。
          <br />
          ≥70 分为高风险，≥40 分为可疑，&lt;40 分为正常。
          <br />
          事实层规则只用于展示数据问题，不参与风险评分。
          <br />
          关闭某条规则后，该规则不再参与检测与评分。
        </Text>
      </div>
    </div>
  );
}

export default RulesConfigPage;
