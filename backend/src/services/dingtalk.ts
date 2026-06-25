import { ParsedVisit } from "../types";
import { processParsedVisits, ProcessResult } from "./normalization";

const DINGTALK_API_BASE = "https://oapi.dingtalk.com";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  processCode: string;
}

export function getDingTalkConfig(): DingTalkConfig {
  const appKey = process.env.DINGTALK_APP_KEY || "";
  const appSecret = process.env.DINGTALK_APP_SECRET || "";
  const processCode = process.env.DINGTALK_PROCESS_CODE || "";
  return { appKey, appSecret, processCode };
}

export function isDingTalkConfigured(): boolean {
  const cfg = getDingTalkConfig();
  return !!cfg.appKey && !!cfg.appSecret && !!cfg.processCode;
}

async function httpGet(path: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const url = `${DINGTALK_API_BASE}${path}?${query}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DingTalk API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function httpPost(path: string, query: Record<string, string>, body: any): Promise<any> {
  const q = new URLSearchParams(query).toString();
  const url = `${DINGTALK_API_BASE}${path}?${q}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`DingTalk API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60 * 1000) {
    return tokenCache.accessToken;
  }

  const cfg = getDingTalkConfig();
  if (!cfg.appKey || !cfg.appSecret) {
    throw new Error("DingTalk appKey/appSecret not configured");
  }

  const data = await httpGet("/gettoken", {
    appkey: cfg.appKey,
    appsecret: cfg.appSecret,
  });

  if (data.errcode !== 0) {
    throw new Error(`DingTalk gettoken failed: ${data.errmsg} (${data.errcode})`);
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

export async function getApprovalInstances(
  startTimeMs: number,
  endTimeMs: number,
  cursor = 0,
  size = 20
): Promise<{ list: string[]; nextCursor?: number }> {
  const cfg = getDingTalkConfig();
  const accessToken = await getAccessToken();

  const data = await httpPost(
    "/topapi/processinstance/listids",
    { access_token: accessToken },
    {
      process_code: cfg.processCode,
      start_time: startTimeMs,
      end_time: endTimeMs,
      size,
      cursor,
    }
  );

  if (data.errcode !== 0) {
    throw new Error(`DingTalk listids failed: ${data.errmsg} (${data.errcode})`);
  }

  const result = data.result || {};
  return {
    list: result.list || [],
    nextCursor: result.next_cursor,
  };
}

export async function getApprovalDetail(processInstanceId: string): Promise<any> {
  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/processinstance/get",
    { access_token: accessToken },
    { process_instance_id: processInstanceId }
  );

  if (data.errcode !== 0) {
    throw new Error(`DingTalk get instance failed: ${data.errmsg} (${data.errcode})`);
  }

  return data.process_instance;
}

interface FormComponent {
  name: string;
  value: string;
  ext_value?: string;
}

export function parseApprovalForm(formComponents: FormComponent[]): Partial<ParsedVisit> {
  const visit: Partial<ParsedVisit> = { department: "销售部" };

  for (const c of formComponents) {
    const name = (c.name || "").trim();
    const value = (c.value || "").trim();
    if (!value) continue;

    // 常见字段名映射（根据实际表单字段名调整）
    if (/姓名|申请人|提交人|员工/.test(name)) {
      visit.user_name = value;
    } else if (/时间|日期|外出时间|拜访时间/.test(name)) {
      visit.time = value;
    } else if (/地点|位置|拜访地点/.test(name)) {
      visit.location_name = value;
    } else if (/地址|详细地址/.test(name)) {
      visit.address = value;
    } else if (/客户|客户名称/.test(name)) {
      visit.customer_name = value;
    } else if (/经度|lng|longitude/.test(name)) {
      visit.lng = parseFloat(value);
    } else if (/纬度|lat|latitude/.test(name)) {
      visit.lat = parseFloat(value);
    } else if (/里程|距离|用车里程|行驶里程/.test(name)) {
      visit.reported_distance_km = parseFloat(value);
    } else if (/出行方式|交通工具|交通方式/.test(name)) {
      visit.trip_type = value;
    } else if (/车辆|车牌|用车/.test(name)) {
      visit.vehicle = value;
    } else if (/备注|说明|原因/.test(name)) {
      visit.visit_note = value;
    }
  }

  return visit;
}

export async function fetchAllApprovalIds(
  startTimeMs: number,
  endTimeMs: number
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: number | undefined = 0;

  while (cursor !== undefined) {
    const result = await getApprovalInstances(startTimeMs, endTimeMs, cursor);
    ids.push(...result.list);
    cursor = result.nextCursor;
  }

  return ids;
}

export async function syncApprovals(
  startTimeMs: number,
  endTimeMs: number
): Promise<ProcessResult & { totalInstances: number; parsedVisits: number; parseFailures: number }> {
  if (!isDingTalkConfigured()) {
    throw new Error("DingTalk not configured");
  }

  const ids = await fetchAllApprovalIds(startTimeMs, endTimeMs);
  const parsedVisits: ParsedVisit[] = [];
  let parseFailures = 0;

  for (const id of ids) {
    try {
      const instance = await getApprovalDetail(id);
      const formComponents: FormComponent[] = instance.form_component_values || [];
      const parsed = parseApprovalForm(formComponents);

      // 一个审批实例至少要有姓名和时间才认为有效
      if (!parsed.user_name || !parsed.time) {
        parseFailures++;
        continue;
      }

      parsedVisits.push(parsed as ParsedVisit);
    } catch (err) {
      console.error(`Failed to parse DingTalk instance ${id}:`, err);
      parseFailures++;
    }
  }

  const result = await processParsedVisits(parsedVisits, "dingtalk");

  return {
    ...result,
    totalInstances: ids.length,
    parsedVisits: parsedVisits.length,
    parseFailures,
  };
}
