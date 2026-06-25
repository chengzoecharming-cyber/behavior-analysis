import { Router, Request, Response } from "express";
import {
  getDingTalkConfig,
  isDingTalkConfigured,
  getAccessToken,
  getApprovalInstances,
  getApprovalDetail,
  syncApprovals,
} from "../services/dingtalk";

const router = Router();

function dateToMs(dateStr: string): number {
  return new Date(dateStr + "T00:00:00+08:00").getTime();
}

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

// GET /dingtalk/test
// 拉取一条最近的审批实例，验证权限和数据格式
router.get("/test", async (_req: Request, res: Response) => {
  if (!isDingTalkConfigured()) {
    res.status(400).json({ error: "DingTalk not configured" });
    return;
  }

  try {
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const result = await getApprovalInstances(yesterday, now, 0, 10);

    if (result.list.length === 0) {
      res.json({
        success: true,
        message: "权限正常，但最近 24 小时没有审批实例",
        instanceCount: 0,
      });
      return;
    }

    const detail = await getApprovalDetail(result.list[0]);
    res.json({
      success: true,
      message: "权限正常，已获取一条审批实例",
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
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const startStr = startDate || yesterday.toISOString().split("T")[0];
  const endStr = endDate || startStr;

  try {
    const result = await syncApprovals(dateToMs(startStr), dateToMs(endStr));
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

export default router;
