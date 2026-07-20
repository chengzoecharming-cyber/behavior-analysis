import { Timeline, Tag, Popover } from "@douyinfe/semi-ui";
import type { CSSProperties } from "react";
import { useState } from "react";
import { formatBeijingHHmm } from "../utils/time";
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

const tagBaseStyle: CSSProperties = {
  fontSize: 12,
  height: 20,
  padding: "2px 8px",
  display: "inline-flex",
  alignItems: "center",
  cursor: "default",
};

const MARK_COLORS = {
  start: "#52c41a",
  waypoint: "#1890ff",
  end: "#ff4d4f",
  publicTransport: "#722ed1",
};

function isPublicTransportVisit(visit: Visit): boolean {
  return (visit.trip_type || "").includes("公共交通");
}

function formatAddress(value?: string | null): string {
  return value && value.trim() ? value.trim() : "未知地址";
}

function buildTagForAnomaly(anomaly: Anomaly): AnomalyTagItem | null {
  // Timeline 只展示事实层标签
  if (anomaly.layer && anomaly.layer !== "fact") return null;

  if (anomaly.type === "mileage_reading_invalid") {
    return { key: `mileage_${anomaly.id}`, label: "填报异常", anomaly };
  }
  if (anomaly.type === "missing_special_reason") {
    return { key: `missing_reason_${anomaly.id}`, label: "缺原因", anomaly };
  }
  if (anomaly.type === "duplicate_location") {
    return { key: `duplicate_${anomaly.id}`, label: "重复签到", anomaly };
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
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());

  const toggleNote = (visitId: number) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(visitId)) {
        next.delete(visitId);
      } else {
        next.add(visitId);
      }
      return next;
    });
  };

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
    const isRunningApproval = visit.approval_status === "RUNNING";

    let sequenceLabel: string;
    let markColor: string;
    if (isPublic) {
      sequenceLabel = "公";
      markColor = MARK_COLORS.publicTransport;
    } else if (isStart) {
      sequenceLabel = "起";
      markColor = MARK_COLORS.start;
    } else if (isEnd && !isRunningApproval) {
      // 审批已结束时，最后一个点才标"终"；RUNNING 时继续用"途n"
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
    <Timeline className="person-trajectory-timeline">
      {nodes.map((node) => {
        const v = node.visit;
        const timeStr = formatBeijingHHmm(v.timestamp);
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
              fontSize: 11,
              fontWeight: 600,
              border: "2px solid #fff",
            }}
          >
            {node.sequenceLabel}
          </div>
        );

        return (
          <Timeline.Item key={v.id} dot={dotContent}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* 地点 + 时间，时间靠最右 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <Popover content={address || "未知地址"} showArrow>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#0f1419",
                        cursor: "default",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "block",
                      }}
                      title={address || "未知地址"}
                    >
                      {displayAddress}
                    </span>
                  </Popover>
                </div>
                <span
                  style={{
                    fontSize: 14,
                    color: "#0f1419",
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  {timeStr}
                </span>
              </div>

              {/* 异常标签 */}
              {node.tags.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {node.tags.map((tag) => (
                    <Popover key={tag.key} content={<AnomalyItem item={tag.anomaly} />} showArrow contentClassName="trajectory-tag-popover">
                      <Tag color="orange" style={{ ...tagBaseStyle, cursor: "pointer" }}>
                        {tag.label}
                      </Tag>
                    </Popover>
                  ))}
                </div>
              )}

              {v.customer_name && (
                <div
                  style={{
                    fontSize: 13,
                    color: "#666",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={v.customer_name}
                >
                  客户：{v.customer_name}
                </div>
              )}

              {v.visit_note && (
                <div style={{ fontSize: 13, color: "#666" }}>
                  <span style={{ color: "#999" }}>本次拜访情况：</span>
                  <span
                    style={{
                      display: "inline",
                      cursor: "pointer",
                      whiteSpace: expandedNotes.has(v.id) ? "normal" : "nowrap",
                      overflow: expandedNotes.has(v.id) ? "visible" : "hidden",
                      textOverflow: expandedNotes.has(v.id) ? "clip" : "ellipsis",
                      lineHeight: 1.5,
                    }}
                    onClick={() => toggleNote(v.id)}
                    title={v.visit_note}
                  >
                    {v.visit_note}
                  </span>
                  <span
                    onClick={() => toggleNote(v.id)}
                    style={{
                      color: "#1890ff",
                      cursor: "pointer",
                      marginLeft: 4,
                      fontSize: 12,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {expandedNotes.has(v.id) ? "收起" : "展开"}
                  </span>
                </div>
              )}

              {/* 行驶里程 */}
              {node.nextDistanceKm != null && (
                <div>
                  <Tag
                    style={{
                      ...tagBaseStyle,
                      backgroundColor: "#f5f5f5",
                      border: "1px solid #d9d9d9",
                      color: "#333333",
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
