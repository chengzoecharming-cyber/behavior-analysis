import { Tag } from "@douyinfe/semi-ui";
import dayjs from "dayjs";
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
    const start = dayjs.tz(item.start_time);
    const end = dayjs.tz(item.end_time);
    const minutes = end.diff(start, "minute");
    const title = `${minutes}min无移动记录`;
    const description = `${start.format("YYYY-MM-DD HH:mm")} - ${end.format("YYYY-MM-DD HH:mm")}`;
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

  // 其他异常：按类型给出标题
  const title = ANOMALY_TYPE_TITLES[item.type] || "异常";
  return renderAnomalyRow(item.severity, title, item.description);
}

function renderAnomalyRow(
  severity: "low" | "medium" | "high",
  title: string,
  description: string
) {
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", width: "100%" }}>
        <Tag color={anomalySeverityColor[severity] as any} style={{ flexShrink: 0, marginTop: 2 }}>
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
          <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>{description}</div>
        </div>
      </div>
    </div>
  );
}
