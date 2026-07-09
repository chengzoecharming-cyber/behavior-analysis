import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { pool } from "../db";
import { computeUserOverview } from "../services/userOverviewService";
import { renderConsoleReportHtml } from "../services/exportReport";
import {
  isExportConfigured,
  uploadMediaToDingTalk,
  sendFileToDingTalkChat,
  sendReportSummaryByRobot,
} from "../services/dingtalkFile";

const router = Router();

function daysBetween(start: string, end: string): number {
  const s = new Date(start + "T00:00:00+08:00");
  const e = new Date(end + "T00:00:00+08:00");
  const diff = Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
  return diff + 1;
}

async function getUserName(userId: string): Promise<string> {
  try {
    // 优先从用户表查询
    const authResult = await pool.query(
      "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
      [userId]
    );
    if (authResult.rows[0]?.user_name) {
      return authResult.rows[0].user_name;
    }

    // fallback 从拜访记录中出现最频繁的名字
    const visitResult = await pool.query(
      `SELECT user_name, COUNT(*) AS cnt
       FROM visits
       WHERE user_id = $1
       GROUP BY user_name
       ORDER BY cnt DESC
       LIMIT 1`,
      [userId]
    );
    return visitResult.rows[0]?.user_name || userId;
  } catch (err) {
    console.warn("获取员工姓名失败:", err);
    return userId;
  }
}

router.post("/console-report", async (req: Request, res: Response) => {
  const { userId, start, end, amapKey, points } = req.body || {};

  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "Missing userId" });
    return;
  }
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    res.status(400).json({ error: "Invalid start date" });
    return;
  }
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    res.status(400).json({ error: "Invalid end date" });
    return;
  }
  if (start > end) {
    res.status(400).json({ error: "start date must be before end date" });
    return;
  }
  if (!isExportConfigured()) {
    res.status(503).json({ error: "未配置 DINGTALK_EXPORT_CHAT_ID" });
    return;
  }

  let tempFile = "";
  try {
    const [overview, userName] = await Promise.all([
      computeUserOverview(userId, start, end),
      getUserName(userId),
    ]);

    const dayCount = daysBetween(start, end);
    const estimatedFuelCost = overview.totals.estimated_distance_km * 0.8;
    const visitFrequency = dayCount > 0 ? overview.totals.visit_count / dayCount : 0;

    const html = renderConsoleReportHtml({
      userId,
      userName,
      start,
      end,
      overview,
      estimatedFuelCost,
      visitFrequency,
      amapKey: typeof amapKey === "string" ? amapKey : "",
      points: Array.isArray(points) ? points : [],
    });

    const fileName = `${userName}_${start}_${end}_外勤报告.html`;
    tempFile = path.join(os.tmpdir(), `console-report-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(tempFile, html, "utf-8");

    const mediaId = await uploadMediaToDingTalk(tempFile, fileName);
    await sendFileToDingTalkChat(mediaId, fileName);

    const summary = `**${userName}** 外勤行为报告已生成\n\n时间：${start} ~ ${end}\n\n填报/估算里程：${overview.totals.reported_distance_km} / ${Math.round(overview.totals.estimated_distance_km)} km\n\n预估油费：${estimatedFuelCost.toFixed(2)} 元\n\n拜访频率：${visitFrequency.toFixed(2)} 次/天`;
    await sendReportSummaryByRobot(summary);

    res.json({ success: true, message: "已发送到钉钉群" });
  } catch (err: any) {
    console.error("导出控制台报告失败:", err);
    res.status(500).json({
      error: err?.message || "导出失败",
    });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // ignore
      }
    }
  }
});

export default router;
