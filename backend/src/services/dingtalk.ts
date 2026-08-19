import { ParsedVisit } from "../types";
import { processParsedVisits, ProcessResult } from "./normalization";
import { pool } from "../db";
import { parseDateTimeAsBeijing, formatBeijingDate, toBeijingDayStart, toBeijingDayEnd } from "../utils/timezone";
import { MAX_MILEAGE_KM } from "./mileageConfig";
import { recomputeDerivedDataForVisits } from "./derivedComputation";
import { OrgTreeNode, isExcludedTopDepartment } from "./orgService";
import crypto from "crypto";

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
  // 新审批表单（v2）process_code；空表示未启用，仅同步旧表单
  processCodeV2: string;
}

export function getDingTalkConfig(): DingTalkConfig {
  const appKey = process.env.DINGTALK_APP_KEY || "";
  const appSecret = process.env.DINGTALK_APP_SECRET || "";
  const processCode = process.env.DINGTALK_PROCESS_CODE || "";
  const processCodeV2 = process.env.DINGTALK_PROCESS_CODE_V2 || "";
  return { appKey, appSecret, processCode, processCodeV2 };
}

// 所有已配置、需要同步的 process_code 列表（旧表单 v1 + 新表单 v2）
export function getAllProcessCodes(): string[] {
  const cfg = getDingTalkConfig();
  return [cfg.processCode, cfg.processCodeV2].filter((c) => !!c);
}

export function isDingTalkConfigured(): boolean {
  const cfg = getDingTalkConfig();
  return !!cfg.appKey && !!cfg.appSecret && !!cfg.processCode;
}

// 判断 process_code 是否为 v2 新表单（解析分发依据，不按表单中文名判断）
export function isV2ProcessCode(processCode?: string | null): boolean {
  const v2 = getDingTalkConfig().processCodeV2;
  return !!v2 && !!processCode && processCode === v2;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        err.message?.includes("Unexpected token") ||
        err.message?.includes("is not valid JSON") ||
        err.message?.includes("timeout") ||
        err.message?.includes("fetch failed") ||
        err.message?.includes("DingTalk API error: 5") ||
        err.message?.includes("DingTalk API error: 429");

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }

      console.warn(
        `[DingTalk retry] ${context} failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`
      );
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function httpGet(path: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const url = `${DINGTALK_API_BASE}${path}?${query}`;

  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`DingTalk API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }, `GET ${path}`);
}

async function httpPost(path: string, query: Record<string, string>, body: any): Promise<any> {
  const q = new URLSearchParams(query).toString();
  const url = `${DINGTALK_API_BASE}${path}?${q}`;

  return withRetry(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`DingTalk API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }, `POST ${path}`);
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

// ===== 钉钉扫码登录（第三方网站扫码授权） =====
// clientId/clientSecret 复用企业内部应用的 DINGTALK_APP_KEY / DINGTALK_APP_SECRET，
// 需要在钉钉开放平台为该应用开通「扫码登录」能力并配置重定向 URL。

const DINGTALK_NEW_API_BASE = "https://api.dingtalk.com";

/** 生成钉钉扫码登录授权页 URL（用户扫码确认后跳转 redirect_uri 并带 authCode） */
export function getLoginAuthorizeUrl(redirectUri: string, state: string): string {
  const cfg = getDingTalkConfig();
  return (
    `https://login.dingtalk.com/oauth2/auth` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&client_id=${encodeURIComponent(cfg.appKey)}` +
    `&scope=openid&state=${encodeURIComponent(state)}&prompt=consent`
  );
}

/** 用 authCode 换用户级 accessToken（注意走 api.dingtalk.com 新域名，不是 oapi） */
export async function getUserAccessToken(authCode: string): Promise<string> {
  const cfg = getDingTalkConfig();
  const res = await fetch(`${DINGTALK_NEW_API_BASE}/v1.0/oauth2/userAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: cfg.appKey,
      clientSecret: cfg.appSecret,
      code: authCode,
      grantType: "authorization_code",
    }),
  });
  const data: any = await res.json();
  if (!res.ok || !data.accessToken) {
    throw new Error(`DingTalk userAccessToken failed: ${JSON.stringify(data)}`);
  }
  return data.accessToken;
}

/** 用用户级 token 查询扫码用户个人信息（unionId / nick / mobile） */
export async function getUserMeByUserToken(
  userToken: string
): Promise<{ unionId: string; nick?: string; mobile?: string }> {
  const res = await fetch(`${DINGTALK_NEW_API_BASE}/v1.0/contact/users/me`, {
    headers: { "x-acs-dingtalk-access-token": userToken },
  });
  const data: any = await res.json();
  if (!res.ok || !data.unionId) {
    throw new Error(`DingTalk contact/users/me failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/** 用应用 accessToken 把 unionId 换成企业内 userid（需通讯录读权限） */
export async function getUserIdByUnionId(unionId: string): Promise<string> {
  const accessToken = await getAccessToken();
  const data = await httpPost(
    "/topapi/user/getbyunionid",
    { access_token: accessToken },
    { unionid: unionId }
  );
  if (data.errcode !== 0) {
    throw new Error(`DingTalk getbyunionid failed: ${data.errmsg} (${data.errcode})`);
  }
  return data.result.userid;
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

/** 解析钉钉用户返回的 dept_id_list（支持 number[] / JSON 数组字符串 / PostgreSQL 数组文本 / 逗号分隔） */
function parseDeptIdList(value: string | number[] | undefined | null): number[] {
  if (!value) return [];

  // 钉钉 API 实际返回的是 number[]
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "number" ? item : parseInt(String(item), 10)))
      .filter((n) => !isNaN(n));
  }

  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  // JSON 数组格式：[1,2,3] 或 ["1","2","3"]
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: any) => (typeof item === "number" ? item : parseInt(String(item), 10)))
          .filter((n: number) => !isNaN(n));
      }
    } catch {
      // fall through
    }
  }

  // PostgreSQL 数组文本格式：{1,2,3} 或 {"1","2","3"}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));
  }

  // 逗号分隔：1,2,3
  return trimmed
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

/** 根据部门父子关系计算每个部门的深度（根部门深度为 1） */
function buildDepthMap(departments: DingTalkDepartment[]): Map<number, number> {
  const parentMap = new Map<number, number | null>();
  const depthMap = new Map<number, number>();

  for (const d of departments) {
    parentMap.set(d.dept_id, d.parent_id ?? null);
  }

  const getDepth = (deptId: number, visiting = new Set<number>()): number => {
    if (visiting.has(deptId)) return 1;
    const cached = depthMap.get(deptId);
    if (cached != null) return cached;

    visiting.add(deptId);
    const parentId = parentMap.get(deptId);
    let depth = 1;
    if (parentId && parentId !== 1 && parentMap.has(parentId)) {
      depth = getDepth(parentId, visiting) + 1;
    }
    depthMap.set(deptId, depth);
    return depth;
  };

  for (const d of departments) {
    getDepth(d.dept_id);
  }

  return depthMap;
}

/** 根据部门父子关系找到指定部门的顶层部门（防环） */
function getTopDepartment(
  deptId: number,
  deptMap: Map<number, DingTalkDepartment>,
  visiting = new Set<number>()
): DingTalkDepartment | null {
  if (visiting.has(deptId)) return null;
  visiting.add(deptId);
  const dept = deptMap.get(deptId);
  if (!dept) return null;
  if (!dept.parent_id || dept.parent_id === 1) return dept;
  return getTopDepartment(dept.parent_id, deptMap, visiting);
}

/** 从用户的 dept_id_list 中选择 source_dept_id
 *  策略：优先选择「顶层部门未被排除」的部门中层级最深的；
 *  若所有部门都在被排除的顶层下，则回退到全局最深。
 *  这样可避免「销售渠道」等辅助组织把销售部人员抢走，
 *  同时让真正挂在销售部子部门的人员落到子部门。
 */
function pickSourceDeptId(
  deptIdListStr: string | number[] | undefined | null,
  depthMap: Map<number, number>,
  deptMap: Map<number, DingTalkDepartment>
): number | null {
  const ids = parseDeptIdList(deptIdListStr);
  if (ids.length === 0) return null;

  let eligible = ids.filter((id) => {
    const top = getTopDepartment(id, deptMap);
    return top && !isExcludedTopDepartment(top.name);
  });

  // 如果所有部门都在被排除的顶层下，回退到全部部门
  if (eligible.length === 0) {
    eligible = ids;
  }

  let deepestId = eligible[0];
  let deepestDepth = depthMap.get(deepestId) || 1;

  for (const id of eligible) {
    const depth = depthMap.get(id) || 1;
    if (depth > deepestDepth) {
      deepestDepth = depth;
      deepestId = id;
    }
  }

  return deepestId;
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
  dept_id_list?: string | number[];
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

  // 原子替换策略：先把钉钉数据全部拉取到内存，再在单个事务里 TRUNCATE + 写入。
  // 任何一步拉取失败都不会触碰旧缓存（旧版本先 TRUNCATE 再拉取，
  // API 超时会把组织树清空，导致级联选择器只剩「全公司」）。

  // 1. 拉取部门树
  let departments: DingTalkDepartment[] = [];
  try {
    departments = await getDepartmentList(1);
  } catch (err: any) {
    errors.push(`拉取部门失败: ${err.message}`);
    throw err;
  }
  if (departments.length === 0) {
    throw new Error("拉取部门列表为空，取消同步以保护旧缓存");
  }

  // 2. 如果指定了目标部门，只同步目标部门及其子部门
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

  // 3. 拉取每个部门的用户，按用户聚合其完整 dept_id_list
  const userMap = new Map<string, DingTalkUser>();

  for (const dept of departments) {
    try {
      const users = await fetchAllDepartmentUsers(dept.dept_id);
      for (const user of users) {
        const existing = userMap.get(user.userid);
        if (!existing) {
          userMap.set(user.userid, { ...user });
        } else if (user.dept_id_list) {
          // 合并多个部门返回的 dept_id_list，避免信息丢失
          const mergedIds = new Set(parseDeptIdList(existing.dept_id_list));
          for (const id of parseDeptIdList(user.dept_id_list)) {
            mergedIds.add(id);
          }
          // 统一存为 JSON 字符串数组格式，便于后续解析
          existing.dept_id_list = JSON.stringify(Array.from(mergedIds));
        }
      }
    } catch (err: any) {
      errors.push(`拉取部门 ${dept.name}(${dept.dept_id}) 用户失败: ${err.message}`);
    }
  }

  // 防护：部门非空但一个用户都没拉到（如中途 token 失效、网络中断），放弃写入
  if (userMap.size === 0) {
    throw new Error(
      `未拉到任何用户（${errors.length} 个部门拉取失败），取消同步以保护旧缓存`
    );
  }

  // 4. 根据部门深度计算每个用户的 source_dept_id（纯内存计算，不写库）
  // 原则：用户同时在父部门和子部门时，优先归入层级最深的部门；
  // 仅挂在父部门的人员（如总 leader）仍保留在父部门；
  // 顶层被排除的部门（如销售渠道）不作为首选来源。
  const depthMap = buildDepthMap(departments);
  const deptMap = new Map<number, DingTalkDepartment>();
  for (const d of departments) deptMap.set(d.dept_id, d);

  // 5. 单个事务内原子替换：任一写入失败整体回滚，旧数据保留
  const client = await pool.connect();
  let totalUsers = 0;
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE dingtalk_departments, dingtalk_users");

    for (const dept of departments) {
      await client.query(
        `INSERT INTO dingtalk_departments (dept_id, parent_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (dept_id) DO UPDATE SET
           parent_id = EXCLUDED.parent_id,
           name = EXCLUDED.name`,
        [dept.dept_id, dept.parent_id ?? null, dept.name]
      );
    }

    for (const [userid, user] of userMap) {
      const sourceDeptId = pickSourceDeptId(user.dept_id_list, depthMap, deptMap);
      await client.query(
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
          userid,
          user.name,
          user.mobile || null,
          user.title || null,
          user.dept_id_list || null,
          sourceDeptId,
        ]
      );
      totalUsers++;
    }

    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK");
    errors.push(`写入数据库失败，已回滚保留旧缓存: ${err.message}`);
    throw err;
  } finally {
    client.release();
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
  size = 20,
  processCode?: string
): Promise<{ list: string[]; nextCursor?: number }> {
  const cfg = getDingTalkConfig();
  const code = processCode || cfg.processCode;
  const accessToken = await getAccessToken();

  const data = await httpPost(
    "/topapi/processinstance/listids",
    { access_token: accessToken },
    {
      process_code: code,
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
  console.log(`[DingTalk listids] process_code=${code}, range=${startTimeMs}-${endTimeMs}, raw_result=`, JSON.stringify(result));
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

// 从 "华南/徐加乐 赣K56927" 或 "浙江/贺鹏程 川A E495Q" 中提取车牌和车辆名
// （userName 是车辆的常用驾驶人，仅作信息保留，不能当作签到人姓名使用）
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

  function cleanCustomerName(v: string): string {
    if (!v) return "";
    return v
      .replace(/^客户名称[：:]/, "")
      .replace(/^客户[：:]/, "")
      .trim();
  }

  try {
    const parsed = JSON.parse(value);

    if (typeof parsed === "string") {
      return cleanCustomerName(parsed);
    }

    if (Array.isArray(parsed)) {
      const names: string[] = [];
      const seen = new Set<string>();
      const addName = (raw: string) => {
        const cleaned = cleanCustomerName(raw);
        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned);
          names.push(cleaned);
        }
      };

      for (const item of parsed) {
        if (typeof item === "string") {
          addName(item);
        } else if (item?.value) {
          addName(item.value);
        } else if (item?.label) {
          addName(item.label);
        } else if (item?.rowValue && Array.isArray(item.rowValue)) {
          // TableField 结构：rowValue 里包含 OpenDataField 子项
          for (const rv of item.rowValue) {
            if (rv?.value) {
              addName(rv.value);
            } else if (rv?.label) {
              addName(rv.label);
            } else if (typeof rv === "string") {
              addName(rv);
            }
          }
        }
      }
      return names.join(", ");
    }

    if (parsed?.value) return cleanCustomerName(parsed.value);
    if (parsed?.name) return cleanCustomerName(parsed.name);
    if (parsed?.label) return cleanCustomerName(parsed.label);
    if (parsed?.title) return cleanCustomerName(parsed.title);

    return "";
  } catch {
    return cleanCustomerName(value);
  }
}

// 解析一个审批实例，返回一条或多条 ParsedVisit
// processCode 用于新旧表单（v1/v2）解析分发：同步路径显式传入，
// 其他调用方（数据血缘重新解析）经 raw_approvals.process_code 传入
export async function parseApprovalInstance(instance: any, processCode?: string): Promise<ParsedVisit[]> {
  const code = processCode || instance.process_code || instance.processCode || "";
  if (isV2ProcessCode(code)) {
    return parseApprovalInstanceV2(instance);
  }
  const formComponents: FormComponent[] = instance.form_component_values || [];

  // 通用单表单独回退
  if (!isMultiStopRouteForm(instance)) {
    const parsed = parseApprovalForm(formComponents);
    if (!parsed.user_name) parsed.user_name = instance.originator_user_name || "";
    parsed.user_id = instance.originator_userid || instance.originatorUserId || "";
    (parsed as any).approval_status = instance.status || instance.result || "";
    if (!parsed.time) return [];
    return [parsed as ParsedVisit];
  }

  // 多段行程解析：一个 TimeAndLocationField = 一个 visit 点
  const originatorUserId = instance.originator_userid || instance.originatorUserId || "";
  const originatorUserName = instance.originator_user_name || instance.originatorUserName || "";
  const department = instance.originator_dept_name || instance.originatorDeptName || "销售部";
  const approvalId = instance.business_id || instance.businessId || instance.process_instance_id || instance.processInstanceId || "";
  const approvalStatus = instance.status || instance.result || "";

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

  // 解析车辆信息（车牌/车辆名；其中的人名不再用于推断签到人，见下方 fallback 注释）
  const vehicleInfo = vehicleRaw ? parseVehicle(vehicleRaw) : undefined;

  // 用户名 fallback：originator_user_name → 表单姓名 → 通讯录 API → originator_userid
  // 注意：不要用车辆字段中的人名兜底——vehicle 里的名字是「这辆车的常用驾驶人」
  // （如 公司车/陈总 粤B0PN76），别人开这辆车时会把姓名错写成车主（2026-07 串名事故）。
  let userName = originatorUserName;
  if (!userName) {
    const formName = findValue(/^(姓名|申请人|提交人)$/);
    if (formName) userName = formName;
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

  if (stops.length === 0) return [];

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

  // 在当前 stop 之前、上一个 stop 之后的区间内向前找
  // 用于客户名称字段：钉钉表单中员工在「是否前往下一个目的地」处填写的客户，
  // 语义上属于即将前往的下一个签到点，但物理位置排在当前 stop 的字段块里，
  // 若向后找会错挂到上一个 stop。
  const findBefore = (stopIndex: number, pattern: RegExp): string | undefined => {
    for (let i = stopIndex - 1; i >= 0; i--) {
      const c = formComponents[i];
      if (c.component_type === "TimeAndLocationField") break; // 遇到上一个定位字段停止
      const name = (c.name || "").trim();
      const value = (c.value || "").trim();
      if (pattern.test(name) && value && value !== "null") return value;
    }
    return undefined;
  };

  // 解析每个 stop 的累计里程："累计里程i"跟在 stop i 之后，表示从出发到 stop i 的累计里程。
  // 循环变量 j 遍历 stop 0..n-2，对每个 stop j 向后找到"累计里程(j+1)"，set 给 stop j+1。
  // 最后一个 stop 优先用"今日累计里程"兜底。
  const cumulativeByStopIndex = new Map<number, number>();
  for (let j = 0; j < stops.length - 1; j++) {
    const raw = findNearby(stops[j].index, /^累计里程\d*$/);
    if (raw) {
      const val = parseFloat(raw);
      if (!isNaN(val) && val >= 0) {
        cumulativeByStopIndex.set(j + 1, val);
      }
    }
  }
  const lastStopIndex = stops.length - 1;
  const totalCumulativeRaw =
    findNearby(stops[lastStopIndex].index, /^今日累计里程$/) ||
    findValue(/^今日累计里程$/);
  if (totalCumulativeRaw) {
    const val = parseFloat(totalCumulativeRaw);
    if (!isNaN(val) && val >= 0) {
      cumulativeByStopIndex.set(lastStopIndex, val);
    }
  }

  const visits: ParsedVisit[] = [];

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const sequence = i + 1;

    // 尝试提取客户名称
    // 钉钉表单中客户名称是员工在「是否前往下一个目的地」处填写的，语义上永远属于
    // 即将前往的下一个签到点（物理位置排在当前 stop 的字段块末尾），因此必须严格向前找
    // （在当前 stop 与上一个 stop 之间），不能回退向后找，否则会把下一个目的地的客户
    // 错挂到当前 stop。第一个 stop 是出发点，没有客户。
    const customerRaw =
      i > 0
        ? findBefore(stop.index, /^客户$/) || findBefore(stop.index, /客户名称/)
        : undefined;
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
    if (i === 0) {
      // 第一个点是出发点，只记录出发里程；缺少出发里程时打标
      if (isNaN(startOdometer)) {
        mileageNote = " [缺少出发里程读数]";
      }
    } else {
      const odoRaw = findNearby(stop.index, /^终点里程读数/);
      endOdometer = odoRaw && odoRaw !== "null" ? parseFloat(odoRaw) : null;
      if (endOdometer == null || isNaN(endOdometer)) {
        mileageNote = ` [第${sequence}个签到点缺少终点里程读数]`;
      } else if (!isNaN(startOdometer)) {
        const diff = endOdometer - startOdometer;
        if (diff >= 0 && diff <= MAX_MILEAGE_KM) {
          reportedDistanceKm = diff;
        } else if (diff < 0) {
          mileageNote = ` [里程读数异常：终点${endOdometer} < 出发${startOdometer}]`;
        } else {
          mileageNote = ` [里程读数异常：差值${diff}km 超上限]`;
        }
      } else {
        mileageNote = " [缺少出发里程读数，无法计算终点里程]";
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
      approval_status: approvalStatus,
      sequence,
      trip_type: tripType,
      vehicle,
      start_odometer: i === 0 ? startOdometer : undefined,
      end_odometer: endOdometer ?? undefined,
      reported_distance_km: reportedDistanceKm ?? undefined,
      cumulative_mileage_km: cumulativeByStopIndex.get(i),
      visit_note: visitNoteText + mileageNote,
      special_sign_reason: specialSignReasonText,
      photos,
      source_detail: stop.isSpecial ? "special_sign_in" : i === 0 ? "trip_start" : undefined,
    });
  }

  return visits;
}

// ==================== v2 新表单解析（用车里程登记&拜访客户签到） ====================
// 与 v1 的差异（PLAN.md Step 3.6）：
// - 客户名「拜访客户N」在打卡点之后，属于当前打卡点（向后找）；v1 是向前找
// - 无逐段里程读数：全程只有出发前/终点读数 + 今日出行总里程（= 终点−出发前，表单自动算）
// - 无特殊签到字段；拜访情况 = 交流对象/沟通内容详情/存在问题点 三段
// - 无起终点概念：判断逻辑只有「出行方式 × 客户名称」（情况A/B），
//   拜访计数排除由 normalization 按 customer_name 判定（form_version='v2'），不走地址白名单

// 判断组件值是否为「schema 回显」：v2 表单未填写的 OpenDataField/TableField，
// 钉钉返回的不是 null 而是组件定义 JSON（含 children/props，无 rowValue/extendValue）
function isSchemaEchoValue(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.some((it) => it?.rowValue || it?.extendValue)) return false; // 有真实数据
    return items.some((it) => it?.props || it?.children || it?.componentName || it?.componentType);
  } catch {
    return false; // 非 JSON，是普通文本值
  }
}

// 提取 v2「拜访客户N」的客户名与客户数：
// - OpenDataField（拜访客户1）：value 直接是文本（手动输入）或 "客户名称:X"（CRM 关联），单值
// - TableField（拜访客户2~5 嵌在其中）：value 为 JSON 数组，每行 rowValue 里
//   OpenDataField 项的 value 是一个客户；**一个打卡点可填多家客户**（多行 rowValue，
//   实测 2026-08-06），全部收集去重后用「、」连接，count 为去重后的客户数
//   （拜访次数统计按客户数计，见 visits.customer_count）
// 未填写（schema 回显）返回 { name: "", count: 0 }
function extractCustomerNameV2(c: FormComponent): { name: string; count: number } {
  const value = (c.value || "").trim();
  if (!value || value === "null") return { name: "", count: 0 };

  if (c.component_type === "TableField") {
    const names: string[] = [];
    try {
      const rows = JSON.parse(value);
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const rv = row?.rowValue;
          if (!Array.isArray(rv)) continue;
          for (const item of rv) {
            if (item?.componentType !== "OpenDataField") continue;
            const v = typeof item.value === "string" ? item.value.trim() : "";
            let name = v ? extractReadableName(v) : "";
            if (!name) {
              const title = item?.extendValue?.data?.find(
                (d: any) => d?.key === "titleKeyFieldId"
              )?.value;
              if (title) name = extractReadableName(String(title));
            }
            if (name && !names.includes(name)) names.push(name);
          }
        }
      }
    } catch {
      // 忽略 JSON 解析失败，按无客户处理
    }
    return { name: names.join("、"), count: names.length };
  }

  if (isSchemaEchoValue(value)) return { name: "", count: 0 };
  const name = extractReadableName(value);
  return { name, count: name ? 1 : 0 };
}

// 解析钉钉 AI 字段（DDAIField「AI总结」）的按块输出，格式为：
// "总结内容1: ...\n总结内容2: ..."（块内容可能跨行），返回 { 块序号 → 文本 }
function parseAiSummaryBlocks(raw?: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!raw) return map;
  const re = /总结内容(\d+)\s*[:：]/g;
  const matches = [...raw.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const n = parseInt(matches[i][1], 10);
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const text = raw.slice(start, end).trim();
    if (text) map.set(n, text);
  }
  return map;
}

async function parseApprovalInstanceV2(instance: any): Promise<ParsedVisit[]> {
  const formComponents: FormComponent[] = instance.form_component_values || [];

  const originatorUserId = instance.originator_userid || instance.originatorUserId || "";
  const originatorUserName = instance.originator_user_name || instance.originatorUserName || "";
  const department = instance.originator_dept_name || instance.originatorDeptName || "销售部";
  const approvalId = instance.business_id || instance.businessId || instance.process_instance_id || instance.processInstanceId || "";
  const approvalStatus = instance.status || instance.result || "";

  const findValue = (pattern: RegExp): string | undefined => {
    for (const c of formComponents) {
      const name = (c.name || "").trim();
      const value = (c.value || "").trim();
      if (pattern.test(name) && value && value !== "null") return value;
    }
    return undefined;
  };

  const tripType = findValue(/^出行方式$/) || findValue(/出行方式/);
  const isDriving = /^开车/.test(tripType || "");

  // 里程字段按字段名直取（「其他」单这些字段整体为空，天然跳过）
  const vehicleRaw = findValue(/^选择出行车辆$/);
  const vehicleInfo = vehicleRaw ? parseVehicle(vehicleRaw) : undefined;
  const startOdometer = parseFloat(findValue(/^出发前里程读数$/) || "NaN");
  const endOdometerRaw = findValue(/^终点里程读数$/);
  const endOdometer = endOdometerRaw ? parseFloat(endOdometerRaw) : NaN;
  const totalMileageRaw = findValue(/^今日出行总里程$/);
  const totalMileage = totalMileageRaw ? parseFloat(totalMileageRaw) : NaN;

  // 用户名 fallback 链与 v1 相同：originator_user_name → 通讯录 API → originator_userid
  // （v2 详情接口实测不返回 originator_user_name；不要用车辆字段中的人名兜底）
  let userName = originatorUserName;
  if (!userName && originatorUserId) {
    const contactName = await getUserNameById(originatorUserId);
    if (contactName) userName = contactName;
  }
  if (!userName) userName = originatorUserId;

  // 收集所有非空的 TimeAndLocationField，按表单顺序
  const stops: { index: number; parsed: ReturnType<typeof parseTimeLocationValue> }[] = [];
  for (let i = 0; i < formComponents.length; i++) {
    const c = formComponents[i];
    if (c.component_type !== "TimeAndLocationField") continue;
    const value = (c.value || "").trim();
    if (!value || value === "null") continue;
    const parsed = parseTimeLocationValue(value);
    if (!parsed) continue;
    stops.push({ index: i, parsed });
  }

  if (stops.length === 0) return [];

  // 在当前 stop 后面、下一个定位字段之前找匹配字段的值
  const findNearby = (stopIndex: number, pattern: RegExp): string | undefined => {
    for (let i = stopIndex + 1; i < formComponents.length; i++) {
      const c = formComponents[i];
      if (c.component_type === "TimeAndLocationField") break;
      const name = (c.name || "").trim();
      const value = (c.value || "").trim();
      if (pattern.test(name) && value && value !== "null") return value;
    }
    return undefined;
  };

  // 在当前 stop 后面、下一个定位字段之前找「拜访客户N」组件
  // （拜访客户1 是 OpenDataField；拜访客户2~5 嵌在 TableField 里）
  const findNearbyCustomerComponent = (stopIndex: number): FormComponent | undefined => {
    for (let i = stopIndex + 1; i < formComponents.length; i++) {
      const c = formComponents[i];
      if (c.component_type === "TimeAndLocationField") break;
      if (c.component_type === "OpenDataField" && /^拜访客户\d*$/.test((c.name || "").trim())) {
        return c;
      }
      if (c.component_type === "TableField") {
        return c;
      }
    }
    return undefined;
  };

  // 钉钉 AI 字段「AI总结」：整单一个 DDAIField，按块输出「总结内容N: ...」，
  // 优先作为各拜访块的 visit_note；无值或缺块时回退到原始字段拼接（兜底）
  const aiRaw =
    findValue(/^AI总结$/) ||
    (() => {
      const c = formComponents.find((c) => c.component_type === "DDAIField");
      const v = (c?.value || "").trim();
      return v && v !== "null" ? v : undefined;
    })();
  const aiSummaryByBlock = parseAiSummaryBlocks(aiRaw);

  const visits: ParsedVisit[] = [];
  let customerBlockNo = 0; // 拜访块序号：与「拜访客户N」「总结内容N」的 N 对齐

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const sequence = i + 1;
    const isFirst = i === 0;
    const isLast = i === stops.length - 1;

    // 客户名在打卡点之后，属于当前打卡点（与 v1 的「向前找」相反）
    // 一个打卡点可有多家客户：customer_count 为客户数，拜访次数统计按客户数计
    const customerComponent = findNearbyCustomerComponent(stop.index);
    if (customerComponent) customerBlockNo++;
    const { name: customerName, count: customerCount } = customerComponent
      ? extractCustomerNameV2(customerComponent)
      : { name: "", count: 0 };

    // visit_note：优先取 AI 总结的对应块；兜底拼接原始字段
    // （2026-08-06 表单改版后字段名带编号「沟通内容详情1」，正则用 \d* 兼容新旧快照）
    // visit_detail：原始字段结构化存储，供弹窗按 v2 表单字段名原样展示
    const commDetail = findNearby(stop.index, /^沟通内容详情\d*$/);
    const issues = findNearby(stop.index, /^存在问题点\d*$/);
    const aiNote = customerComponent ? aiSummaryByBlock.get(customerBlockNo) || "" : "";
    let visitNoteText = aiNote;
    if (!visitNoteText) {
      const contact = findNearby(stop.index, /^交流对象\d*$/); // 旧快照字段，已从新表单删除
      const noteParts: string[] = [];
      if (contact) noteParts.push(`交流对象：${contact}`);
      if (commDetail) noteParts.push(`沟通内容：${commDetail}`);
      if (issues) noteParts.push(`存在问题：${issues}`);
      visitNoteText = noteParts.join("；");
    }
    const visitDetail =
      commDetail || issues || aiNote
        ? { comm: commDetail || undefined, issues: issues || undefined, ai: aiNote || undefined }
        : undefined;

    const photosRaw = findNearby(stop.index, /^现场交流照片\d*$/);
    const photos = photosRaw ? parsePhotoUrls(photosRaw) : [];

    // 里程：开车单第一个点挂出发读数，最后一个点挂终点读数与填报总里程。
    // RUNNING 中的审批单终点打卡/读数可能尚未填写，「缺少读数」备注只在 COMPLETED 后追加，
    // 避免行程中途的最后一个已填打卡点被误标终点/误报缺读数
    const isCompleted = (instance.status || "") === "COMPLETED";
    let mileageNote = "";
    let reportedDistanceKm: number | null = null;
    if (isDriving) {
      if (isFirst && isNaN(startOdometer) && isCompleted) {
        mileageNote = " [缺少出发前里程读数]";
      }
      if (isLast) {
        if (isNaN(endOdometer)) {
          if (isCompleted) mileageNote += " [缺少终点里程读数]";
        } else if (!isNaN(startOdometer)) {
          const diff = endOdometer - startOdometer;
          if (diff >= 0 && diff <= MAX_MILEAGE_KM) {
            reportedDistanceKm = diff;
          } else if (diff < 0) {
            mileageNote += ` [里程读数异常：终点${endOdometer} < 出发${startOdometer}]`;
          } else {
            mileageNote += ` [里程读数异常：差值${diff}km 超上限]`;
          }
        } else if (isCompleted) {
          mileageNote += " [缺少出发前里程读数，无法计算填报里程]";
        }
      }
    }

    // 「终点」标签只在终点读数已填时打（即真正的终点打卡），否则按普通签到点
    const isRealEnd = isDriving && isLast && !isNaN(endOdometer);
    const locationName =
      isDriving && isFirst ? "出发点" : isRealEnd ? "终点" : `签到点${sequence}`;

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
      approval_status: approvalStatus,
      sequence,
      trip_type: tripType,
      vehicle: vehicleInfo?.vehicle,
      start_odometer: isDriving && isFirst && !isNaN(startOdometer) ? startOdometer : undefined,
      end_odometer: isDriving && isLast && !isNaN(endOdometer) ? endOdometer : undefined,
      reported_distance_km: reportedDistanceKm ?? undefined,
      cumulative_mileage_km:
        isDriving && isLast && !isNaN(totalMileage) && totalMileage >= 0 ? totalMileage : undefined,
      visit_note: visitNoteText + mileageNote,
      special_sign_reason: "",
      photos,
      source_detail: isDriving && isFirst ? "trip_start" : undefined,
      form_version: "v2",
      customer_count: customerCount,
      visit_detail: visitDetail,
    });
  }

  return visits;
}

// 保存钉钉审批实例原始数据
// knownProcessCode：同步路径已知的 process_code（详情接口不一定返回 process_code，
// 但 raw_approvals.process_code 是 v1/v2 解析分发的依据，必须可靠落库）
export async function saveRawApproval(instance: any, processInstanceId?: string, knownProcessCode?: string): Promise<void> {
  const approvalId = instance.business_id || instance.businessId || instance.process_instance_id || instance.processInstanceId || "";
  if (!approvalId) return;

  const realProcessInstanceId = processInstanceId || instance.process_instance_id || instance.processInstanceId || approvalId;
  const originatorUserId = instance.originator_userid || instance.originatorUserId || "";
  const originatorUserName = instance.originator_user_name || instance.originatorUserName || "";
  const rawCreateTime = instance.create_time || instance.createTime || null;
  const rawFinishTime = instance.finish_time || instance.finishTime || null;
  const createTime = rawCreateTime ? parseDateTimeAsBeijing(rawCreateTime) : null;
  const finishTime = rawFinishTime ? parseDateTimeAsBeijing(rawFinishTime) : null;

  try {
    await pool.query(
      `INSERT INTO raw_approvals
       (approval_id, process_instance_id, process_code, title, originator_userid, originator_user_name,
        originator_dept_name, create_time, finish_time, form_json, result, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'dingtalk')
       ON CONFLICT (approval_id) DO UPDATE SET
         process_instance_id = EXCLUDED.process_instance_id,
         process_code = COALESCE(raw_approvals.process_code, EXCLUDED.process_code),
         title = EXCLUDED.title,
         originator_user_name = EXCLUDED.originator_user_name,
         originator_dept_name = EXCLUDED.originator_dept_name,
         finish_time = EXCLUDED.finish_time,
         form_json = EXCLUDED.form_json,
         result = EXCLUDED.result,
         status = EXCLUDED.status`,
      [
        approvalId,
        realProcessInstanceId,
        instance.process_code || instance.processCode || knownProcessCode || null,
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

// 锁定审批单：销售在钉钉修改表单期间（或等待重录期间），同步链路必须整体跳过这些单——
// 不更新 raw_approvals、不重解析、不触碰 visits，防止修改中间态（状态回退/字段清空）
// 污染库内数据。锁定名单落库 locked_approvals 表，由管理员手工维护；
// 重录请走 scripts/reparseApproval.ts（刻意通道，不受锁定影响）。
async function getLockedApprovalIds(): Promise<Set<string>> {
  try {
    const result = await pool.query(`SELECT approval_id FROM locked_approvals`);
    return new Set(result.rows.map((r) => r.approval_id));
  } catch (err) {
    // 表不存在等异常时降级为不锁定（宁可同步，不可误判全锁）
    console.warn("[locked_approvals] 读取锁定名单失败，按无锁定处理:", err);
    return new Set();
  }
}

// 与 saveRawApproval 一致的 approval_id 推导，用于命中锁定名单
function resolveApprovalId(instance: any): string {
  return (
    instance.business_id ||
    instance.businessId ||
    instance.process_instance_id ||
    instance.processInstanceId ||
    ""
  );
}

// 把 visits.approval_status 与 raw_approvals.status 对齐。
// 背景：processParsedVisits 对已有行「存在即跳过」，字段不会被刷新；
// 而审批单会从 RUNNING 变为 COMPLETED，不刷新会导致前端轨迹终点永远显示「途n」而不是「终」。
// 该语句幂等且全表代价很低，每次同步都执行，兼有自愈存量数据的作用。
async function refreshVisitApprovalStatus(): Promise<number> {  const result = await pool.query(
    `UPDATE visits v
     SET approval_status = r.status
     FROM raw_approvals r
     WHERE v.approval_id = r.approval_id
       AND r.status IS NOT NULL
       AND v.approval_status IS DISTINCT FROM r.status`
  );
  return result.rowCount ?? 0;
}

// 拉取指定 process_code 在时间段内的全部审批单 ID；不传则拉全部已配置 code
// 返回 { id, processCode }，processCode 用于后续解析分发（v1/v2 两套映射按此分流）
export async function fetchAllApprovalIds(
  startTimeMs: number,
  endTimeMs: number,
  processCode?: string
): Promise<{ id: string; processCode: string }[]> {
  const codes = processCode ? [processCode] : getAllProcessCodes();
  const out: { id: string; processCode: string }[] = [];

  for (const code of codes) {
    let cursor: number | undefined = 0;
    while (cursor !== undefined) {
      const result = await getApprovalInstances(startTimeMs, endTimeMs, cursor, 20, code);
      for (const id of result.list) out.push({ id, processCode: code });
      cursor = result.nextCursor;
    }
  }

  return out;
}

export interface SyncApprovalsResult extends ProcessResult {
  totalInstances: number;
  parsedVisits: number;
  parseFailures: number;
  sourceApprovalIdsHash: string;
  dbApprovalIdsHash: string;
  missingCount: number;
  duplicateCount: number;
}

// 同步任务进程内互斥队列：定时任务、手动触发、启动 catchup 等入口可能并发触发，
// 并发执行会绕过 visits「先查再插」的防重逻辑产生重复签到，因此串行化
let syncApprovalsQueue: Promise<unknown> = Promise.resolve();

export async function syncApprovals(
  startTimeMs: number,
  endTimeMs: number,
  triggeredBy: "scheduler" | "manual" | "startup" = "manual"
): Promise<SyncApprovalsResult> {
  const run = syncApprovalsQueue
    .catch(() => {})
    .then(() => syncApprovalsInternal(startTimeMs, endTimeMs, triggeredBy));
  syncApprovalsQueue = run;
  return run;
}

async function syncApprovalsInternal(
  startTimeMs: number,
  endTimeMs: number,
  triggeredBy: "scheduler" | "manual" | "startup" = "manual"
): Promise<SyncApprovalsResult> {
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
      rawVisitCount?: number;
      sourceApprovalIdsHash?: string;
      dbApprovalIdsHash?: string;
      missingCount?: number;
      duplicateCount?: number;
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
           raw_visit_count = $7,
           source_approval_ids_hash = $8,
           db_approval_ids_hash = $9,
           missing_count = $10,
           duplicate_count = $11,
           error_message = $12,
           finished_at = NOW()
       WHERE id = $13`,
      [
        status,
        data.totalInstances ?? 0,
        data.parsedVisits ?? 0,
        data.parseFailures ?? 0,
        data.normalizedInserted ?? 0,
        data.skipped ?? 0,
        data.rawVisitCount ?? 0,
        data.sourceApprovalIdsHash ?? null,
        data.dbApprovalIdsHash ?? null,
        data.missingCount ?? 0,
        data.duplicateCount ?? 0,
        errorMessage ?? null,
        syncLogId,
      ]
    );
  };

  function computeApprovalIdsHash(ids: string[]): string {
    if (ids.length === 0) return "";
    const sorted = [...ids].sort();
    return crypto.createHash("md5").update(sorted.join(",")).digest("hex");
  }

  try {
    const refs = await fetchAllApprovalIds(startTimeMs, endTimeMs);
    const lockedIds = await getLockedApprovalIds();
    if (lockedIds.size > 0) {
      console.log(`[syncApprovals] 本次同步跳过 ${lockedIds.size} 张锁定审批单`);
    }
    const parsedVisits: ParsedVisit[] = [];
    const processedApprovalIds = new Set<string>();
    let parseFailures = 0;
    let lockedSkipped = 0;

    for (const ref of refs) {
      try {
        const instance = await getApprovalDetail(ref.id);

        // 锁定审批单整体跳过：不更新 raw_approvals、不解析、不触碰 visits
        const approvalId = resolveApprovalId(instance);
        if (approvalId && lockedIds.has(approvalId)) {
          lockedSkipped++;
          continue;
        }

        // 先保存原始审批数据，同时记录真正的 process_instance_id（来自 listids）
        // 和已知的 process_code（v1/v2 解析分发依据）
        await saveRawApproval(instance, ref.id, ref.processCode);

        // 按 process_code 分发到 v1/v2 两套解析映射
        const visits = await parseApprovalInstance(instance, ref.processCode);

        if (visits.length === 0) {
          // 已撤销（TERMINATED）/进行中（RUNNING）的审批单解析出 0 条签到是预期行为——
          // 撤销单无有效签到；进行中的单可能还没打卡，由 syncRunningApprovals 跟进。
          // 计入解析失败会在 3 天同步窗口内每轮重复计数，造成每 3 小时一条告警噪音
          // （8/19 案例：8-12 撤销单 + 8-18 进行中单轮流触发）。
          // COMPLETED 仍解析为 0 才是真异常，保留计数告警。
          const instanceStatus = instance.status || "";
          if (instanceStatus === "TERMINATED" || instanceStatus === "RUNNING") {
            console.log(
              `[syncApprovals] 跳过${instanceStatus === "TERMINATED" ? "已撤销" : "进行中"}审批单（0 签到，不计解析失败）: ${ref.id}`
            );
            continue;
          }
          parseFailures++;
          continue;
        }

        for (const v of visits) {
          if (v.approval_id) processedApprovalIds.add(v.approval_id);
        }
        parsedVisits.push(...visits);
      } catch (err) {
        console.error(`Failed to parse DingTalk instance ${ref.id}:`, err);
        parseFailures++;
      }
    }

    const result = await processParsedVisits(parsedVisits, "dingtalk");

    // 对齐已有 visits 行的审批状态（RUNNING → COMPLETED 等），修复前端「终/途」标记卡死
    const statusRefreshed = await refreshVisitApprovalStatus();
    if (statusRefreshed > 0) {
      console.log(`[syncApprovals] 已对齐 ${statusRefreshed} 条 visits 的审批状态`);
    }

    // 后台自动补算路线和异常，避免用户手动跑脚本
    if (result.affectedUserDates.length > 0) {
      recomputeDerivedDataForVisits(result.affectedUserDates).catch((err) => {
        console.error("[syncApprovals] 后台衍生数据计算失败:", err);
      });
    }

    // 对账：本次处理的审批单中哪些没有落库。
    // 用真正的集合差（不再用计数差——计数差会被窗口内历史数据掩盖真实缺失）；
    // 库端按 approval_id 直查而非 business_date 窗口——跨天审批单（创建于 D-1、
    // 首次签到在 D）不会误报缺失；无缺失时两端 hash 相等，hash 校验恢复有效。
    const processedIds = Array.from(processedApprovalIds);
    let dbApprovalIds: string[] = [];
    let missingCount = 0;
    if (processedIds.length > 0) {
      const dbApprovalResult = await pool.query(
        `SELECT DISTINCT approval_id FROM visits WHERE approval_id = ANY($1)`,
        [processedIds]
      );
      dbApprovalIds = dbApprovalResult.rows
        .map((r) => r.approval_id)
        .filter((id): id is string => !!id);
      const dbSet = new Set(dbApprovalIds);
      missingCount = processedIds.filter((id) => !dbSet.has(id)).length;
    }

    // 计算重复审批单：同一 approval_id + user_id + sequence 出现多次
    const duplicateResult = await pool.query(
      `SELECT approval_id, user_id, sequence, COUNT(*) AS cnt
       FROM visits
       WHERE business_date BETWEEN $1 AND $2
         AND source = 'dingtalk'
         AND approval_id IS NOT NULL
       GROUP BY approval_id, user_id, sequence
       HAVING COUNT(*) > 1`,
      [startDate, endDate]
    );
    const duplicateCount = duplicateResult.rows.length;

    const finalResult = {
      ...result,
      totalInstances: refs.length,
      parsedVisits: parsedVisits.length,
      parseFailures,
    };
    if (lockedSkipped > 0) {
      console.log(`[syncApprovals] 已跳过 ${lockedSkipped} 张锁定审批单`);
    }

    await updateLog(
      "success",
      {
        totalInstances: finalResult.totalInstances,
        parsedVisits: finalResult.parsedVisits,
        parseFailures: finalResult.parseFailures,
        normalizedInserted: finalResult.normalizedInserted,
        skipped: finalResult.skipped,
        rawVisitCount: finalResult.rawInserted,
        sourceApprovalIdsHash: computeApprovalIdsHash(processedIds),
        dbApprovalIdsHash: computeApprovalIdsHash(dbApprovalIds),
        missingCount,
        duplicateCount,
      }
    );

    return {
      ...finalResult,
      sourceApprovalIdsHash: computeApprovalIdsHash(processedIds),
      dbApprovalIdsHash: computeApprovalIdsHash(dbApprovalIds),
      missingCount,
      duplicateCount,
    };
  } catch (err: any) {
    await updateLog("failed", {}, err.message || String(err));
    throw err;
  }
}

export async function syncRunningApprovals(): Promise<{
  total: number;
  updated: number;
  errors: number;
}> {
  if (!isDingTalkConfigured()) {
    console.log("[syncRunningApprovals] DingTalk not configured, skipping");
    return { total: 0, updated: 0, errors: 0 };
  }

  const result = await pool.query(
    `SELECT approval_id, process_instance_id, create_time, process_code
     FROM raw_approvals
     WHERE status = 'RUNNING'`
  );
  const lockedIds = await getLockedApprovalIds();

  let updated = 0;
  let errors = 0;

  // 旧数据没有 process_instance_id，按创建日期分组后统一兜底同步，避免重复调用
  const fallbackDates = new Set<string>();

  for (const row of result.rows) {
    try {
      // 锁定审批单整体跳过，见 getLockedApprovalIds 注释
      if (lockedIds.has(row.approval_id)) {
        console.log(`[syncRunningApprovals] 跳过锁定审批单 ${row.approval_id}`);
        continue;
      }
      if (row.process_instance_id && row.process_instance_id !== row.approval_id) {
        // 有真正的 process_instance_id 时直接拉取最新详情
        const instance = await getApprovalDetail(row.process_instance_id);
        await saveRawApproval(instance, row.process_instance_id);

        // 按 raw_approvals.process_code 分发 v1/v2 解析映射
        const visits = await parseApprovalInstance(instance, row.process_code);
        if (visits.length > 0) {
          const processResult = await processParsedVisits(visits, "dingtalk");
          if (processResult.affectedUserDates.length > 0) {
            recomputeDerivedDataForVisits(processResult.affectedUserDates).catch((err) => {
              console.error("[syncRunningApprovals] 后台衍生数据计算失败:", err);
            });
          }
        }
      } else {
        const dateStr = formatBeijingDate(row.create_time);
        fallbackDates.add(dateStr);
      }
      updated++;
    } catch (err) {
      console.error(`[syncRunningApprovals] failed for ${row.approval_id}:`, err);
      errors++;
    }
  }

  // 按日期分组兜底同步，每个日期只调用一次
  for (const dateStr of fallbackDates) {
    try {
      const startMs = new Date(toBeijingDayStart(dateStr)).getTime();
      const endMs = new Date(toBeijingDayEnd(dateStr).replace("+08:00", ".999+08:00")).getTime();
      await syncApprovals(startMs, endMs, "scheduler");
    } catch (err) {
      console.error(`[syncRunningApprovals] failed to sync fallback date ${dateStr}:`, err);
      errors++;
    }
  }

  // 兜底同步走 syncApprovals 已包含状态对齐；这里再统一执行一次，覆盖上面的逐条刷新路径
  const statusRefreshed = await refreshVisitApprovalStatus();

  console.log(
    `[syncRunningApprovals] completed: total=${result.rows.length}, updated=${updated}, fallbackDates=${fallbackDates.size}, errors=${errors}, statusRefreshed=${statusRefreshed}`
  );
  return { total: result.rows.length, updated, errors };
}
