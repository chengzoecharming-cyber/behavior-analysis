import { Timeline, Tag, Popover } from "@douyinfe/semi-ui";
import dayjs from "dayjs";
import { Visit, Route, Anomaly } from "../types";
import { AnomalyItem } from "./AnomalyItem";

interface TrajectoryTimelineProps {
  visits: Visit[];
  routes: Route[];
  anomalies: Anomaly[];
}

interface TimelineNode {
  visit: Visit;
  sequenceLabel: string;
  markColor: string;
  nextDistanceKm?: number;
  tags: AnomalyTagItem[];
}

interface AnomalyTagItem {
  key: string;
  label: string;
  anomaly: Anomaly;
}

const TAG_BORDER = "#ffbb96";
const TAG_BG = "#fff7e6";
const TAG_TEXT = "#fa8c16";

const MARK_COLORS = {
  start: "#52c41a",
  waypoint: "#1890ff",
  end: "#ff4d4f",
  publicTransport: "#722ed1",
};

function isPublicTransportVisit(visit: Visit): boolean {
  return (visit.trip_type || "").includes("公共交通");
}

function formatAddress(value?: string | null, maxLen = 20): string {
  if (!value) return "未知地址";
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 3) + "...";
}

function buildTagForAnomaly(anomaly: Anomaly): AnomalyTagItem | null {
  if (
    anomaly.type === "mileage_deviation" ||
    anomaly.type === "route_detour" ||
    anomaly.type === "mileage_reading_invalid"
  ) {
    return { key: `mileage_${anomaly.id}`, label: "里程异常", anomaly };
  }
  if (anomaly.type === "invalid_trip_type") {
    return { key: `invalid_trip_${anomaly.id}`, label: "异常出行", anomaly };
  }
  if (anomaly.type === "missing_special_reason") {
    return { key: `missing_reason_${anomaly.id}`, label: "缺原因", anomaly };
  }
  return null;
}

function getNodeTags(visit: Visit, anomalies: Anomaly[]): AnomalyTagItem[] {
  const tags: AnomalyTagItem[] = [];
  const added = new Set<string>();

  for (const anomaly of anomalies) {
    // 单 visit 关联
    const relatesToVisit = anomaly.related_visit_ids.includes(visit.id);

    // 里程读数异常按审批单关联
    const relatesByApproval =
      anomaly.type === "mileage_reading_invalid" &&
      visit.approval_id &&
      anomaly.metadata?.approval_id === visit.approval_id;

    if (!relatesToVisit && !relatesByApproval) continue;

    const tag = buildTagForAnomaly(anomaly);
    if (!tag) continue;

    // 同一类型去重
    if (added.has(tag.label)) continue;
    added.add(tag.label);

    tags.push(tag);
  }

  return tags;
}

export default function TrajectoryTimeline({
  visits,
  routes,
  anomalies,
}: TrajectoryTimelineProps) {
  if (visits.length === 0) {
    return <div style={{ color: "#999", fontSize: 14 }}>暂无轨迹数据</div>;
  }

  const sortedVisits = [...visits].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const routeMap = new Map<string, number>();
  for (const route of routes) {
    routeMap.set(`${route.from_visit_id},${route.to_visit_id}`, route.distance_km);
  }

  const nodes: TimelineNode[] = sortedVisits.map((visit, idx) => {
    const isStart = idx === 0;
    const isEnd = idx === sortedVisits.length - 1;
    const isPublic = isPublicTransportVisit(visit);

    let sequenceLabel: string;
    let markColor: string;
    if (isPublic) {
      sequenceLabel = "公";
      markColor = MARK_COLORS.publicTransport;
    } else if (isStart) {
      sequenceLabel = "起";
      markColor = MARK_COLORS.start;
    } else if (isEnd) {
      sequenceLabel = "终";
      markColor = MARK_COLORS.end;
    } else {
      sequenceLabel = `途${idx}`;
      markColor = MARK_COLORS.waypoint;
    }

    let nextDistanceKm: number | undefined;
    if (!isEnd) {
      const nextVisit = sortedVisits[idx + 1];
      nextDistanceKm = routeMap.get(`${visit.id},${nextVisit.id}`);
    }

    return {
      visit,
      sequenceLabel,
      markColor,
      nextDistanceKm,
      tags: getNodeTags(visit, anomalies),
    };
  });

  return (
    <Timeline>
      {nodes.map((node) => {
        const v = node.visit;
        const timeStr = dayjs.tz(v.timestamp).format("HH:mm");
        const address = v.address || v.location_name;
        const displayAddress = formatAddress(address);

        const dotContent = (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              backgroundColor: node.markColor,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 600,
              border: "2px solid #fff",
              boxShadow: "0 1px 4px rgba(0,0,0,.35)",
            }}
          >
            {node.sequenceLabel}
          </div>
        );

        return (
          <Timeline.Item key={v.id} dot={dotContent}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: 240,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      color: "#0f1419",
                      fontWeight: 500,
                      width: 44,
                      flexShrink: 0,
                    }}
                  >
                    {timeStr}
                  </span>
                  <Popover content={address || "未知地址"} showArrow>
                    <span
                      style={{
                        fontSize: 14,
                        color: "#0f1419",
                        cursor: "default",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {displayAddress}
                    </span>
                  </Popover>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {node.tags.map((tag) => (
                    <Popover key={tag.key} content={<AnomalyItem item={tag.anomaly} />} showArrow>
                      <Tag
                        style={{
                          backgroundColor: TAG_BG,
                          border: `1px solid ${TAG_BORDER}`,
                          color: TAG_TEXT,
                          fontSize: 12,
                          padding: "2px 8px",
                          cursor: "default",
                        }}
                      >
                        {tag.label}
                      </Tag>
                    </Popover>
                  ))}
                </div>
              </div>

              {v.customer_name && (
                <div style={{ fontSize: 13, color: "#666" }}>
                  客户：{v.customer_name}
                </div>
              )}

              {node.nextDistanceKm != null && (
                <div>
                  <Tag
                    size="small"
                    style={{
                      backgroundColor: "#f5f5f5",
                      border: "1px solid #d9d9d9",
                      color: "#595959",
                      fontSize: 12,
                    }}
                  >
                    {node.nextDistanceKm.toFixed(1)} km
                  </Tag>
                </div>
              )}
            </div>
          </Timeline.Item>
        );
      })}
    </Timeline>
  );
}
