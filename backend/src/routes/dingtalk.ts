import { Router, Request, Response } from "express";
import {
  getDingTalkConfig,
  isDingTalkConfigured,
  getAccessToken,
  getApprovalInstances,
  getApprovalDetail,
  getProcessCodeByName,
  syncApprovals,
  getDepartmentList,
  getDepartmentUsers,
  fetchAllDepartmentUsers,
  syncContacts,
  getUserDetail,
} from "../services/dingtalk";
import { toBeijingDayStart, toBeijingDayEnd, formatBeijingDate, getYesterdayBeijing } from "../utils/timezone";

const router = Router();

function dateToStartMs(dateStr: string): number {
  return new Date(toBeijingDayStart(dateStr)).getTime();
}

function dateToEndMs(dateStr: string): number {
  return new Date(toBeijingDayEnd(dateStr).replace("+08:00", ".999+08:00")).getTime();
}

// GET /dingtalk/probe-user?userid=xxx
// 探测单个用户的通讯录详情（含 dept_id_list），用于找到有权限的部门 ID
router.get("/probe-user", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  const { userid } = req.query;
  if (!userid) {
    res.status(400).json({ error: "Missing userid parameter" });
    return;
  }

  try {
    const result = await getUserDetail(userid as string);
    if (!result) {
      res.status(500).json({ error: "Failed to fetch user detail" });
      return;
    }

    res.json({
      success: true,
      userid: result.userid,
      name: result.name,
      mobile: result.mobile,
      title: result.title,
      dept_id_list: result.dept_id_list,
      dept_order_list: result.dept_order_list,
      manager_userid: result.manager_userid,
    });
  } catch (err: any) {
    console.error("Failed to probe DingTalk user:", err);
    res.status(500).json({ error: err.message || "Failed to probe user" });
  }
});

// GET /dingtalk/status
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const cfg = getDingTalkConfig();
    let tokenValid = false;
    let tokenError: string | null = null;

    if (isDingTalkConfigured()) {
      try {
        await getAccessToken();
        tokenValid = true;
      } catch (err: any) {
        tokenError = err.message || String(err);
      }
    }

    res.json({
      configured: isDingTalkConfigured(),
      appKey: cfg.appKey ? `${cfg.appKey.slice(0, 4)}****` : null,
      processCode: cfg.processCode || null,
      tokenValid,
      tokenError,
    });
  } catch (err) {
    console.error("Failed to get DingTalk status:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// GET /dingtalk/discover?name=用车登记
// 根据审批模板名称反查 process_code
router.get("/discover", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  const name = (req.query.name as string) || "用车登记";
  try {
    const processCode = await getProcessCodeByName(name);
    res.json({
      success: true,
      name,
      processCode,
      message: processCode ? `找到模板 "${name}" 的 process_code` : `未找到模板 "${name}"`,
    });
  } catch (err: any) {
    console.error("DingTalk discover failed:", err);
    res.status(500).json({ error: err.message || "DingTalk discover failed" });
  }
});

// GET /dingtalk/test?days=N
// 拉取一条最近的审批实例，验证权限和数据格式；默认查最近 7 天
router.get("/test", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  try {
    const days = Math.min(parseInt((req.query.days as string) || "7", 10) || 7, 30);
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const result = await getApprovalInstances(startTime, now, 0, 10);

    if (result.list.length === 0) {
      res.json({
        success: true,
        message: `权限正常，但最近 ${days} 天没有审批实例`,
        instanceCount: 0,
        days,
      });
      return;
    }

    const detail = await getApprovalDetail(result.list[0]);
    res.json({
      success: true,
      message: `权限正常，已获取一条审批实例（最近 ${days} 天）`,
      days,
      instanceCount: result.list.length,
      sample: {
        title: detail.title,
        createTime: detail.create_time,
        finishTime: detail.finish_time,
        originatorUserId: detail.originator_userid,
        originatorUserName: detail.originator_user_name,
        formComponentValues: detail.form_component_values,
      },
    });
  } catch (err: any) {
    console.error("DingTalk test failed:", err);
    res.status(500).json({ error: err.message || "DingTalk test failed" });
  }
});

// POST /dingtalk/sync
// body: { startDate?: "YYYY-MM-DD", endDate?: "YYYY-MM-DD" }
// 默认同步昨天
router.post("/sync", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  const { startDate, endDate } = req.body || {};
  const yesterday = getYesterdayBeijing();

  const startStr = startDate || yesterday;
  const endStr = endDate || startStr;

  try {
    const result = await syncApprovals(dateToStartMs(startStr), dateToEndMs(endStr));
    res.json({
      success: true,
      startDate: startStr,
      endDate: endStr,
      ...result,
    });
  } catch (err: any) {
    console.error("DingTalk sync failed:", err);
    res.status(500).json({ error: err.message || "DingTalk sync failed" });
  }
});

// GET /dingtalk/departments?deptId=1
// 拉取钉钉部门树（探测接口，不改 visits 数据）
// 默认从根部门 1 开始；如果提示 50004 可见范围不足，可传入有权限的 deptId
router.get("/departments", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  const deptId = parseInt((req.query.deptId as string) || "1", 10);
  if (isNaN(deptId)) {
    res.status(400).json({ error: "Invalid deptId parameter" });
    return;
  }

  try {
    const departments = await getDepartmentList(deptId);
    res.json({
      success: true,
      rootDeptId: deptId,
      count: departments.length,
      departments: departments.map((d) => ({
        dept_id: d.dept_id,
        parent_id: d.parent_id,
        name: d.name,
      })),
    });
  } catch (err: any) {
    console.error(`Failed to fetch DingTalk departments from ${deptId}:`, err);
    res.status(500).json({
      error: err.message || "Failed to fetch departments",
      hint: "若报错 50004，说明当前 deptId 不在应用可见范围内，请尝试传入有权限的部门 ID，或在钉钉后台扩大通讯录可见范围",
    });
  }
});

// GET /dingtalk/department-users?deptId=123
// 拉取指定部门下的用户（分页拉取完整列表）
router.get("/department-users", async (req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  const deptId = parseInt(req.query.deptId as string, 10);
  if (isNaN(deptId)) {
    res.status(400).json({ error: "Missing or invalid deptId parameter" });
    return;
  }

  try {
    const users = await fetchAllDepartmentUsers(deptId);
    res.json({
      success: true,
      deptId,
      count: users.length,
      users: users.map((u) => ({
        userid: u.userid,
        name: u.name,
        title: u.title,
        dept_id_list: u.dept_id_list,
      })),
    });
  } catch (err: any) {
    console.error(`Failed to fetch DingTalk users for dept ${deptId}:`, err);
    res.status(500).json({ error: err.message || "Failed to fetch department users" });
  }
});

// POST /dingtalk/sync-contacts
// 同步通讯录到 dingtalk_departments / dingtalk_users 表
router.post("/sync-contacts", async (_req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  try {
    const result = await syncContacts();
    res.json({
      success: true,
      departments: result.departments,
      users: result.users,
      errors: result.errors,
    });
  } catch (err: any) {
    console.error("Failed to sync DingTalk contacts:", err);
    res.status(500).json({ error: err.message || "Failed to sync contacts" });
  }
});

export default router;
