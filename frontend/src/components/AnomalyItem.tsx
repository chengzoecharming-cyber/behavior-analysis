import { Tag } from "@douyinfe/semi-ui";
import dayjs from "dayjs";
import { formatBeijingTime } from "../utils/time";
import { Anomaly } from "../types";

const anomalySeverityText = {
  high: "高",
  medium: "中",
  low: "低",
};

const anomalySeverityColor = {
  high: "red",
  medium: "orange",
  low: "green",
};

const ANOMALY_TYPE_TITLES: Record<string, string> = {
  duplicate_location: "重复签到",
  long_stop: "停留过长",
  invalid_trip_type: "异常出行方式",
  missing_special_reason: "特殊签到缺原因",
  mileage_reading_invalid: "里程读数异常",
};

export function AnomalyItem({ item }: { item: Anomaly }) {
  const m = item.metadata || {};

  // 涉及两地：mileage_deviation
  if (m.from_location && m.to_location && item.type === "mileage_deviation") {
    const title = `${m.from_location} → ${m.to_location}`;
    const description = `填报 ${m.reported_distance_km ?? "-"}km vs 高德 ${
      m.gaode_distance_km != null ? Math.round(m.gaode_distance_km) : "-"
    }km · 偏差 ${
      m.deviation_rate != null ? `${(m.deviation_rate * 100).toFixed(1)}%` : "-"
    }`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 长时间未移动
  if (item.type === "long_idle" && item.start_time && item.end_time) {
    const start = dayjs(item.start_time).tz("Asia/Shanghai");
    const end = dayjs(item.end_time).tz("Asia/Shanghai");
    const minutes = end.diff(start, "minute");
    const title = `${minutes}min无移动记录`;
    const description = `${formatBeijingTime(item.start_time)} - ${formatBeijingTime(item.end_time)}`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 签到次数不足
  if (item.type === "low_visit_count") {
    const match = item.description.match(/过去\s*5\s*个工作日累计签到\s*(\d+)\s*次/);
    const count = match ? match[1] : "?";
    const title = "签到次数不足";
    const description = `过去 5 个工作日累计签到 ${count} 次`;
    return renderAnomalyRow(item.severity, title, description);
  }

  // 重复签到：展示「途n - 具体地址」灰色 tag
  if (item.type === "duplicate_location") {
    const m = item.metadata || {};
    const match = item.description.match(/重复签到\s*(\d+)\s*次/);
    const count = match ? match[1] : "?";
    const address = (m.address as string) || item.description.match(/「([^」]+)」/)?.[1] || "未知地址";
    const sequenceLabel = (m.sequence_label as string) || "途";
    const title = "重复签到";
    const description = `过去两周重复签到 ${count} 次`;
    const locationTag = (
      <Tag
        size="small"
        style={{
          marginTop: 6,
          backgroundColor: "#f5f5f5",
          border: "1px solid #d9d9d9",
          color: "#666",
          fontSize: 12,
        }}
      >
        {sequenceLabel} - {address}
      </Tag>
    );
    return renderAnomalyRow(item.severity, title, description, locationTag);
  }

  // 其他异常：按类型给出标题
  const title = ANOMALY_TYPE_TITLES[item.type] || "异常";
  return renderAnomalyRow(item.severity, title, item.description);
}

function renderAnomalyRow(
  severity: "low" | "medium" | "high",
  title: string,
  description: string,
  extra?: React.ReactNode
) {
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
        <Tag
          color={anomalySeverityColor[severity] as any}
          style={{
            flexShrink: 0,
            width: 28,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            fontSize: 12,
            fontWeight: 600,
            textAlign: "center",
            lineHeight: "16px",
          }}
        >
          {anomalySeverityText[severity]}
        </Tag>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#0f1419",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={title}
          >
            {title}
          </div>
          <div style={{ fontSize: 13, color: "#666", marginTop: 6 }}>{description}</div>
          {extra}
        </div>
      </div>
    </div>
  );
}
