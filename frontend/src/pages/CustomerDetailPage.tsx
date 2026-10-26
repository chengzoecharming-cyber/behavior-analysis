import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Spin, Table, Popover } from "@douyinfe/semi-ui";
import { IconArrowLeft, IconChevronDown, IconChevronRight } from "@douyinfe/semi-icons";
import { fetchCrmCustomerDetail } from "../api";
import type {
  CrmCustomerDetailResponse,
  CrmCustomerRelation,
  OaOrderMilestones,
} from "../types";
import { useIsMobile } from "../hooks/useIsMobile";

const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  enterprise_domestic: "国内企业",
  agent_domestic: "国内代理商",
  terminal_overseas: "海外终端",
  agent_overseas: "海外代理商",
};

const RELATION_LABELS: Record<CrmCustomerRelation, string> = {
  both: "跟进与拜访都有",
  follow_only: "只跟不访",
  visit_only: "只访不跟",
  none: "既无跟进也无拜访",
};

// ---- 页面级统一 token（不新建全局框架） ----
const C = {
  textPrimary: "#24262B",
  textSecondary: "#60646C",
  textTertiary: "#8A8D94",
  border: "#E9EAED",
  muted: "#F5F6F8",
  rowHover: "#FAFAFC",
};

type TagTone = "neutral" | "blue" | "green" | "orange" | "red" | "purple";

const TAG_TONES: Record<TagTone, { bg: string; fg: string }> = {
  neutral: { bg: "#F1F2F4", fg: "#565B64" },
  blue: { bg: "#EAF3FF", fg: "#2471D9" },
  green: { bg: "#E8F6EB", fg: "#27964C" },
  orange: { bg: "#FFF1E5", fg: "#C26A21" },
  red: { bg: "#FDEBEC", fg: "#C93D42" },
  purple: { bg: "#F1EDFF", fg: "#6548DD" },
};

/** 统一紧凑 Tag：12px/500，line-height 18px，padding 1px 6px，radius 4px */
function SoftTag({ tone, children }: { tone: TagTone; children: React.ReactNode }) {
  const t = TAG_TONES[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: "18px",
        padding: "1px 6px",
        borderRadius: 4,
        whiteSpace: "nowrap",
        backgroundColor: t.bg,
        color: t.fg,
      }}
    >
      {children}
    </span>
  );
}

function fmtTime(t: string | null): string {
  if (!t) return "—";
  return t.replace("T", " ").slice(0, 16);
}

function fmtDate(t: string | null): string {
  return t ? t.slice(0, 10) : "—";
}

const OA_STATUS_TONES: Record<string, TagTone> = {
  RUNNING: "blue",
  COMPLETED: "green",
  TERMINATED: "neutral",
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  unknown: "交付未知",
  pending: "待发货",
  shipped: "已发货",
  // 语义修正（2026-10-20）：date+photos+completed 仅为 OA 表单自述证据组合，
  // 不足以证实实际交付，统一展示为「交付资料较完整（待核实）」，不计入确定性已交付
  delivered: "交付资料较完整（待核实）",
  unverified: "待核实",
};

const DELIVERY_STATUS_TONES: Record<string, TagTone> = {
  unknown: "neutral",
  pending: "orange",
  shipped: "blue",
  delivered: "blue",
  unverified: "orange",
};

/** 交付状态推导来源的可读说明（A1 保守口径） */
const DELIVERY_BASIS_LABELS: Record<string, string> = {
  "date+photos+completed": "依据：OA 表单填写的交付日期+交付图片+审批完结（非交付系统回执）",
  approved_only: "依据：仅审批通过",
  none: "无交付证据",
};

/** 附件/图片计数（合同、需求附件、交付图片、验收资料） */
function attachmentCount(o: {
  contract_attachments: unknown;
  requirement_attachments: unknown;
  delivery_photos: unknown;
  acceptance_attachments: unknown;
}): number {
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return len(o.contract_attachments) + len(o.requirement_attachments) + len(o.delivery_photos) + len(o.acceptance_attachments);
}

// ---- 订单业务里程碑（milestone-v1） ----

const MILESTONE_DEFS: Array<{ key: keyof OaOrderMilestones["items"]; label: string }> = [
  { key: "contract_received", label: "合同接收" },
  { key: "erp_entered", label: "ERP 录入" },
  { key: "erp_pushed", label: "ERP 下推发货单" },
  { key: "erp_closed", label: "ERP 订单关闭" },
];

const CONFIDENCE_LABELS: Record<string, string> = {
  node_confirmed: "节点确认",
  comment_confirmed: "评论确认",
  comment_negated: "评论含否定信息，待核实",
};

/** 里程碑证据 Chips：已确认的节点可点击查看证据；未出现节点显示「未找到确认记录」 */
function MilestoneChips({ milestones }: { milestones: OaOrderMilestones | null }) {
  if (!milestones) {
    return <span style={{ fontSize: 12, color: C.textTertiary }}>操作证据未同步</span>;
  }
  const invalid = !milestones.final_status.valid;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {invalid ? (
        <SoftTag tone="red">
          单据已{milestones.final_status.oa_status === "TERMINATED" ? "撤销" : "拒绝"}，以下为历史操作证据
        </SoftTag>
      ) : null}
      {MILESTONE_DEFS.map((def) => {
        const entry = milestones.items[def.key];
        if (!entry) {
          return (
            <span key={def.key} style={{ fontSize: 12, color: C.textTertiary }}>
              {def.label}：未找到确认记录
            </span>
          );
        }
        const tone: TagTone = entry.confidence === "comment_negated" ? "orange" : invalid ? "neutral" : "green";
        return (
          <Popover
            key={def.key}
            content={
              <div style={{ maxWidth: 320, fontSize: 12, lineHeight: "20px" }}>
                <div>节点：{entry.node || "—"}</div>
                <div>时间：{entry.at ? fmtTime(entry.at) : "—"}</div>
                <div>确认方式：{CONFIDENCE_LABELS[entry.confidence] || entry.confidence}</div>
                {entry.remark_excerpt ? (
                  <div style={{ wordBreak: "break-word", color: "#60646C" }}>评论摘要：{entry.remark_excerpt}</div>
                ) : null}
              </div>
            }
          >
            <span style={{ cursor: "pointer", opacity: invalid ? 0.6 : 1 }}>
              <SoftTag tone={tone}>{def.label} ✓</SoftTag>
            </span>
          </Popover>
        );
      })}
    </div>
  );
}

/** 主内容 section：标题 + 细分隔线 + 内容（无厚 Card/阴影/大圆角） */
function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: C.textPrimary,
          paddingBottom: 10,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {title}
      </div>
      <div style={{ paddingTop: 18 }}>{children}</div>
    </section>
  );
}

/** Header metadata 项：label 12px 浅灰 + value 12px 深灰 */
function MetaItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, marginRight: 22 }}>
      <span style={{ fontSize: 12, color: C.textTertiary }}>{label}</span>
      <span style={{ fontSize: 12, color: C.textSecondary }}>{value}</span>
    </span>
  );
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [detail, setDetail] = useState<CrmCustomerDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      try {
        setDetail(await fetchCrmCustomerDetail(id));
      } catch (err: any) {
        if (err?.response?.status === 404) setNotFound(true);
        else console.error("加载客户详情失败:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // 动态时间线：CRM 跟进记录 + 实际拜访记录合并按时间倒序（数据口径不变）
  const timelineRows = useMemo(() => {
    if (!detail) return [];
    interface Row {
      key: string;
      time: string;
      kind: "follow" | "visit";
      person: string;
      summary: React.ReactNode;
    }
    const rows: Row[] = [];
    detail.follow_records.forEach((f, i) => {
      if (!f.create_time) return;
      rows.push({
        key: `f-${f.id ?? i}`,
        time: f.create_time,
        kind: "follow",
        person: f.create_user_name || "—",
        summary: (
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {f.follow_type ? `[${f.follow_type}] ` : ""}
            {f.content || "—"}
          </span>
        ),
      });
    });
    detail.visits.forEach((v, i) => {
      rows.push({
        key: `v-${v.visit_id ?? i}`,
        time: v.time,
        kind: "visit",
        person: v.user_name || "—",
        summary: (
          <span style={{ wordBreak: "break-word" }}>
            {v.matched_name}
            {v.address ? (
              <span style={{ color: C.textTertiary }}>　{v.address}</span>
            ) : null}
          </span>
        ),
      });
    });
    rows.sort((a, b) => (a.time < b.time ? 1 : -1));
    return rows;
  }, [detail]);

  if (loading) {
    return (
      <div style={{ backgroundColor: "#fff", padding: 48, textAlign: "center", minHeight: "100%" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div style={{ backgroundColor: "#fff", padding: 48, minHeight: "100%" }}>
        <a onClick={() => navigate("/customers")} style={{ cursor: "pointer", color: C.textSecondary }}>
          ← 客户列表
        </a>
        <div style={{ marginTop: 24, fontSize: 13, color: C.textTertiary }}>
          {notFound ? "客户不存在" : "加载失败"}
        </div>
      </div>
    );
  }

  const {
    customer,
    contacts,
    insights,
    snapshot_date,
    orders,
    orders_status,
    unconfirmed_order_candidates,
    orders_history_since,
  } = detail;

  const extraEntries = Object.entries(customer.extra || {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );

  const relationTone: TagTone =
    insights.relation === "both"
      ? "green"
      : insights.relation === "none"
      ? "neutral"
      : "blue";

  // 关键判断指标组（保留全部现有指标与判断逻辑）
  const metrics: { label: string; value: React.ReactNode }[] = [
    {
      label: "跟进 × 拜访关系",
      value: <SoftTag tone={relationTone}>{RELATION_LABELS[insights.relation]}</SoftTag>,
    },
    { label: "CRM 跟进次数", value: insights.follow_count },
    { label: "实际拜访次数", value: insights.visit_count },
    {
      label: "最近跟进",
      value: <span style={{ fontSize: 14, fontWeight: 500 }}>{fmtDate(insights.last_follow_time)}</span>,
    },
    {
      label: "最近拜访",
      value: <span style={{ fontSize: 14, fontWeight: 500 }}>{fmtDate(insights.last_visit_time)}</span>,
    },
  ];

  // 跟进 × 外勤 × 订单链路三节点
  const chainNodes = [
    {
      title: "CRM 跟进",
      value: `${insights.follow_count} 次`,
      sub: `最近：${fmtDate(insights.last_follow_time)}`,
    },
    {
      title: "实际拜访（外勤签到）",
      value: `${insights.visit_count} 次`,
      sub: `最近：${fmtDate(insights.last_visit_time)}`,
    },
    {
      title: "OA 订单",
      value:
        orders_status === "pending_oa_sync" ? (
          <span style={{ color: C.textTertiary }}>未接入</span>
        ) : (
          `${orders.length} 单`
        ),
      sub:
        orders_status === "pending_oa_sync"
          ? "订单同步未配置"
          : orders_status === "has_unconfirmed_candidates"
          ? `含 ${unconfirmed_order_candidates.length} 条待核查候选`
          : orders.length > 0
          ? `最近：${fmtDate(orders[0]?.oa_create_time ?? null)}`
          : "已同步，暂无订单",
    },
  ];

  const timelineColumns = [
    {
      title: "时间",
      dataIndex: "time",
      width: 160,
      render: (t: string) => <span style={{ fontSize: 13, color: C.textSecondary }}>{fmtTime(t)}</span>,
    },
    {
      title: "事件类型",
      dataIndex: "kind",
      width: 110,
      render: (k: "follow" | "visit") =>
        k === "visit" ? <SoftTag tone="green">实际拜访</SoftTag> : <SoftTag tone="blue">CRM 跟进</SoftTag>,
    },
    {
      title: "负责人",
      dataIndex: "person",
      width: 100,
      render: (p: string) => <span style={{ fontSize: 13, color: C.textSecondary }}>{p}</span>,
    },
    {
      title: "事件摘要",
      dataIndex: "summary",
      render: (s: React.ReactNode) => <span style={{ fontSize: 13, color: C.textPrimary }}>{s}</span>,
    },
  ];

  const basicInfo: { label: string; value: React.ReactNode }[] = [
    { label: "客户类型", value: customer.customer_type ? CUSTOMER_TYPE_LABELS[customer.customer_type] || customer.customer_type : "—" },
    { label: "公私海", value: customer.is_in_pool ? "公海" : "私海" },
    { label: "跟进阶段", value: customer.follow_status || "—" },
    { label: "负责人", value: customer.owner_name || "—" },
    { label: "区域", value: customer.region || "—" },
    { label: "渠道", value: customer.channel || "—" },
    { label: "地址", value: customer.address || "—" },
    { label: "装机地址", value: customer.install_address || "—" },
    { label: "法人", value: customer.legal_person || "—" },
    { label: "竞争对手", value: customer.competitor || "—" },
    { label: "CRM 快照", value: snapshot_date || "—" },
  ];

  return (
    <div className="cust-detail" style={{ backgroundColor: "#FFFFFF", minHeight: "100%" }}>
      {/* 数据管理表格风格：表头灰底、行 hover、细线分隔 */}
      <style>{`
        .cust-detail .semi-table-thead .semi-table-row-head {
          background: ${C.muted} !important;
          font-size: 12px !important;
          font-weight: 500 !important;
          color: ${C.textSecondary} !important;
        }
        .cust-detail .semi-table-tbody .semi-table-row:hover .semi-table-row-cell {
          background: ${C.rowHover} !important;
        }
        .cust-detail .semi-table-row-cell { border-bottom: 1px solid ${C.border} !important; }
      `}</style>

      {/* Header：双层结构，横跨主内容和右侧栏 */}
      <header style={{ padding: "20px 24px 0", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <IconArrowLeft
            style={{ fontSize: 18, color: C.textTertiary, cursor: "pointer", flexShrink: 0 }}
            onClick={() => navigate("/customers")}
          />
          <span
            onClick={() => navigate("/customers")}
            style={{ fontSize: 18, fontWeight: 600, color: "#80838A", cursor: "pointer", flexShrink: 0 }}
          >
            客户列表
          </span>
          <span style={{ color: "#D0D2D6", fontSize: 18, flexShrink: 0 }}>/</span>
          <span
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: C.textPrimary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
            title={customer.name || ""}
          >
            {customer.name || "未命名客户"}
          </span>
          {insights.approving ? <SoftTag tone="orange">审批中</SoftTag> : null}
        </div>
        <div style={{ marginTop: 12, paddingBottom: 20, display: "flex", flexWrap: "wrap", rowGap: 8 }}>
          <MetaItem label="ID" value={customer.id} />
          <MetaItem label="Owner" value={customer.owner_name || "—"} />
          <MetaItem
            label="客户类型"
            value={customer.customer_type ? CUSTOMER_TYPE_LABELS[customer.customer_type] || customer.customer_type : "—"}
          />
          <MetaItem label="跟进阶段" value={customer.follow_status || "—"} />
          <MetaItem label="数据快照" value={`${snapshot_date || "—"}（手工导入，非实时）`} />
        </div>
      </header>

      {/* 主内容 + 右侧 Inspector 双栏 */}
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: "stretch" }}>
        {/* 主内容 */}
        <main style={{ flex: "1 1 auto", minWidth: 0, padding: "24px 24px 8px" }}>
          <Section title="关键判断">
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap", alignItems: "flex-end" }}>
              {metrics.map((m) => (
                <div key={m.label}>
                  <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: C.textPrimary, lineHeight: "28px" }}>
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {insights.no_follow_30d ? <SoftTag tone="red">超 30 天未跟进</SoftTag> : null}
              {insights.no_visit_30d ? <SoftTag tone="orange">超 30 天未拜访</SoftTag> : null}
              {insights.approving ? <SoftTag tone="orange">审批中超期待关注</SoftTag> : null}
              {!insights.no_follow_30d && !insights.no_visit_30d && !insights.approving ? (
                <SoftTag tone="green">近期跟进/拜访正常</SoftTag>
              ) : null}
            </div>
          </Section>

          <Section title="跟进 × 外勤 × 订单链路">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))",
                gap: 24,
              }}
            >
              {chainNodes.map((n) => (
                <div key={n.title}>
                  <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 6 }}>{n.title}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: C.textPrimary, lineHeight: "28px" }}>
                    {n.value}
                  </div>
                  <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 4 }}>{n.sub}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="动态时间线">
            {timelineRows.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textTertiary }}>暂无跟进或拜访动态</div>
            ) : (
              <Table
                columns={timelineColumns}
                dataSource={timelineRows}
                rowKey="key"
                pagination={timelineRows.length > 20 ? { pageSize: 20 } : false}
                size="middle"
              />
            )}
          </Section>

          <Section title="订单执行">
            {orders_status === "pending_oa_sync" ? (
              <div style={{ padding: "12px 0 4px" }}>
                <div style={{ fontSize: 13, color: C.textTertiary }}>订单同步未配置</div>
                <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 4 }}>
                  配置 DINGTALK_PROCESS_CODE_ORDER / DINGTALK_PROCESS_CODE_ORDER_AGENT 并执行回拉后，此处展示真实订单。
                </div>
              </div>
            ) : (
              <div>
                {orders_history_since ? (
                  <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 12 }}>
                    OA 订单历史数据自 {orders_history_since} 起（钉钉接口 365 天窗口限制，更早订单为数据缺口）。
                  </div>
                ) : null}
                {orders.length === 0 ? (
                  <div style={{ fontSize: 13, color: C.textTertiary }}>已同步，当前客户暂无可靠关联订单</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {orders.map((o) => (
                      <div
                        key={o.id}
                        style={{
                          border: `1px solid ${C.border}`,
                          borderRadius: 6,
                          padding: "12px 16px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: C.textPrimary }}>
                            {o.contract_no_raw || "（无合同编号）"}
                          </span>
                          {o.role === "agent" ? <SoftTag tone="purple">本客户为代理商</SoftTag> : null}
                          {o.order_type === "agent" && o.role === "customer" ? (
                            <SoftTag tone="blue">代理商单 · {o.agent_name_raw || "代理商未填"}</SoftTag>
                          ) : null}
                          <SoftTag tone={OA_STATUS_TONES[o.oa_status] || "neutral"}>
                            {o.oa_status}
                            {o.oa_result === "refuse" ? "·已拒绝" : ""}
                          </SoftTag>
                          <SoftTag tone={DELIVERY_STATUS_TONES[o.delivery_status] || "neutral"}>
                            {DELIVERY_STATUS_LABELS[o.delivery_status] || o.delivery_status}
                          </SoftTag>
                          {o.delivery_status === "unverified" || o.delivery_status === "delivered" ? (
                            <span style={{ fontSize: 12, color: C.textTertiary }}>
                              {DELIVERY_BASIS_LABELS[o.delivery_status_basis || ""] ||
                                `证据不足（${o.delivery_status_basis || "无"}），以原始字段为准`}
                            </span>
                          ) : null}
                          {o.customer_match_status === "matched_by_exact_name" ? (
                            <SoftTag tone="orange">名称匹配 · 待复核</SoftTag>
                          ) : null}
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <MilestoneChips milestones={o.milestones} />
                        </div>
                        <div style={{ marginTop: 8, fontSize: 13, color: C.textSecondary, lineHeight: "22px" }}>
                          {o.items.length > 0 ? (
                            <div>
                              需求产品：
                              {o.items
                                .map((it) => `${it.product_category} × ${it.quantity ?? "?"}`)
                                .join("；")}
                              {o.demand_type ? `（${o.demand_type}）` : ""}
                            </div>
                          ) : null}
                          <div style={{ color: C.textTertiary, fontSize: 12 }}>
                            {[
                              o.contract_entity ? `签约主体：${o.contract_entity}` : null,
                              o.originator_name ? `提交：${o.originator_name}` : null,
                              o.oa_create_time ? `提单：${fmtTime(o.oa_create_time)}` : null,
                              o.delivery_date ? `交付日期：${o.delivery_date}` : null,
                              o.installer_name ? `安装：${o.installer_name}` : null,
                            ]
                              .filter(Boolean)
                              .join("　")}
                          </div>
                          {o.logistics_note ? <div>物流：{o.logistics_note}</div> : null}
                          {o.agent_delivery_progress ? <div>代理商发货进度：{o.agent_delivery_progress}</div> : null}
                          {o.order_note ? (
                            <div style={{ color: C.textTertiary, wordBreak: "break-word" }}>订单说明：{o.order_note}</div>
                          ) : null}
                          {attachmentCount(o) > 0 ? (
                            <div style={{ fontSize: 12, color: C.textTertiary }}>附件/图片：{attachmentCount(o)} 个</div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {unconfirmed_order_candidates.length > 0 ? (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, marginBottom: 8 }}>
                      待核查候选（未确认关联，不计入成交）
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {unconfirmed_order_candidates.map((c) => (
                        <div
                          key={c.id}
                          style={{
                            border: `1px dashed ${C.border}`,
                            borderRadius: 6,
                            padding: "10px 16px",
                            fontSize: 13,
                            color: C.textSecondary,
                          }}
                        >
                          <span style={{ fontWeight: 500 }}>{c.customer_name_raw || "（客户名缺失）"}</span>
                          {c.order_type === "agent" ? (
                            <span style={{ color: C.textTertiary }}>　代理商：{c.agent_name_raw || "—"}</span>
                          ) : null}
                          <span style={{ color: C.textTertiary }}>
                            　{c.contract_no_raw || "无合同号"}　{c.oa_status}　{fmtDate(c.oa_create_time)}　
                            {c.originator_name || ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </Section>
        </main>

        {/* 右侧 Inspector：统一 section，无独立 Card */}
        <aside
          style={{
            flex: isMobile ? "1 1 auto" : "0 0 320px",
            width: isMobile ? "100%" : 320,
            borderLeft: isMobile ? "none" : `1px solid ${C.border}`,
            borderTop: isMobile ? `1px solid ${C.border}` : "none",
            padding: "24px 24px 8px",
          }}
        >
          <Section title="Basic Info">
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              {basicInfo.map((it) => (
                <div key={it.label} style={{ display: "flex", alignItems: "flex-start" }}>
                  <span style={{ flex: "0 0 90px", fontSize: 12, color: "#8A8D94", lineHeight: "20px" }}>
                    {it.label}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: "#303238",
                      lineHeight: "20px",
                      wordBreak: "break-word",
                      minWidth: 0,
                    }}
                  >
                    {it.value}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Customer Tags">
            {customer.tags?.length ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {customer.tags.map((t) => (
                  <SoftTag key={t} tone="purple">{t}</SoftTag>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 13, color: C.textTertiary }}>—</span>
            )}
          </Section>

          <Section title={`Contacts (${contacts.length})`}>
            {contacts.length === 0 ? (
              <span style={{ fontSize: 13, color: C.textTertiary }}>暂无联系人</span>
            ) : (
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {contacts.map((c, i) => (
                  <div
                    key={c.id}
                    style={{
                      padding: "10px 0",
                      borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>
                        {c.name || "—"}
                      </span>
                      {c.is_decision_maker === "是" ? <SoftTag tone="red">决策人</SoftTag> : null}
                    </div>
                    <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 3, wordBreak: "break-word" }}>
                      {[c.position, c.phone].filter(Boolean).join(" · ") || "无电话"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={
              <span
                onClick={() => setExtraOpen((v) => !v)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}
              >
                原始 CRM 字段
                {extraOpen ? (
                  <IconChevronDown style={{ fontSize: 14, color: C.textTertiary }} />
                ) : (
                  <IconChevronRight style={{ fontSize: 14, color: C.textTertiary }} />
                )}
              </span>
            }
          >
            {extraOpen ? (
              extraEntries.length === 0 ? (
                <span style={{ fontSize: 13, color: C.textTertiary }}>无额外字段</span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {extraEntries.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", alignItems: "flex-start" }}>
                      <span style={{ flex: "0 0 90px", fontSize: 12, color: "#8A8D94", lineHeight: "20px", wordBreak: "break-all" }}>
                        {k}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, color: "#303238", lineHeight: "20px", wordBreak: "break-word", minWidth: 0 }}>
                        {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <span style={{ fontSize: 12, color: C.textTertiary }}>{extraEntries.length} 项，点击标题展开</span>
            )}
          </Section>
        </aside>
      </div>
    </div>
  );
}
