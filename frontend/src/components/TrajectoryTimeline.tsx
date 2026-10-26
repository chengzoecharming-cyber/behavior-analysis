import { Timeline, Tag, Popover } from "@douyinfe/semi-ui";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { formatBeijingHHmm } from "../utils/time";
import { isMileageRequiredTrip } from "../utils/tripType";
import { Visit, Route, Anomaly } from "../types";
import { fetchAccompanyTypes, AccompanyType, fetchVisitOrderStatus, VisitOrderStatus } from "../api";
import { AnomalyItem } from "./AnomalyItem";
import OrderStatusTag from "./OrderStatusTag";

interface TrajectoryTimelineProps {
  visits: Visit[];
  routes: Route[];
  anomalies: Anomaly[];
  /** admin 时挂载 OA 订单状态 Tag（非 admin 不请求不渲染） */
  showOrderStatus?: boolean;
}

function splitVisitCustomerNames(name?: string | null): string[] {
  return (name || "")
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  showOrderStatus,
}: TrajectoryTimelineProps) {
  // 收集本时间线出现的全部陪同对象名，一次性识别类型（同事/客户/代理商）
  const accompanyNamesKey = useMemo(() => {
    const set = new Set<string>();
    for (const v of visits) {
      const a = v.visit_detail?.accompany;
      if (a) {
        a.split(/[、,，]/).map((s) => s.trim()).filter(Boolean).forEach((n) => set.add(n));
      }
    }
    return Array.from(set).join(",");
  }, [visits]);
  const [accompanyTypes, setAccompanyTypes] = useState<Record<string, AccompanyType>>({});
  useEffect(() => {
    let cancelled = false;
    const names = accompanyNamesKey ? accompanyNamesKey.split(",") : [];
    fetchAccompanyTypes(names)
      .then((t) => { if (!cancelled) setAccompanyTypes(t); })
      .catch(() => { /* 类型识别失败不影响展示 */ });
    return () => { cancelled = true; };
  }, [accompanyNamesKey]);

  // admin：批量解析本时间线客户名的 OA 订单状态（一次 POST）
  const customerNamesKey = useMemo(() => {
    if (!showOrderStatus) return "";
    const set = new Set<string>();
    for (const v of visits) {
      splitVisitCustomerNames(v.customer_name).forEach((n) => set.add(n));
    }
    return Array.from(set).join("\n");
  }, [visits, showOrderStatus]);
  const [orderStatuses, setOrderStatuses] = useState<Record<string, VisitOrderStatus>>({});
  const [orderCoverageFrom, setOrderCoverageFrom] = useState<string | null>(null);
  useEffect(() => {
    if (!showOrderStatus || !customerNamesKey) return;
    let cancelled = false;
    const names = customerNamesKey.split("\n");
    fetchVisitOrderStatus(names)
      .then((r) => {
        if (cancelled) return;
        setOrderStatuses(r.results || {});
        setOrderCoverageFrom(r.coverage_from);
      })
      .catch(() => { /* 订单状态解析失败不影响展示 */ });
    return () => { cancelled = true; };
  }, [customerNamesKey, showOrderStatus]);

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

  // v2 表单非开车行程：无起终概念，紫色「签n」按时间顺序编号
  let v2SignSeq = 0;

  const nodes: TimelineNode[] = sortedVisits.map((visit, idx) => {
    const isStart = idx === 0;
    const isEnd = idx === sortedVisits.length - 1;
    const isPublic = isPublicTransportVisit(visit);
    const isV2Sign = visit.form_version === "v2" && !isMileageRequiredTrip(visit.trip_type);
    const isRunningApproval = visit.approval_status === "RUNNING";

    let sequenceLabel: string;
    let markColor: string;
    if (isV2Sign) {
      v2SignSeq += 1;
      sequenceLabel = `签${v2SignSeq}`;
      markColor = MARK_COLORS.publicTransport;
    } else if (isPublic) {
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
                  {v.visit_detail?.accompany && (
                    <Tag
                      color="amber"
                      type="light"
                      size="small"
                      style={{ marginLeft: 6 }}
                    >
                      陪
                    </Tag>
                  )}
                  {showOrderStatus &&
                    (() => {
                      // 每次拜访只挂一个主状态 Tag：可靠订单 > 待核查 > 未发现订单
                      const infos = splitVisitCustomerNames(v.customer_name)
                        .map((n) => orderStatuses[n])
                        .filter((i): i is VisitOrderStatus => !!i);
                      if (infos.length === 0) return null;
                      const best =
                        infos.find((i) => i.status === "has_orders") ||
                        infos.find((i) => i.status === "pending_review") ||
                        infos[0];
                      return (
                        <span style={{ marginLeft: 6 }}>
                          <OrderStatusTag info={best} coverageFrom={orderCoverageFrom} />
                        </span>
                      );
                    })()}
                </div>
              )}

              {/* 陪同拜访（2026-10-15 v3 表单）：客户名下方一行展示陪同人及类型 */}
              {v.visit_detail?.accompany && (
                <div
                  style={{
                    fontSize: 13,
                    color: "#666",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={v.visit_detail.accompany}
                >
                  <span style={{ color: "#999" }}>陪同人：</span>
                  {v.visit_detail.accompany
                    .split(/[、,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((name, idx, arr) => (
                      <span key={`${name}-${idx}`}>
                        {name}
                        {accompanyTypes[name] && (
                          <Tag
                            color={accompanyTypes[name] === "同事" ? "blue" : accompanyTypes[name] === "代理商" ? "orange" : "green"}
                            type="light"
                            size="small"
                            style={{ marginLeft: 2 }}
                          >
                            {accompanyTypes[name]}
                          </Tag>
                        )}
                        {idx < arr.length - 1 ? "、" : ""}
                      </span>
                    ))}
                </div>
              )}

              {v.visit_note && (
                <div style={{ fontSize: 13, color: "#666", maxWidth: 500 }}>
                  <span style={{ color: "#999", whiteSpace: "nowrap" }}>拜访情况：</span>
                  <Popover
                    content={
                      <div style={{ maxWidth: 400, whiteSpace: "pre-wrap" }}>{v.visit_note}</div>
                    }
                    showArrow
                  >
                    <span
                      style={{
                        cursor: "default",
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                        maxWidth: "calc(500px - 6em)",
                        overflow: "hidden",
                        lineHeight: 1.5,
                      }}
                    >
                      {v.visit_note}
                    </span>
                  </Popover>
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
