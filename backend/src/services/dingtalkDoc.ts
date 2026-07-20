import { getAccessToken, getUserDetail } from "./dingtalk";
import { buildOrgTree, OrgTreeNode } from "./orgService";
import { pool } from "../db";

const DINGTALK_API_BASE = "https://api.dingtalk.com";

interface ApiResponse<T = any> {
  errcode?: number;
  errmsg?: string;
  result?: T;
  success?: boolean;
  [key: string]: any;
}

async function docApiRequest<T = any>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    query?: Record<string, string | undefined>;
    body?: any;
  } = {}
): Promise<T> {
  const accessToken = await getAccessToken();
  const { method = "GET", query = {}, body } = options;

  const queryEntries = Object.entries(query).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  ) as [string, string][];
  const queryString = queryEntries.length
    ? "?" + new URLSearchParams(queryEntries).toString()
    : "";

  const url = `${DINGTALK_API_BASE}${path}${queryString}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-acs-dingtalk-access-token": accessToken,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as ApiResponse;
  // 钉钉新文档 API 使用 code/message 字段表示错误
  if (data.code) {
    throw new Error(`DingTalk Doc API error: ${data.message} (${data.code})`);
  }
  if (data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(`DingTalk Doc API error: ${data.errmsg} (${data.errcode})`);
  }
  if (data.success === false) {
    throw new Error(`DingTalk Doc API error: ${data.errmsg || data.message || "unknown"}`);
  }
  return (data.result ?? data) as T;
}

export interface DocWorkspace {
  workspaceId: string;
  name: string;
  url?: string;
  rootNodeId?: string;
  owner?: string;
  role?: string;
}

/**
 * 获取 operatorId（unionId）。
 * 优先从环境变量 DINGTALK_OPERATOR_USERID 对应的钉钉用户获取。
 */
export async function getOperatorUnionId(): Promise<string> {
  const operatorUserId = process.env.DINGTALK_OPERATOR_USERID || "";
  if (!operatorUserId) {
    throw new Error(
      "未配置 DINGTALK_OPERATOR_USERID，无法确定钉钉文档操作人"
    );
  }

  const detail = await getUserDetail(operatorUserId);
  const unionId = detail?.unionid || detail?.unionId;
  if (!unionId) {
    throw new Error(
      `无法获取用户 ${operatorUserId} 的 unionId，请确认该用户在企业通讯录中且应用有通讯录读取权限`
    );
  }
  return unionId;
}

/**
 * 列出当前操作人有权限的知识库列表。
 * 使用 wiki 2.0 接口，所需权限为 Wiki.Workspace.Read。
 */
export async function listWorkspaces(
  unionId: string
): Promise<DocWorkspace[]> {
  const res = await docApiRequest<any>("/v2.0/wiki/workspaces", {
    query: { operatorId: unionId },
  });
  const list: DocWorkspace[] = Array.isArray(res)
    ? res
    : res?.workspaces || res?.list || [];
  return list;
}

/**
 * 创建知识库。
 * 注意：此接口需要 Document.Workspace.Write（高级权限），可能难以申请。
 * 如申请不到，建议改为手动在钉钉中创建知识库，并将 workspaceId 配置到环境变量。
 */
export async function createWorkspace(
  unionId: string,
  name: string
): Promise<DocWorkspace> {
  return docApiRequest<DocWorkspace>("/v1.0/doc/workspaces", {
    method: "POST",
    body: {
      operatorId: unionId,
      name,
      description: "由销售外勤行为分析系统自动创建",
    },
  });
}

/**
 * 获取或创建知识库。
 * 创建接口不返回 rootNodeId，因此创建后重新拉取一次完整信息。
 */
export async function getOrCreateWorkspace(
  unionId: string,
  name: string
): Promise<DocWorkspace> {
  let list = await listWorkspaces(unionId);
  const existing = list.find((w) => w.name === name);
  if (existing) {
    console.log(`[DingTalk Doc] found existing workspace: ${existing.workspaceId}`);
    return existing;
  }
  await createWorkspace(unionId, name);
  // 重新拉取以获取 rootNodeId
  list = await listWorkspaces(unionId);
  const created = list.find((w) => w.name === name);
  if (!created) {
    throw new Error("创建知识库后未能获取到 workspace 信息");
  }
  console.log(`[DingTalk Doc] created workspace: ${created.workspaceId}`);
  return created;
}

export interface DocNode {
  nodeId: string;
  name: string;
  type: "FILE" | "FOLDER";
  docType?: string;
  docKey?: string;
  dentryUuid?: string;
  workspaceId?: string;
}

/**
 * 列出知识库下某父节点的子节点。
 */
export async function listNodes(
  unionId: string,
  workspaceId: string,
  parentNodeId: string
): Promise<DocNode[]> {
  const res = await docApiRequest<any>("/v2.0/wiki/nodes", {
    query: {
      operatorId: unionId,
      workspaceId,
      parentNodeId,
    },
  });
  const nodes: DocNode[] = Array.isArray(res)
    ? res
    : res?.nodes || res?.list || [];
  return nodes;
}

/**
 * 在知识库中创建文件夹。
 * 注意：创建接口返回的 nodeId 是 doc 1.0 内部 ID，不能用于 wiki 2.0 的 listNodes。
 * 这里把 dentryUuid（即 wiki 2.0 的 nodeId）作为 folder 的 nodeId 返回。
 */
export async function createFolder(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  name: string
): Promise<DocNode> {
  const created = await docApiRequest<DocNode>(
    `/v1.0/doc/workspaces/${workspaceId}/docs`,
    {
      method: "POST",
      body: {
        operatorId: unionId,
        name,
        docType: "FOLDER",
        parentNodeId,
      },
    }
  );
  return {
    ...created,
    nodeId: created.dentryUuid || created.nodeId,
    workspaceId,
  };
}

/** 忽略「XX. 」序号前缀，用于匹配用户手动编号后的文件夹名称 */
export function normalizeNodeName(name: string): string {
  return name.replace(/^\d+\.\s*/, "").trim();
}

/**
 * 获取或创建文件夹。
 * 查找时优先精确匹配，其次忽略「XX. 」序号前缀匹配。
 * 创建时使用传入的原名称（无序号）。
 */
export async function getOrCreateFolder(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  name: string
): Promise<DocNode> {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  const existing = nodes.find((n) => n.type === "FOLDER" && (
    n.name === name || normalizeNodeName(n.name) === name
  ));
  if (existing) {
    console.log(`[DingTalk Doc] found existing folder: ${existing.nodeId}`);
    return existing;
  }
  const created = await createFolder(unionId, workspaceId, parentNodeId, name);
  console.log(`[DingTalk Doc] created folder: ${created.nodeId}`);
  return created;
}

/**
 * 查找某父节点下指定名称的文档节点。
 * 返回的 nodeId 即 dentryUuid，可直接作为 docKey 用于覆写内容。
 */
export async function findDocNodeByName(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  name: string
): Promise<DocNode | null> {
  const nodes = await listNodes(unionId, workspaceId, parentNodeId);
  return (
    nodes.find(
      (n) =>
        n.type === "FILE" &&
        (n.name === name || n.name.replace(/\.adoc$/i, "") === name)
    ) || null
  );
}

export interface CreatedDoc {
  workspaceId: string;
  nodeId: string;
  docKey: string;
  dentryUuid: string;
  url: string;
  docType: string;
}

/**
 * 在知识库中创建文档。
 */
export async function createDoc(
  unionId: string,
  workspaceId: string,
  parentNodeId: string,
  name: string
): Promise<CreatedDoc> {
  return docApiRequest<CreatedDoc>(
    `/v1.0/doc/workspaces/${workspaceId}/docs`,
    {
      method: "POST",
      body: {
        operatorId: unionId,
        name,
        docType: "DOC",
        parentNodeId,
      },
    }
  );
}

/**
 * 使用 Markdown 覆写文档内容。
 */
export async function overwriteDocContent(
  docKey: string,
  unionId: string,
  markdown: string
): Promise<void> {
  await docApiRequest(
    `/v1.0/doc/suites/documents/${docKey}/overwriteContent`,
    {
      method: "POST",
      query: { operatorId: unionId },
      body: {
        dataType: "markdown",
        content: markdown,
      },
    }
  );
}

/**
 * 添加文档成员。
 */
export async function addDocMember(
  workspaceId: string,
  nodeId: string,
  operatorUnionId: string,
  memberUnionId: string,
  role: "ONLY_VIEWER" | "VIEWER" | "EDITOR" = "VIEWER"
): Promise<void> {
  await docApiRequest(
    `/v1.0/doc/workspaces/${workspaceId}/docs/${nodeId}/members`,
    {
      method: "POST",
      body: {
        operatorId: operatorUnionId,
        members: [
          {
            memberId: memberUnionId,
            memberType: "USER",
            roleType: role,
          },
        ],
      },
    }
  );
}

export type ReportType = "日报" | "周报" | "月报";

/** 人员维度下「日报/周报/月报」文件夹的显示名称（带序号前缀） */
const EMPLOYEE_REPORT_FOLDER_NAMES: Record<ReportType, string> = {
  日报: "00. 日报",
  周报: "01. 周报",
  月报: "02. 月报",
};

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7);
}

/**
 * 根据日期范围推断报告类型和报告日期字符串。
 * - 单日：日报，日期 YYYY-MM-DD
 * - 整周（跨度 6 天且 start 是周一）：周报，日期 YYYY-Www
 * - 整月（start 为月初、end 为月末）：月报，日期 YYYY-MM
 * - 其他：按日报处理
 */
export function inferReportType(
  start: string,
  end: string
): { reportType: ReportType; reportDate: string } {
  if (start === end) {
    return { reportType: "日报", reportDate: start };
  }

  const s = new Date(start + "T00:00:00+08:00");
  const e = new Date(end + "T00:00:00+08:00");
  const diffDays = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));

  // 周报：跨度 6 天且开始是周一
  if (diffDays === 6 && s.getDay() === 1) {
    const year = s.getFullYear();
    const week = getWeekNumber(s);
    return { reportType: "周报", reportDate: `${year}-W${String(week).padStart(2, "0")}` };
  }

  // 月报：start 为 1 号，end 为月末
  const sYear = s.getFullYear();
  const sMonth = s.getMonth();
  const eYear = e.getFullYear();
  const eMonth = e.getMonth();
  const eDate = e.getDate();
  const lastDay = new Date(eYear, eMonth + 1, 0).getDate();
  if (sYear === eYear && sMonth === eMonth && s.getDate() === 1 && eDate === lastDay) {
    return {
      reportType: "月报",
      reportDate: `${sYear}-${String(sMonth + 1).padStart(2, "0")}`,
    };
  }

  // 兜底按日报
  return { reportType: "日报", reportDate: start };
}

/**
 * 确保员工的报告目录结构存在：
 * 知识库 / 员工姓名 / {00. 日报, 01. 周报, 02. 月报}
 * 返回三个类型文件夹的 nodeId 映射。
 */
export async function ensureEmployeeReportStructure(
  unionId: string,
  workspaceId: string,
  rootNodeId: string,
  employeeName: string
): Promise<Record<ReportType, DocNode>> {
  // 一级：员工姓名
  const employeeFolder = await getOrCreateFolder(
    unionId,
    workspaceId,
    rootNodeId,
    employeeName
  );

  // 二级：00. 日报 / 01. 周报 / 02. 月报
  const reportTypes: ReportType[] = ["日报", "周报", "月报"];
  const result = {} as Record<ReportType, DocNode>;
  for (const type of reportTypes) {
    result[type] = await getOrCreateFolder(
      unionId,
      workspaceId,
      employeeFolder.nodeId,
      EMPLOYEE_REPORT_FOLDER_NAMES[type]
    );
  }

  return result;
}

export type ReportScope = "company" | "department" | "sub_department" | "person";

export interface ReportScopeTarget {
  scope: ReportScope;
  /** 部门 shortName（部门/子部门/个人维度使用） */
  deptName?: string;
  /** 子部门 shortName（子部门/个人维度使用） */
  subDeptName?: string;
  /** 用户 ID（个人维度使用） */
  userId?: string;
  /** 用户姓名（个人维度使用） */
  userName?: string;
}

/**
 * 根据报告维度定位或创建目标文件夹。
 * 支持用户在钉钉里手动添加的 `XX. ` 序号前缀。
 * 可传入已构建好的 orgTree 避免重复查询。
 */
export async function ensureReportFolder(
  unionId: string,
  workspaceId: string,
  rootNodeId: string,
  target: ReportScopeTarget,
  reportType: ReportType,
  orgTree?: OrgTreeNode[]
): Promise<DocNode> {
  if (target.scope === "company") {
    const companyFolder = await getOrCreateFolder(
      unionId,
      workspaceId,
      rootNodeId,
      "公司报告"
    );
    return getOrCreateFolder(
      unionId,
      workspaceId,
      companyFolder.nodeId,
      reportType
    );
  }

  const tree = orgTree || (await buildOrgTree());

  if (target.scope === "department") {
    const dept = tree.find(
      (d) => d.shortName === target.deptName || d.name === target.deptName
    );
    if (!dept) {
      throw new Error(`部门未找到: ${target.deptName}`);
    }
    const deptFolder = await getOrCreateFolder(
      unionId,
      workspaceId,
      rootNodeId,
      dept.shortName
    );
    const reportFolder = await getOrCreateFolder(
      unionId,
      workspaceId,
      deptFolder.nodeId,
      "部门报告"
    );
    return getOrCreateFolder(
      unionId,
      workspaceId,
      reportFolder.nodeId,
      reportType
    );
  }

  if (target.scope === "sub_department") {
    for (const dept of tree) {
      const sub = dept.children.find(
        (c) =>
          c.shortName === target.subDeptName || c.name === target.subDeptName
      );
      if (sub) {
        const deptFolder = await getOrCreateFolder(
          unionId,
          workspaceId,
          rootNodeId,
          dept.shortName
        );
        const subFolder = await getOrCreateFolder(
          unionId,
          workspaceId,
          deptFolder.nodeId,
          sub.shortName
        );
        const reportFolder = await getOrCreateFolder(
          unionId,
          workspaceId,
          subFolder.nodeId,
          "部门报告"
        );
        return getOrCreateFolder(
          unionId,
          workspaceId,
          reportFolder.nodeId,
          reportType
        );
      }
    }
    throw new Error(`子部门未找到: ${target.subDeptName}`);
  }

  // person
  if (!target.userId || !target.userName) {
    throw new Error("个人维度需要提供 userId 和 userName");
  }

  for (const dept of tree) {
    // 部门是叶子节点，人员直接挂在部门下
    if (dept.userIds?.includes(target.userId)) {
      const deptFolder = await getOrCreateFolder(
        unionId,
        workspaceId,
        rootNodeId,
        dept.shortName
      );
      const empFolder = await ensureEmployeeReportStructure(
        unionId,
        workspaceId,
        deptFolder.nodeId,
        target.userName
      );
      return empFolder[reportType];
    }
    // 人员在子部门下
    for (const sub of dept.children) {
      if (sub.userIds?.includes(target.userId)) {
        const deptFolder = await getOrCreateFolder(
          unionId,
          workspaceId,
          rootNodeId,
          dept.shortName
        );
        const subFolder = await getOrCreateFolder(
          unionId,
          workspaceId,
          deptFolder.nodeId,
          sub.shortName
        );
        const empFolder = await ensureEmployeeReportStructure(
          unionId,
          workspaceId,
          subFolder.nodeId,
          target.userName
        );
        return empFolder[reportType];
      }
    }
  }

  throw new Error(`用户未找到: ${target.userName}(${target.userId})`);
}

/**
 * 将 ConsolePage 报告导出到钉钉文档知识库。
 * 按「知识库 / 员工姓名 / 报告类型 / 日期_姓名_报告类型」三级结构存放。
 * 返回创建或更新后的文档 URL。
 */
export async function exportConsoleReportToDingTalkDoc(options: {
  operatorUserId: string;
  targetUserId: string;
  targetUserName: string;
  workspaceName: string;
  start: string;
  end: string;
  markdown: string;
}): Promise<{ url: string; docKey: string; nodeId: string; workspaceId: string; reportType: ReportType; reportDate: string }> {
  const { operatorUserId, targetUserId, targetUserName, workspaceName, start, end, markdown } =
    options;

  // 1. 获取操作人 unionId
  const operatorDetail = await getUserDetail(operatorUserId);
  const operatorUnionId = operatorDetail?.unionid || operatorDetail?.unionId;
  if (!operatorUnionId) {
    throw new Error(`无法获取操作人 ${operatorUserId} 的 unionId`);
  }

  // 2. 获取目标员工 unionId（用于授权）
  const targetDetail = await getUserDetail(targetUserId);
  const targetUnionId = targetDetail?.unionid || targetDetail?.unionId;

  // 3. 推断报告类型和日期
  const { reportType, reportDate } = inferReportType(start, end);
  const docName = `${reportDate}_${targetUserName}_${reportType}`;

  // 4. 获取或创建知识库
  const workspace = await getOrCreateWorkspace(operatorUnionId, workspaceName);
  const workspaceId = workspace.workspaceId;
  const rootNodeId = workspace.rootNodeId || "root";

  // 5. 确保员工报告目录结构存在
  const folders = await ensureEmployeeReportStructure(
    operatorUnionId,
    workspaceId,
    rootNodeId,
    targetUserName
  );
  const typeFolder = folders[reportType];

  // 6. 检查是否已存在同名文档；存在则覆写内容，不存在则创建
  const existingDoc = await findDocNodeByName(
    operatorUnionId,
    workspaceId,
    typeFolder.nodeId,
    docName
  );

  let resultDoc: CreatedDoc;
  if (existingDoc?.nodeId) {
    // 已存在同名文档：listNodes 返回的 nodeId 即 dentryUuid，可直接作为 docKey 覆写内容
    console.log(`[DingTalk Doc] 文档已存在，覆写内容: ${docName}`);
    await overwriteDocContent(existingDoc.nodeId, operatorUnionId, markdown);
    resultDoc = {
      workspaceId,
      nodeId: existingDoc.nodeId,
      docKey: existingDoc.nodeId,
      dentryUuid: existingDoc.nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${existingDoc.nodeId}`,
      docType: "DOC",
    };
  } else {
    resultDoc = await createDoc(
      operatorUnionId,
      workspaceId,
      typeFolder.nodeId,
      docName
    );
    // dentryUuid 等价于 docKey，均可用于覆写内容
    await overwriteDocContent(
      resultDoc.dentryUuid || resultDoc.docKey,
      operatorUnionId,
      markdown
    );

    // 7. 给新员工授权查看（失败仅警告，不阻断）
    if (targetUnionId) {
      try {
        await addDocMember(
          resultDoc.workspaceId,
          resultDoc.nodeId,
          operatorUnionId,
          targetUnionId,
          "VIEWER"
        );
      } catch (err: any) {
        console.warn(
          `[DingTalk Doc] 给员工 ${targetUserId} 授权失败:`,
          err.message
        );
      }
    }
  }

  return {
    url: resultDoc.url,
    docKey: resultDoc.docKey,
    nodeId: resultDoc.nodeId,
    workspaceId,
    reportType,
    reportDate,
  };
}
