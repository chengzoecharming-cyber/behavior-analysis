import { Router, Request, Response } from "express";
import { authMiddleware, requireRole, AuthRequest } from "../services/auth";
import { sendReportMessageToUsers } from "../services/dingtalkFile";
import {
  computeSpecialReport,
  getSpecialReportTokenStatus,
  issueSpecialReportTokens,
  recordSpecialReportView,
  resolveSpecialReportToken,
} from "../services/specialReportService";

/**
 * 「盛夏战报」特别推送路由。
 * GET /:token 为公开接口（免登录，凭 token 访问），不挂 authMiddleware。
 */
const router = Router();

const DEFAULT_START = "2026-06-01";
const DEFAULT_END = "2026-09-30";
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:5173";

/** 公开：凭 token 查看战报 */
router.get("/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const info = await resolveSpecialReportToken(token);
    if (!info) {
      const status = await getSpecialReportTokenStatus(token);
      if (status === "expired") {
        res.status(410).json({ error: "战报已过期" });
      } else {
        res.status(404).json({ error: "战报不存在" });
      }
      return;
    }
    // 打开埋点：fire-and-forget，失败不影响返回
    const ua = req.headers["user-agent"];
    void recordSpecialReportView(token, info.user_id, typeof ua === "string" ? ua : null);
    const report = await computeSpecialReport(
      info.user_id,
      info.role,
      info.department,
      info.period_start,
      info.period_end,
      info.kind
    );
    res.json(report);
  } catch (err) {
    console.error("[SpecialReport] 查询战报失败:", err);
    res.status(500).json({ error: "战报生成失败" });
  }
});

/** 管理员：签发 token 并通过钉钉逐人推送战报链接 */
router.post(
  "/push",
  authMiddleware,
  requireRole("admin"),
  async (req: AuthRequest, res: Response) => {
    try {
      const start: string = req.body?.start || DEFAULT_START;
      const end: string = req.body?.end || DEFAULT_END;
      const dryRun: boolean = req.body?.dryRun === true;

      const issued = await issueSpecialReportTokens(start, end);

      if (dryRun) {
        res.json({
          count: issued.length,
          users: issued.map(({ user_id, user_name, role }) => ({ user_id, user_name, role })),
        });
        return;
      }

      // 周期自然天数（含首尾），用于文案
      const days =
        Math.round(
          (new Date(`${end}T00:00:00+08:00`).getTime() -
            new Date(`${start}T00:00:00+08:00`).getTime()) /
            86400000
        ) + 1;

      let sent = 0;
      let failed = 0;
      // 逐人发送（每人链接不同），单个失败不中断整体推送；
      // manager/admin 有 personal + team 两条 token，分别发两条消息
      for (const u of issued) {
        const link = `${FRONTEND_BASE_URL}/report/${u.token}`;
        const text =
          u.kind === "team"
            ? `📊 你团队的盛夏战报也好了\n\n` +
              `看看这个夏天，大家跑了多少、谁最拼。\n\n` +
              `👉 [开启团队战报](${link})`
            : `🏆 你的盛夏战报已生成\n\n` +
              `${days} 个日夜，你走过的每一步都算数。\n\n` +
              `👉 [开启我的战报](${link})`;
        try {
          await sendReportMessageToUsers([u.user_id], "盛夏战报", text);
          sent++;
        } catch (err) {
          console.error(`[SpecialReport] 推送失败 user=${u.user_id} kind=${u.kind}:`, err);
          failed++;
        }
      }

      res.json({ sent, failed });
    } catch (err) {
      console.error("[SpecialReport] 推送战报失败:", err);
      res.status(500).json({ error: "战报推送失败" });
    }
  }
);

export default router;
