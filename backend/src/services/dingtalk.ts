import { ParsedVisit } from "../types";
import { processParsedVisits, ProcessResult } from "./normalization";
import { pool } from "../db";
import { parseDateTimeAsBeijing, formatBeijingDate } from "../utils/timezone";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { recomputeDerivedDataForVisits } from "./derivedComputation";
import { OrgTreeNode } from "./orgService";

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

// 通讯录用户信息缓存
const userNameCache: Record<string, string> = {};
const userDetailCache: Record<string, any> = {};

export async function getUserDetail(userid: string): Promise<any | null> {
  if (!userid) return null;
  if (userDetailCache[userid]) return userDetailCache[userid];

  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/v2/user/get",
    { access_token: accessToken },
    { userid, language: "zh_CN" }
  );

  if (data.errcode !== 0) {
    throw new Error(`DingTalk user/get failed for ${userid}: ${data.errmsg} (${data.errcode})`);
  }

  const result = data.result || null;
  if (result) userDetailCache[userid] = result;
  return result;
}

export async function getUserNameById(userid: string): Promise<string | null> {
  if (!userid) return null;
  if (userNameCache[userid]) return userNameCache[userid];

  try {
    const accessToken = await getAccessToken();
    const data = await httpPost(
      "/topapi/v2/user/get",
      { access_token: accessToken },
      { userid, language: "zh_CN" }
    );

    if (data.errcode !== 0) {
      console.warn(`[DingTalk user/get] failed for ${userid}: ${data.errmsg} (${data.errcode})`);
      return null;
    }

    const name = data.result?.name || null;
    if (name) userNameCache[userid] = name;
    return name;
  } catch (err: any) {
    console.warn(`[DingTalk user/get] error for ${userid}:`, err.message);
    return null;
  }
}

/**
 * 通过智能人事花名册查询员工姓名，主要用于已离职员工（通讯录接口返回 60121 时）。
 */
export async function getHrmUserNameById(userid: string): Promise<string | null> {
  if (!userid) return null;

  try {
    const accessToken = await getAccessToken();
    const data = await httpPost(
      "/topapi/smartwork/hrm/employee/list",
      { access_token: accessToken },
      { userid_list: userid }
    );

    if (data.errcode !== 0) {
      console.warn(`[DingTalk hrm/employee/list] failed for ${userid}: ${data.errmsg} (${data.errcode})`);
      return null;
    }

    const result = data.result?.[0];
    if (!result || !Array.isArray(result.field_list)) return null;

    const nameField = result.field_list.find((f: any) => f.field_code === "sys00-name");
    return nameField?.value || null;
  } catch (err: any) {
    console.warn(`[DingTalk hrm/employee/list] error for ${userid}:`, err.message);
    return null;
  }
}

export interface DingTalkDepartment {
  dept_id: number;
  parent_id?: number;
  name: string;
  create_dept_group?: boolean;
  auto_add_user?: boolean;
}

export async function getDepartmentList(
  parentDeptId = 1
): Promise<DingTalkDepartment[]> {
  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/v2/department/listsub",
    { access_token: accessToken },
    { dept_id: parentDeptId, language: "zh_CN" }
  );

  if (data.errcode !== 0) {
    throw new Error(`DingTalk department/listsub failed: ${data.errmsg} (${data.errcode})`);
  }

  const list: DingTalkDepartment[] = data.result || [];
  console.log(`[DingTalk department/listsub] parent=${parentDeptId}, count=${list.length}`);

  // 递归拉取子部门
  const allDepartments = [...list];
  for (const dept of list) {
    const children = await getDepartmentList(dept.dept_id);
    allDepartments.push(...children);
  }

  return allDepartments;
}

export interface DingTalkUser {
  userid: string;
  name: string;
  mobile?: string;
  title?: string;
  dept_id_list?: string;
  dept_order?: number;
  hide_mobile?: boolean;
  senior?: boolean;
  admin?: boolean;
  boss?: boolean;
}

export async function getDepartmentUsers(
  deptId: number,
  cursor = 0,
  size = 100
): Promise<{ list: DingTalkUser[]; nextCursor?: number }> {
  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/v2/user/list",
    { access_token: accessToken },
    { dept_id: deptId, cursor, size, language: "zh_CN" }
  );

  if (data.errcode !== 0) {
    throw new Error(`DingTalk user/list failed: ${data.errmsg} (${data.errcode})`);
  }

  const result = data.result || {};
  return {
    list: result.list || [],
    nextCursor: result.next_cursor,
  };
}

export async function fetchAllDepartmentUsers(
  deptId: number
): Promise<DingTalkUser[]> {
  const users: DingTalkUser[] = [];
  let cursor: number | undefined = 0;

  while (cursor !== undefined) {
    const result = await getDepartmentUsers(deptId, cursor);
    users.push(...result.list);
    cursor = result.nextCursor;
  }

  return users;
}

export async function syncContacts(
  targetDeptNames?: string[]
): Promise<{
  departments: number;
  users: number;
  errors: string[];
}> {
  if (!isDingTalkConfigured()) {
    throw new Error("DingTalk not configured");
  }

  const errors: string[] = [];

  // 1. 清空旧同步数据
  await pool.query("TRUNCATE dingtalk_departments, dingtalk_users");

  // 2. 拉取部门树
  let departments: DingTalkDepartment[] = [];
  try {
    departments = await getDepartmentList(1);
  } catch (err: any) {
    errors.push(`拉取部门失败: ${err.message}`);
    throw err;
  }

  // 3. 如果指定了目标部门，只同步目标部门及其子部门
  if (targetDeptNames && targetDeptNames.length > 0) {
    const normalizedTargets = targetDeptNames.map((n) => n.trim()).filter(Boolean);
    const childrenMap = new Map<number, number[]>();
    const deptById = new Map<number, DingTalkDepartment>();

    for (const dept of departments) {
      deptById.set(dept.dept_id, dept);
      if (dept.parent_id) {
        const siblings = childrenMap.get(dept.parent_id) || [];
        siblings.push(dept.dept_id);
        childrenMap.set(dept.parent_id, siblings);
      }
    }

    const collectSubtree = (deptId: number, collected: Set<number>) => {
      if (collected.has(deptId)) return;
      collected.add(deptId);
      const children = childrenMap.get(deptId) || [];
      for (const childId of children) {
        collectSubtree(childId, collected);
      }
    };

    const allowedIds = new Set<number>();
    for (const dept of departments) {
      if (normalizedTargets.includes(dept.name.trim())) {
        collectSubtree(dept.dept_id, allowedIds);
      }
    }

    if (allowedIds.size === 0) {
      return { departments: 0, users: 0, errors: [`未找到目标部门: ${normalizedTargets.join(", ")}`] };
    }

    departments = departments.filter((d) => allowedIds.has(d.dept_id));
  }

  for (const dept of departments) {
    try {
      await pool.query(
        `INSERT INTO dingtalk_departments (dept_id, parent_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (dept_id) DO UPDATE SET
           parent_id = EXCLUDED.parent_id,
           name = EXCLUDED.name`,
        [dept.dept_id, dept.parent_id ?? null, dept.name]
      );
    } catch (err: any) {
      errors.push(`保存部门 ${dept.name}(${dept.dept_id}) 失败: ${err.message}`);
    }
  }

  // 3. 拉取每个部门的用户
  let totalUsers = 0;
  const seenUserIds = new Set<string>();

  for (const dept of departments) {
    try {
      const users = await fetchAllDepartmentUsers(dept.dept_id);
      for (const user of users) {
        if (seenUserIds.has(user.userid)) continue;
        seenUserIds.add(user.userid);

        await pool.query(
          `INSERT INTO dingtalk_users
           (userid, name, mobile, title, dept_id_list, source_dept_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (userid) DO UPDATE SET
             name = EXCLUDED.name,
             mobile = EXCLUDED.mobile,
             title = EXCLUDED.title,
             dept_id_list = EXCLUDED.dept_id_list,
             source_dept_id = EXCLUDED.source_dept_id,
             updated_at = NOW()`,
          [
            user.userid,
            user.name,
            user.mobile || null,
            user.title || null,
            user.dept_id_list || null,
            dept.dept_id,
          ]
        );
        totalUsers++;
      }
    } catch (err: any) {
      errors.push(`拉取部门 ${dept.name}(${dept.dept_id}) 用户失败: ${err.message}`);
    }
  }

  return {
    departments: departments.length,
    users: totalUsers,
    errors,
  };
}

export interface DingTalkOrgUser {
  user_id: string;
  user_name: string;
  department?: string;
}

export async function getDingTalkOrgUsers(): Promise<DingTalkOrgUser[]> {
  const result = await pool.query(
    `SELECT u.userid, u.name, d.name AS department
     FROM dingtalk_users u
     LEFT JOIN dingtalk_departments d ON u.source_dept_id = d.dept_id
     ORDER BY u.name`
  );
  return result.rows.map((row) => ({
    user_id: row.userid,
    user_name: row.name,
    department: row.department || "",
  }));
}

export async function buildDingTalkOrgTree(): Promise<OrgTreeNode[]> {
  const [deptResult, userResult] = await Promise.all([
    pool.query(`SELECT dept_id, parent_id, name FROM dingtalk_departments ORDER BY dept_id`),
    pool.query(`SELECT userid, source_dept_id FROM dingtalk_users`),
  ]);

  const deptMap = new Map<number, OrgTreeNode>();
  const childrenMap = new Map<number, number[]>();

  for (const row of deptResult.rows) {
    const deptId = parseInt(row.dept_id, 10);
    const parentId = row.parent_id ? parseInt(row.parent_id, 10) : null;
    deptMap.set(deptId, {
      name: row.name,
      shortName: row.name,
      level: 0,
      children: [],
      userIds: [],
    });
    if (parentId) {
      const siblings = childrenMap.get(parentId) || [];
      siblings.push(deptId);
      childrenMap.set(parentId, siblings);
    }
  }

  for (const row of userResult.rows) {
    const sourceDeptId = parseInt(row.source_dept_id, 10);
    const node = deptMap.get(sourceDeptId);
    if (node) {
      node.userIds = node.userIds || [];
      node.userIds.push(row.userid);
    }
  }

  const buildNode = (deptId: number, level: number): OrgTreeNode | null => {
    const node = deptMap.get(deptId);
    if (!node) return null;
    node.level = level;
    const childIds = childrenMap.get(deptId) || [];
    for (const childId of childIds) {
      const child = buildNode(childId, level + 1);
      if (child) node.children.push(child);
    }
    return node;
  };

  const roots: OrgTreeNode[] = [];
  for (const row of deptResult.rows) {
    const deptId = parseInt(row.dept_id, 10);
    const parentId = row.parent_id ? parseInt(row.parent_id, 10) : null;
    if (!parentId || parentId === 1 || !deptMap.has(parentId)) {
      const root = buildNode(deptId, 1);
      if (root) roots.push(root);
    }
  }

  return roots;
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
  console.log(`[DingTalk listids] process_code=${cfg.processCode}, range=${startTimeMs}-${endTimeMs}, raw_result=`, JSON.stringify(result));
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

// 根据审批模板名称查找 process_code
export async function getProcessCodeByName(name: string): Promise<string | null> {
  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/process/get_by_name",
    { access_token: accessToken },
    { name }
  );

  console.log(`[DingTalk get_by_name] name=${name}, response=`, JSON.stringify(data));

  if (data.errcode !== 0) {
    throw new Error(`DingTalk get_by_name failed: ${data.errmsg} (${data.errcode})`);
  }

  return data.result?.process_code || null;
}

interface FormComponent {
  id?: string;
  name: string;
  value: string;
  ext_value?: string;
  component_type?: string;
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
    } else if (/^本次拜访情况\d*$/.test(name)) {
      visit.visit_note = value;
    } else if (name === "特殊签到原因") {
      visit.special_sign_reason = value;
    } else if (name === "打卡地") {
      visit.location_name = value;
    } else if (/^里程照片和拜访客户照片\d*$/.test(name)) {
      visit.photos = parsePhotoUrls(value);
    }
  }

  return visit;
}

// 解析 TimeAndLocationField 的 value：["时间", 经度, 纬度, "地址", 精度]
function parseTimeLocationValue(value: string): { time: string; lng: number; lat: number; address: string } | null {
  try {
    const arr = JSON.parse(value);
    if (!Array.isArray(arr) || arr.length < 4) return null;
    return {
      time: String(arr[0]),
      lng: parseFloat(arr[1]),
      lat: parseFloat(arr[2]),
      address: String(arr[3] || ""),
    };
  } catch {
    return null;
  }
}

// 解析照片字段的 JSON 数组字符串，返回 URL 列表
function parsePhotoUrls(value: string): string[] {
  if (!value || value === "null") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && item.startsWith("http"));
    }
  } catch {
    // 不是 JSON，可能是单个 URL
    if (value.startsWith("http")) return [value];
  }
  return [];
}

// 从 "华南/徐加乐 赣K56927" 或 "浙江/贺鹏程 川A E495Q" 中提取车牌和用户名
function parseVehicle(value: string): { vehicle: string; plate: string; userName: string } {
  const vehicle = value.trim();
  const parts = vehicle.split("/");
  const region = parts[0] || "";
  const rest = parts.slice(1).join("/").trim();
  const namePlateParts = rest.split(/\s+/);
  const userName = namePlateParts[0] || "";
  const plate = namePlateParts.slice(1).join(" ") || rest;
  return { vehicle, plate, userName };
}

// 判断是否为「用车里程登记&客户签到」这类多段行程表单
function isMultiStopRouteForm(instance: any): boolean {
  const title = (instance.title || instance.process_instance_id || "").toString();
  return /用车里程|客户签到|里程登记|外出签到/.test(title);
}

// 从表单关联字段、OpenDataField、TableField 等值中提取可读的名称
function extractReadableName(value: string): string {
  if (!value || value === "null") return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => item?.name || item?.label || item?.title || "").filter(Boolean).join(", ");
    }
    return parsed?.name || parsed?.label || parsed?.title || "";
  } catch {
    return value.length > 50 ? "" : value;
  }
}

// 解析一个审批实例，返回一条或多条 ParsedVisit
export async function parseApprovalInstance(instance: any): Promise<ParsedVisit[]> {
  const formComponents: FormComponent[] = instance.form_component_values || [];

  // 通用单表单独回退
  if (!isMultiStopRouteForm(instance)) {
    const parsed = parseApprovalForm(formComponents);
    if (!parsed.user_name) parsed.user_name = instance.originator_user_name || "";
    parsed.user_id = instance.originator_userid || instance.originatorUserId || "";
    if (!parsed.time) return [];
    return [parsed as ParsedVisit];
  }

  // 多段行程解析：一个 TimeAndLocationField = 一个 visit 点
  const originatorUserId = instance.originator_userid || instance.originatorUserId || "";
  const originatorUserName = instance.originator_user_name || instance.originatorUserName || "";
  const department = instance.originator_dept_name || instance.originatorDeptName || "销售部";
  const approvalId = instance.business_id || instance.businessId || instance.process_instance_id || instance.processInstanceId || "";

  const findValue = (pattern: RegExp): string | undefined => {
    for (const c of formComponents) {
      const name = (c.name || "").trim();
      const value = (c.value || "").trim();
      if (pattern.test(name) && value && value !== "null") return value;
    }
    return undefined;
  };

  const tripType = findValue(/请选择出行方式/);
  const isPublicTransport = /公共交通/.test(tripType || "");

  const vehicleRaw = isPublicTransport ? undefined : findValue(/选择出行车辆/);
  const startOdometer = isPublicTransport
    ? NaN
    : parseFloat(findValue(/出发里程读数/) || "NaN");

  // 解析车辆信息，同时拿到用户名
  const vehicleInfo = vehicleRaw ? parseVehicle(vehicleRaw) : undefined;

  // 用户名 fallback：originator_user_name → 表单姓名 → 车辆字段中的人名 → 通讯录 API → originator_userid
  let userName = originatorUserName;
  if (!userName) {
    const formName = findValue(/^(姓名|申请人|提交人)$/);
    if (formName) userName = formName;
  }
  if (!userName && vehicleInfo?.userName) {
    userName = vehicleInfo.userName;
  }
  if (!userName && originatorUserId) {
    const contactName = await getUserNameById(originatorUserId);
    if (contactName) userName = contactName;
  }
  if (!userName) userName = originatorUserId;

  // 收集所有非空的 TimeAndLocationField，按表单顺序
  const stops: { index: number; parsed: ReturnType<typeof parseTimeLocationValue>; isSpecial: boolean }[] = [];
  for (let i = 0; i < formComponents.length; i++) {
    const c = formComponents[i];
    if (c.component_type !== "TimeAndLocationField") continue;
    const value = (c.value || "").trim();
    if (!value || value === "null") continue;
    const parsed = parseTimeLocationValue(value);
    if (!parsed) continue;
    const isSpecial = /打卡地|特殊签到/.test(JSON.stringify([c.name, c.id]));
    stops.push({ index: i, parsed, isSpecial });
  }

  if (stops.length === 0) {
    // 空表单：生成一条兜底记录，避免用户以为数据未同步
    const createTime = instance.create_time || instance.createTime;
    const parsedTime = createTime
      ? parseDateTimeAsBeijing(createTime).toISOString()
      : null;
    if (parsedTime) {
      return [
        {
          user_id: originatorUserId,
          user_name: userName,
          department,
          time: parsedTime,
          location_name: "未填写签到地点",
          address: "",
          customer_name: "",
          lat: null,
          lng: null,
          approval_id: approvalId,
          sequence: 1,
          trip_type: tripType || "",
          vehicle: vehicleInfo?.vehicle || "",
          visit_note: "表单未填写完整",
          special_sign_reason: "",
          photos: [],
          source_detail: "empty_form",
        },
      ];
    }
    return [];
  }

  const vehicle = vehicleInfo?.vehicle;

  // 为每个 stop 找附近上下文（客户、拜访情况、里程读数）
  const findNearby = (stopIndex: number, pattern: RegExp): string | undefined => {
    // 在当前 stop 后面最多 8 个字段里找
    for (let i = stopIndex + 1; i < Math.min(stopIndex + 9, formComponents.length); i++) {
      const c = formComponents[i];
      if (c.component_type === "TimeAndLocationField") break; // 遇到下一个定位字段停止
      const name = (c.name || "").trim();
      const value = (c.value || "").trim();
      if (pattern.test(name) && value && value !== "null") return value;
    }
    return undefined;
  };

  const visits: ParsedVisit[] = [];

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const sequence = i + 1;

    // 尝试提取客户名称
    const customerRaw = findNearby(stop.index, /^客户$/) || findNearby(stop.index, /客户名称/);
    const customerName = customerRaw ? extractReadableName(customerRaw) : "";

    // 拜访情况 / 特殊签到原因 / 打卡地 / 照片分开解析
    const visitNote = findNearby(stop.index, /^本次拜访情况\d*$/);
    const visitNoteText = visitNote && visitNote !== "null" ? visitNote : "";

    const specialSignReason = findNearby(stop.index, /^特殊签到原因$/);
    const specialSignReasonText = specialSignReason && specialSignReason !== "null" ? specialSignReason : "";

    const checkInPlace = findNearby(stop.index, /^打卡地$/);
    const checkInPlaceText = checkInPlace && checkInPlace !== "null" ? checkInPlace : "";

    const photosRaw = findNearby(stop.index, /^里程照片和拜访客户照片\d*$/);
    const photos = photosRaw ? parsePhotoUrls(photosRaw) : [];

    // 里程读数：第一个 stop 用出发里程，后续尝试找对应的终点里程读数
    let endOdometer: number | null = null;
    let reportedDistanceKm: number | null = null;
    let mileageNote = "";
    if (i === 0 && !isNaN(startOdometer)) {
      // 第一个点是出发点，不生成 visit，或仅记录为起点
    } else {
      const odoRaw = findNearby(stop.index, /^终点里程读数/);
      endOdometer = odoRaw && odoRaw !== "null" ? parseFloat(odoRaw) : null;
      if (endOdometer != null && !isNaN(startOdometer)) {
        const diff = endOdometer - startOdometer;
        if (diff >= 0 && diff <= MAX_MILEAGE_KM) {
          reportedDistanceKm = diff;
        } else {
          mileageNote = " [里程读数异常]";
        }
      }
    }

    const locationName =
      checkInPlaceText ||
      (stop.isSpecial ? "特殊签到点" : i === 0 ? "出发点" : `签到点${sequence}`);

    visits.push({
      user_id: originatorUserId,
      user_name: userName,
      department,
      time: stop.parsed!.time,
      location_name: locationName,
      address: stop.parsed!.address,
      customer_name: customerName,
      lat: stop.parsed!.lat,
      lng: stop.parsed!.lng,
      approval_id: approvalId,
      sequence,
      trip_type: tripType,
      vehicle,
      start_odometer: i === 0 ? startOdometer : undefined,
      end_odometer: endOdometer ?? undefined,
      reported_distance_km: reportedDistanceKm ?? undefined,
      visit_note: visitNoteText + mileageNote,
      special_sign_reason: specialSignReasonText,
      photos,
      source_detail: stop.isSpecial ? "special_sign_in" : i === 0 ? "trip_start" : undefined,
    });
  }

  return visits;
}

// 保存钉钉审批实例原始数据
export async function saveRawApproval(instance: any): Promise<void> {
  const approvalId = instance.business_id || instance.businessId || instance.process_instance_id || instance.processInstanceId || "";
  if (!approvalId) return;

  const originatorUserId = instance.originator_userid || instance.originatorUserId || "";
  const originatorUserName = instance.originator_user_name || instance.originatorUserName || "";
  const rawCreateTime = instance.create_time || instance.createTime || null;
  const rawFinishTime = instance.finish_time || instance.finishTime || null;
  const createTime = rawCreateTime ? parseDateTimeAsBeijing(rawCreateTime) : null;
  const finishTime = rawFinishTime ? parseDateTimeAsBeijing(rawFinishTime) : null;

  try {
    await pool.query(
      `INSERT INTO raw_approvals
       (approval_id, process_code, title, originator_userid, originator_user_name,
        originator_dept_name, create_time, finish_time, form_json, result, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'dingtalk')
       ON CONFLICT (approval_id) DO UPDATE SET
         title = EXCLUDED.title,
         originator_user_name = EXCLUDED.originator_user_name,
         originator_dept_name = EXCLUDED.originator_dept_name,
         finish_time = EXCLUDED.finish_time,
         form_json = EXCLUDED.form_json,
         result = EXCLUDED.result,
         status = EXCLUDED.status`,
      [
        approvalId,
        instance.process_code || instance.processCode || null,
        instance.title || null,
        originatorUserId,
        originatorUserName,
        instance.originator_dept_name || instance.originatorDeptName || null,
        createTime,
        finishTime,
        JSON.stringify(instance.form_component_values || []),
        instance.result || null,
        instance.status || null,
      ]
    );
  } catch (err) {
    console.error(`[saveRawApproval] failed for ${approvalId}:`, err);
  }
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
  endTimeMs: number,
  triggeredBy: "scheduler" | "manual" | "startup" = "manual"
): Promise<ProcessResult & { totalInstances: number; parsedVisits: number; parseFailures: number }> {
  if (!isDingTalkConfigured()) {
    throw new Error("DingTalk not configured");
  }

  const startDate = formatBeijingDate(new Date(startTimeMs));
  const endDate = formatBeijingDate(new Date(endTimeMs));

  // 把同日期范围未结束的旧记录标记为失败，避免页面上长期显示"进行中"
  await pool.query(
    `UPDATE dingtalk_sync_logs
     SET status = 'failed',
         error_message = '被后续同步任务中断',
         finished_at = NOW()
     WHERE status = 'running'
       AND start_date = $1
       AND end_date = $2`,
    [startDate, endDate]
  );

  const logResult = await pool.query(
    `INSERT INTO dingtalk_sync_logs
     (triggered_by, status, start_date, end_date, started_at)
     VALUES ($1, 'running', $2, $3, NOW())
     RETURNING id`,
    [triggeredBy, startDate, endDate]
  );
  const syncLogId = logResult.rows[0].id;

  const updateLog = async (
    status: "success" | "failed",
    data: {
      totalInstances?: number;
      parsedVisits?: number;
      parseFailures?: number;
      normalizedInserted?: number;
      skipped?: number;
    },
    errorMessage?: string
  ) => {
    await pool.query(
      `UPDATE dingtalk_sync_logs
       SET status = $1,
           total_instances = $2,
           parsed_visits = $3,
           parse_failures = $4,
           normalized_inserted = $5,
           skipped = $6,
           error_message = $7,
           finished_at = NOW()
       WHERE id = $8`,
      [
        status,
        data.totalInstances ?? 0,
        data.parsedVisits ?? 0,
        data.parseFailures ?? 0,
        data.normalizedInserted ?? 0,
        data.skipped ?? 0,
        errorMessage ?? null,
        syncLogId,
      ]
    );
  };

  try {
    const ids = await fetchAllApprovalIds(startTimeMs, endTimeMs);
    const parsedVisits: ParsedVisit[] = [];
    let parseFailures = 0;

    for (const id of ids) {
      try {
        const instance = await getApprovalDetail(id);

        // 先保存原始审批数据
        await saveRawApproval(instance);

        const visits = await parseApprovalInstance(instance);

        if (visits.length === 0) {
          parseFailures++;
          continue;
        }

        parsedVisits.push(...visits);
      } catch (err) {
        console.error(`Failed to parse DingTalk instance ${id}:`, err);
        parseFailures++;
      }
    }

    const result = await processParsedVisits(parsedVisits, "dingtalk");

    // 后台自动补算路线和异常，避免用户手动跑脚本
    if (result.affectedUserDates.length > 0) {
      recomputeDerivedDataForVisits(result.affectedUserDates).catch((err) => {
        console.error("[syncApprovals] 后台衍生数据计算失败:", err);
      });
    }

    const finalResult = {
      ...result,
      totalInstances: ids.length,
      parsedVisits: parsedVisits.length,
      parseFailures,
    };

    await updateLog(
      "success",
      {
        totalInstances: finalResult.totalInstances,
        parsedVisits: finalResult.parsedVisits,
        parseFailures: finalResult.parseFailures,
        normalizedInserted: finalResult.normalizedInserted,
        skipped: finalResult.skipped,
      }
    );

    return finalResult;
  } catch (err: any) {
    await updateLog("failed", {}, err.message || String(err));
    throw err;
  }
}
