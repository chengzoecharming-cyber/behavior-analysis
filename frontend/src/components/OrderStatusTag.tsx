import { Tag, Popover } from "@douyinfe/semi-ui";
import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import { VisitOrderStatus, VisitOrderStatusOrder } from "../api";
import { formatBeijingTime } from "../utils/time";

interface OrderStatusTagProps {
  info: VisitOrderStatus;
  coverageFrom?: string | null;
}

const tagStyle: CSSProperties = {
  fontSize: 12,
  height: 20,
  padding: "2px 8px",
  display: "inline-flex",
  alignItems: "center",
  cursor: "pointer",
};

function fmt(iso: string | null): string {
  return iso ? formatBeijingTime(iso) : "—";
}

function oaStatusText(o: VisitOrderStatusOrder): string {
  const base =
    o.oa_status === "COMPLETED" ? "已完成" : o.oa_status === "RUNNING" ? "审批中" : "已终止";
  if (o.oa_status === "COMPLETED" && o.oa_result === "refuse") return "已完成（拒绝）";
  if (o.oa_status === "COMPLETED" && o.oa_result === "agree") return "已完成（同意）";
  return base;
}

function OrderRow({ order }: { order: VisitOrderStatusOrder }) {
  return (
    <div style={{ padding: "4px 0", borderTop: "1px solid #f0f0f0", fontSize: 12 }}>
      <span style={{ color: "#0f1419" }}>
        {order.order_type === "agent" ? "代理商单" : "普通单"} · {oaStatusText(order)}
      </span>
      {order.match_status === "matched_by_exact_name" && (
        <span style={{ color: "#d48806" }}>（名称匹配待复核）</span>
      )}
      {order.delivery_status === "delivered" && (
        <span style={{ color: "#666" }}> · 交付资料较完整（待核实）</span>
      )}
      <div style={{ color: "#888" }}>申请创建：{fmt(order.oa_create_time)}</div>
    </div>
  );
}

/**
 * 拜访客户名旁的合并状态 Tag（CRM 阶段 + OA 订单数，admin-only 由调用方控制渲染）。
 * 标签只显示阶段 + 订单数；Popover 内分 CRM 与订单两段，订单标注与本次拜访的先后。
 */
export default function OrderStatusTag({ info, coverageFrom }: OrderStatusTagProps) {
  const coverageNote = `OA 订单历史仅覆盖近 365 天（${coverageFrom || "近一年"}起），更早订单不在统计内`;

  // 标签文本：CRM 阶段 / 公海 / 无 CRM，有订单时仅追加数量
  const stageLabel = info.crm_stage
    ? info.crm_stage.split(/[\\/]/)[0]
    : info.crm_in_pool
      ? "公海"
      : "无 CRM";
  const orderLabel =
    info.status === "has_orders"
      ? `${info.reliable_count}`
      : info.status === "pending_review"
        ? "待核查"
        : "";
  const label = orderLabel ? `${stageLabel} · ${orderLabel}` : stageLabel;

  // 颜色：阶段滞后 > 有订单 > 待核查 > 有 CRM 阶段 > 灰
  let color: "orange" | "green" | "blue" | "grey";
  if (info.stage_maybe_outdated) color = "orange";
  else if (info.status === "has_orders") color = "green";
  else if (info.status === "pending_review") color = "orange";
  else if (info.crm_stage || info.crm_in_pool) color = "blue";
  else color = "grey";

  const crmSection =
    info.crm_stage || info.crm_in_pool ? (
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>
          CRM 阶段：{info.crm_stage || "无阶段"}
          {info.crm_in_pool ? "（公海）" : info.crm_owner ? `（${info.crm_owner} 的私海）` : ""}
        </div>
        {info.stage_maybe_outdated && (
          <div style={{ color: "#d48806" }}>
            OA 已有可靠订单，但 CRM 阶段仍是早期阶段——CRM 状态可能未更新，以 OA 订单为准。
          </div>
        )}
      </div>
    ) : (
      <div style={{ marginBottom: 6, color: "#999" }}>CRM 中未找到该客户</div>
    );

  const content = (
    <div style={{ maxWidth: 360, fontSize: 12 }}>
      {crmSection}
      {info.status === "has_orders" && (
        <>
          <div>
            普通 {info.direct_count} / 代理商 {info.agent_count}
            {info.orders[0] ? ` · ${oaStatusText(info.orders[0])}` : ""}
          </div>
          {info.orders.map((o) => (
            <OrderRow key={o.process_instance_id} order={o} />
          ))}
          {info.reliable_count > info.orders.length && (
            <div style={{ color: "#999", marginTop: 4 }}>
              仅展示前 {info.orders.length} 张，完整列表见客户详情
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            {info.customer_id ? (
              <Link to={`/customers/${info.customer_id}`} target="_blank">
                查看客户详情订单区 →
              </Link>
            ) : (
              <span style={{ color: "#999" }}>无关联客户档案，暂无核查入口</span>
            )}
          </div>
        </>
      )}
      {info.status === "pending_review" && (
        <div>
          存在 {info.candidate_count} 张名称相近的 OA 订单，但未能确认归属（歧义或未匹配），
          请到客户详情「待核查候选」人工核实。
        </div>
      )}
      {info.status === "no_orders" && <div>未发现可靠订单记录。</div>}
      <div style={{ color: "#bbb", marginTop: 6, fontSize: 11 }}>{coverageNote}</div>
    </div>
  );

  return (
    <Popover content={content} showArrow contentClassName="trajectory-tag-popover">
      <Tag color={color} type="light" size="small" style={tagStyle}>
        {label}
      </Tag>
    </Popover>
  );
}
