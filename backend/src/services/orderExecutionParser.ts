/**
 * OA 订单执行单解析器（订单执行 / 【代理商】订单执行 两张表单）。
 *
 * 字段口径来自 2026-10-20 真实抽样调查（见计划文档/PRD-006）：
 * - 两张表单字段结构几乎一致；代理商单无「签约主体」，附件/收货地址字段名不同。
 * - 未填字段的 value 是字符串 "null"，必须显式判空（与 v2 同款坑）。
 * - OpenDataField「客户名称」value 为 "客户名称:XXX"；ext_value 的 dataList[0].relateId
 *   是 base64，解码 JSON 的 instanceId 与 crm_customers.id 同源（已实证）。
 * - 「客户名称」在两张表单里都是终端客户；「要发货的代理商名称」才是代理商。
 * - 需求产品 TableField 每行 rowValue 内含「产品分类」(DDSelectField) 与「产品数量」(NumberField)。
 *
 * 注意：本解析器输出订单事实，绝不产出 ParsedVisit。
 */

import { isOrderProcessCode, getDingTalkConfig } from "./dingtalk";

export const ORDER_PARSE_VERSION = "order-v5";

export interface ParsedOrderItem {
  rowNumber: string;
  productCategory: string;
  productKey: string;
  quantity: number | null;
  extra: Record<string, string>;
}

export interface ParsedOrder {
  processInstanceId: string;
  businessId: string;
  processCode: string;
  orderType: "direct" | "agent";
  customerNameRaw: string;
  crmInstanceId: string | null;
  crmStatusSnapshot: string | null;
  agentNameRaw: string | null;
  contractEntity: string | null;
  contractNoRaw: string | null;
  contractNos: string[];
  factoryRegion: string | null;
  demandType: string | null;
  radioModuleRemoved: string | null;
  orderNote: string | null;
  agentDeliveryProgress: string | null;
  customReviewRef: string | null;
  deliveryAddressRaw: string | null;
  logisticsNote: string | null;
  installerName: string | null;
  installerUserid: string | null;
  deliveryDate: string | null; // YYYY-MM-DD
  deliveryServiceNote: string | null;
  contractAttachments: any | null;
  requirementAttachments: any | null;
  jjyAttachments: any | null;
  deliveryPhotos: any | null;
  acceptanceAttachments: any | null;
  oaStatus: string;
  oaResult: string | null;
  deliveryStatus: "unknown" | "pending" | "shipped" | "delivered" | "unverified";
  /** 交付状态推导来源（证据组合），如 date+photos+completed / date_only / logistics_text / approved_only / none */
  deliveryStatusBasis: string;
  originatorUserid: string;
  originatorName: string;
  originatorDept: string;
  oaCreateTime: Date | null;
  oaFinishTime: Date | null;
  formJson: any;
  items: ParsedOrderItem[];
}

interface FormComponent {
  id?: string;
  name?: string;
  component_type?: string;
  value?: any;
  ext_value?: string;
}

// 钉钉未填字段的 value 是字符串 "null"
function clean(value: any): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s === "null") return null;
  return s;
}

// 附件/图片类字段：value 是 JSON 字符串，保留解析后的数组原文
function cleanJson(value: any): any | null {
  const s = clean(value);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function findById(components: FormComponent[], id: string): FormComponent | undefined {
  return components.find((c) => c.id === id);
}

function textById(components: FormComponent[], id: string): string | null {
  return clean(findById(components, id)?.value);
}

function jsonById(components: FormComponent[], id: string): any | null {
  return cleanJson(findById(components, id)?.value);
}

/** 解码 OpenDataField ext_value 中的 CRM relateId → instanceId */
export function decodeCrmInstanceId(extValue?: string): string | null {
  if (!extValue) return null;
  try {
    const ext = JSON.parse(extValue);
    const relateId = ext?.dataList?.[0]?.relateId || ext?.relateId;
    if (!relateId) return null;
    const decoded = JSON.parse(Buffer.from(relateId, "base64").toString("utf8"));
    return decoded.instanceId || null;
  } catch {
    return null;
  }
}

/** 从 ext_value 详情文本抽取「客户状态:XX」快照 */
function extractCrmStatus(extValue?: string): string | null {
  if (!extValue) return null;
  try {
    const ext = JSON.parse(extValue);
    const detail: string = ext?.dataList?.[0]?.data?.find((d: any) => d.key === "relatedFieldId")?.value || "";
    const m = detail.match(/客户状态:([^\n]+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** 合同编号清洗：去「合同号：」类前缀，按空白/中文逗号拆分多单号；
 *  单个 token 内残留「主柜合同：XPFxxx」「苏州小胖蜂同号：XPFxxx」等标签时剥到最后一个冒号后 */
export function splitContractNos(raw: string | null): string[] {
  if (!raw) return [];
  const cleaned = raw.replace(/合同号\s*[:：]\s*/g, " ").replace(/[，、；;]/g, " ");
  return cleaned
    .split(/\s+/)
    .map((s) => {
      let t = s.trim();
      const idx = Math.max(t.lastIndexOf("："), t.lastIndexOf(":"));
      if (idx >= 0 && idx < t.length - 4) t = t.slice(idx + 1);
      return t;
    })
    .filter((s) => {
      // 有效合同号：至少含一个数字、长度 ≥ 5、排除手机号（如「合同编号:XPF… 沈尚濠 186…」混入）
      if (!/[0-9]/.test(s) || s.length < 5) return false;
      if (/^1[3-9]\d{9}$/.test(s)) return false;
      return true;
    });
}

/** 解析需求产品 TableField */
function parseItems(raw: any): ParsedOrderItem[] {
  const s = clean(raw);
  if (!s) return [];
  let rows: any[];
  try {
    rows = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const items: ParsedOrderItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells: any[] = row?.rowValue || [];
    let category = "";
    let productKey = "";
    let quantity: number | null = null;
    const extra: Record<string, string> = {};
    for (const cell of cells) {
      const label = cell?.label || "";
      const value = clean(cell?.value);
      if (label === "产品分类") {
        category = value || "";
        productKey = cell?.extendValue?.key || cell?.key || "";
      } else if (label === "产品数量") {
        const n = value ? parseFloat(value) : NaN;
        quantity = Number.isFinite(n) ? n : null;
      } else if (label && value) {
        extra[label] = value;
      }
    }
    items.push({
      rowNumber: row?.rowNumber || `row_${i}`,
      productCategory: category,
      productKey: productKey,
      quantity,
      extra,
    });
  }
  return items;
}

/** InnerContactField：ext_value JSON 数组取第一个的 emplId/name */
function parseInnerContact(component?: FormComponent): { name: string | null; userid: string | null } {
  if (!component) return { name: null, userid: null };
  const name = clean(component.value);
  let userid: string | null = null;
  try {
    const arr = JSON.parse(component.ext_value || "[]");
    if (Array.isArray(arr) && arr[0]?.emplId) userid = String(arr[0].emplId);
  } catch {
    // 忽略 ext 解析失败
  }
  return { name, userid };
}

function parseBeijingDateTime(s?: string): Date | null {
  if (!s) return null;
  // 钉钉返回 "2026-10-19 21:05:43"（北京时间），按 +08:00 解释
  const d = new Date(s.replace(" ", "T") + "+08:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 解析订单执行审批实例。
 * @throws 非订单 process_code 直接抛错（防御：其他 code 不得进入订单管线）
 */
export function parseOrderExecution(instance: any, processCode: string): ParsedOrder {
  if (!isOrderProcessCode(processCode)) {
    throw new Error(`parseOrderExecution 拒绝未知 process_code: ${processCode}`);
  }
  const cfg = getDingTalkConfig();
  const orderType: "direct" | "agent" = processCode === cfg.processCodeOrderAgent ? "agent" : "direct";
  const components: FormComponent[] = instance.form_component_values || [];

  // 客户名称（两张表单里都是终端客户）。
  // 新版表单：OpenDataField「客户名称」（ext_value 内嵌 CRM instanceId）；
  // 旧版表单（约 2026-03 前）：无 OpenDataField，客户名在 FormRelateField「客户」，
  // value 为 JSON 数组 ["客户名"]，无 CRM instanceId（ext_value 里的 instanceId 是
  // 关联 OA 表单实例 id，不是 CRM MDM id，不能作为 verified 依据）。
  const customerComp =
    findById(components, "OpenDataField_1EE5T9O33GDMO") ||
    findById(components, "OpenDataField_LTT4B8VGWQ2O") ||
    components.find((c) => c.component_type === "OpenDataField" && c.name === "客户名称");
  let customerNameRaw = (clean(customerComp?.value) || "").replace(/^客户名称\s*[:：]\s*/, "");
  let crmInstanceId = decodeCrmInstanceId(customerComp?.ext_value);
  let crmStatusSnapshot = extractCrmStatus(customerComp?.ext_value);

  if (!customerNameRaw) {
    const formRelate = components.find(
      (c) => c.component_type === "FormRelateField" && c.name === "客户" && clean(c.value)
    );
    const raw = clean(formRelate?.value);
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) customerNameRaw = String(arr[0] || "");
      } catch {
        customerNameRaw = raw;
      }
    }
  }

  const installer = parseInnerContact(findById(components, "InnerContactField_1H4OHHKRPK8W0"));

  // 附件字段名两张表单不同（id 相同）
  const contractAttachments = jsonById(components, "DDAttachment_1RJNWFF454IO0");
  const requirementAttachments = jsonById(components, "DDAttachment_1ILTJJ1MQ9TS0");

  const deliveryDate = textById(components, "DDDateField_EDLU5K6QMG00") || textById(components, "DDDateField_1G9XJXN2PU740");
  const deliveryPhotos = jsonById(components, "DDPhotoField_1DX1179WFRI80");
  const logisticsNote = textById(components, "TextField_VHVQV8J3GKG0");
  const oaStatus = instance.status || "";
  const oaResult = clean(instance.result);

  // 交付状态保守推导（A1 口径，2026-10-20）：
  // - 「审批通过 ≠ 已发货」；「交付日期非空 ≠ 实际交付完成」（可能是预计日期）；
  //   「物流文本非空 ≠ 已实际发货」（可能是发货计划）；「有附件 ≠ 验收完成」。
  // - delivered 唯一条件：交付日期 + 服务交付图片 + 审批完结通过 三类证据同时存在。
  // - 只有部分证据 → unverified（待核实），basis 记录具体证据组合，原始字段全部保留可查。
  const hasDate = !!deliveryDate;
  const hasPhotos = Array.isArray(deliveryPhotos) && deliveryPhotos.length > 0;
  const hasLogistics = !!logisticsNote;
  const serviceNote = textById(components, "TextareaField_PU10Z7403J40");
  const hasServiceClaim = !!serviceNote && /交付|验收|安装完成/.test(serviceNote);
  const approved = oaStatus === "COMPLETED" && oaResult === "agree";

  let deliveryStatus: ParsedOrder["deliveryStatus"];
  let deliveryStatusBasis: string;
  if (hasDate && hasPhotos && approved) {
    deliveryStatus = "delivered";
    deliveryStatusBasis = "date+photos+completed";
  } else if (hasDate || hasPhotos || hasLogistics || hasServiceClaim) {
    deliveryStatus = "unverified";
    const ev: string[] = [];
    if (hasDate) ev.push("date");
    if (hasPhotos) ev.push("photos");
    if (hasLogistics) ev.push("logistics");
    if (hasServiceClaim) ev.push("service_claim");
    deliveryStatusBasis = ev.join("+") + (approved ? "+approved" : "");
  } else if (approved) {
    deliveryStatus = "pending";
    deliveryStatusBasis = "approved_only";
  } else {
    deliveryStatus = "unknown";
    deliveryStatusBasis = "none";
  }

  const contractNoRaw = textById(components, "TextField_1DE99WBPYS5C0");
  const customReviewRaw = cleanJson(findById(components, "RelateField_1B0BXHLI7V6O0")?.value);

  return {
    processInstanceId:
      instance.process_instance_id || instance.processInstanceId || "",
    businessId: instance.business_id || instance.businessId || "",
    processCode,
    orderType,
    customerNameRaw,
    crmInstanceId,
    crmStatusSnapshot,
    agentNameRaw: textById(components, "TextField_UA2JSVDSJTS0"),
    contractEntity: orderType === "direct" ? textById(components, "DDSelectField_8E41ZCF8SWW0") : null,
    contractNoRaw,
    contractNos: splitContractNos(contractNoRaw),
    factoryRegion: textById(components, "DDSelectField_1QGGPPMARFR40"),
    demandType: textById(components, "DDSelectField_D4OYJHIBU7C0"),
    radioModuleRemoved:
      textById(components, "TextField_H1LMNDYMCXDS") || textById(components, "TextField_196OLIT8YXX4W"),
    orderNote: textById(components, "TextareaField_RUYO2I1TIHC0"),
    agentDeliveryProgress: textById(components, "TextareaField_1QO72LMVAUV40"),
    customReviewRef: Array.isArray(customReviewRaw) ? customReviewRaw.join("；") : clean(customReviewRaw),
    deliveryAddressRaw: textById(components, "TextField_1KNX13XPJLHC0"),
    logisticsNote,
    installerName: installer.name,
    installerUserid: installer.userid,
    deliveryDate,
    deliveryServiceNote: serviceNote,
    contractAttachments,
    requirementAttachments,
    jjyAttachments: jsonById(components, "DDAttachment_10ZQTV0B9TG00"),
    deliveryPhotos,
    acceptanceAttachments: orderType === "direct" ? jsonById(components, "DDAttachment_9OYG63OHMEBK") : null,
    oaStatus,
    oaResult,
    deliveryStatus,
    deliveryStatusBasis,
    originatorUserid: instance.originator_userid || instance.originatorUserId || "",
    originatorName: (instance.title || "").replace(/提交的.*$/, "") || instance.originator_user_name || "",
    originatorDept: instance.originator_dept_name || "",
    oaCreateTime: parseBeijingDateTime(instance.create_time),
    oaFinishTime: parseBeijingDateTime(instance.finish_time),
    formJson: instance.form_component_values || [],
    items: parseItems(findById(components, "TableField_1L8I9N4HOUPS0")?.value),
  };
}
