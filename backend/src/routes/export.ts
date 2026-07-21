import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { pool } from "../db";
import { computeUserOverview } from "../services/userOverviewService";
import { renderConsoleReportHtml, renderScopeConsoleReportHtml, renderPersonSingleDayHtml } from "../services/exportReport";
import { computeOrgOverview, OrgOverviewResult } from "../services/orgService";
import { renderConsoleReportMarkdown } from "../services/exportConsoleReportMarkdown";
import {
  exportConsoleReportToDingTalkDoc,
  inferReportType,
} from "../services/dingtalkDoc";
import {
  isExportConfigured,
  uploadMediaToDingTalk,
  sendFileToDingTalkChat,
  sendReportSummaryByRobot,
} from "../services/dingtalkFile";
import {
  generateDailyReports,
  generateWeeklyReports,
  generateMonthlyReports,
  exportReportToDingTalkDoc,
} from "../services/reportGenerationService";
import { ReportScopeTarget } from "../services/dingtalkDoc";

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

function isDocExportConfigured(): boolean {
  return !!process.env.DINGTALK_OPERATOR_USERID;
}

router.post("/console-report-to-doc", async (req: Request, res: Response) => {
  const { userId, start, end } = req.body || {};

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
  if (!isDocExportConfigured()) {
    res.status(503).json({ error: "未配置 DINGTALK_OPERATOR_USERID" });
    return;
  }

  try {
    const operatorUserId = process.env.DINGTALK_OPERATOR_USERID!;
    const workspaceName =
      process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";

    const [overview, userName] = await Promise.all([
      computeUserOverview(userId, start, end),
      getUserName(userId),
    ]);

    // 单日报告时补充详细拜访、停留、路线数据
    let visits, stops, routes;
    if (start === end) {
      [visits, stops, routes] = await Promise.all([
        pool
          .query(
            `SELECT * FROM visits WHERE user_id = $1 AND business_date = $2::date ORDER BY timestamp`,
            [userId, start]
          )
          .then((r) => r.rows),
        pool
          .query(
            `SELECT * FROM stops WHERE user_id = $1 AND business_date = $2::date ORDER BY start_time`,
            [userId, start]
          )
          .then((r) => r.rows),
        pool
          .query(
            `SELECT * FROM routes WHERE user_id = $1 AND business_date = $2::date ORDER BY id`,
            [userId, start]
          )
          .then((r) => r.rows),
      ]);
    }

    const { reportType } = inferReportType(start, end);

    const markdown = renderConsoleReportMarkdown({
      userName,
      userId,
      start,
      end,
      reportType,
      overview,
      visits,
      routes,
    });

    const result = await exportConsoleReportToDingTalkDoc({
      operatorUserId,
      targetUserId: userId,
      targetUserName: userName,
      workspaceName,
      start,
      end,
      markdown,
    });

    res.json({
      success: true,
      message: `已导出到钉钉文档「${result.reportType}」目录`,
      url: result.url,
      docKey: result.docKey,
      nodeId: result.nodeId,
      workspaceId: result.workspaceId,
      reportType: result.reportType,
      reportDate: result.reportDate,
    });
  } catch (err: any) {
    console.error("导出控制台报告到钉钉文档失败:", err);
    res.status(500).json({
      error: err?.message || "导出失败",
    });
  }
});

type NestedRankingItem = OrgOverviewResult["ranking"][number] & {
  children?: NestedRankingItem[];
};

async function buildNestedRanking(
  scope: "company" | "department" | "sub_department",
  node: string,
  start: string,
  end: string
): Promise<NestedRankingItem[]> {
  const overview = await computeOrgOverview(scope, node, start, end);
  const ranking: NestedRankingItem[] = overview.ranking.map((r) => ({ ...r }));

  if (scope === "company") {
    for (const dept of ranking) {
      if (dept.hasChildren) {
        dept.children = await buildNestedRanking("department", dept.key, start, end);
      }
    }
  } else if (scope === "department") {
    for (const sub of ranking) {
      if (sub.hasChildren) {
        sub.children = await buildNestedRanking("sub_department", sub.key, start, end);
      }
    }
  }
  // sub_department 维度下 ranking 是人员，无需再展开

  return ranking;
}

router.post("/console-report", async (req: Request, res: Response) => {
  const { scope, node, userId, start, end, amapKey, points } = req.body || {};

  const reportScope = scope || "person";
  if (!["company", "department", "sub_department", "person"].includes(reportScope)) {
    res.status(400).json({ error: "Invalid scope" });
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
  if (reportScope === "person" && (!userId || typeof userId !== "string")) {
    res.status(400).json({ error: "Missing userId for person scope" });
    return;
  }
  if (
    (reportScope === "department" || reportScope === "sub_department") &&
    (!node || typeof node !== "string")
  ) {
    res.status(400).json({ error: "Missing node for department/sub_department scope" });
    return;
  }
  if (!isExportConfigured()) {
    res.status(503).json({ error: "未配置 DINGTALK_EXPORT_CHAT_ID" });
    return;
  }

  let tempFile = "";
  try {
    let html: string;
    let fileName: string;
    let summaryName: string;
    let summaryMetrics: string;

    const dayCount = daysBetween(start, end);

    if (reportScope === "person") {
      const userName = await getUserName(userId);

      if (start === end) {
        // 个人单日：查询明细并渲染轨迹报告
        const [visits, stops, routes, anomalies] = await Promise.all([
          pool
            .query(
              `SELECT * FROM visits WHERE user_id = $1 AND business_date = $2::date ORDER BY timestamp`,
              [userId, start]
            )
            .then((r) => r.rows),
          pool
            .query(
              `SELECT * FROM stops WHERE user_id = $1 AND business_date = $2::date ORDER BY start_time`,
              [userId, start]
            )
            .then((r) => r.rows),
          pool
            .query(
              `SELECT * FROM routes WHERE user_id = $1 AND business_date = $2::date ORDER BY id`,
              [userId, start]
            )
            .then((r) => r.rows),
          pool
            .query(
              `SELECT * FROM anomalies WHERE user_id = $1 AND anomaly_date = $2::date ORDER BY created_at DESC`,
              [userId, start]
            )
            .then((r) => r.rows),
        ]);

        const totalKm = routes.reduce((sum, r) => sum + r.distance_km, 0);

        // 按 approval_id 取最大填报里程再求和
        const reportedByApproval = new Map<string, number>();
        for (const v of visits) {
          if (v.reported_distance_km == null || v.reported_distance_km <= 0) continue;
          const key = v.approval_id || `${v.user_id}_${v.business_date}`;
          const current = reportedByApproval.get(key) || 0;
          reportedByApproval.set(key, Math.max(current, v.reported_distance_km));
        }
        const reportedDistanceKm = Array.from(reportedByApproval.values()).reduce(
          (sum, val) => sum + val,
          0
        );

        html = renderPersonSingleDayHtml({
          userName,
          userId,
          date: start,
          visits,
          stops,
          routes,
          anomalies,
          mileage: {
            totalKm,
            reportedDistanceKm,
            segmentCount: routes.length,
            estimatedFuelCost: totalKm * 0.8,
          },
          amapKey: typeof amapKey === "string" ? amapKey : "",
        });

        fileName = `${userName}_${start}_外勤报告.html`;
        summaryName = userName;
        summaryMetrics = `拜访点数：${visits.length}\n\n总里程/估算里程：${reportedDistanceKm || 0} / ${Math.round(totalKm)} km\n\n估算油费：${(totalKm * 0.8).toFixed(2)} 元\n\nSegment 数：${routes.length}`;
      } else {
        const overview = await computeUserOverview(userId, start, end);
        const estimatedFuelCost = overview.totals.estimated_distance_km * 0.8;
        const visitFrequency = dayCount > 0 ? overview.totals.visit_count / dayCount : 0;

        html = renderConsoleReportHtml({
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

        fileName = `${userName}_${start}_${end}_外勤报告.html`;
        summaryName = userName;
        summaryMetrics = `填报/估算里程：${overview.totals.reported_distance_km} / ${Math.round(overview.totals.estimated_distance_km)} km\n\n预估油费：${estimatedFuelCost.toFixed(2)} 元\n\n拜访频率：${visitFrequency.toFixed(2)} 次/天`;
      }
    } else {
      const nodeName = reportScope === "company" ? "__ALL__" : node;
      const [orgOverview, nestedRanking] = await Promise.all([
        computeOrgOverview(
          reportScope as "company" | "department" | "sub_department",
          nodeName,
          start,
          end
        ),
        buildNestedRanking(
          reportScope as "company" | "department" | "sub_department",
          nodeName,
          start,
          end
        ),
      ]);

      const scopeName = reportScope === "company" ? "公司" : node;
      const estimatedFuelCost = orgOverview.stats.totalEstimatedKm * 0.8;
      const visitFrequency = dayCount > 0 ? orgOverview.stats.totalVisits / dayCount : 0;

      html = renderScopeConsoleReportHtml({
        scope: reportScope as "company" | "department" | "sub_department",
        scopeName,
        start,
        end,
        stats: {
          totalVisits: orgOverview.stats.totalVisits,
          totalReportedKm: orgOverview.stats.totalReportedKm,
          totalEstimatedKm: orgOverview.stats.totalEstimatedKm,
        },
        trend: orgOverview.trend,
        ranking: nestedRanking as any,
        estimatedFuelCost,
        visitFrequency,
        amapKey: typeof amapKey === "string" ? amapKey : "",
        points: Array.isArray(points) ? points : [],
      });

      fileName = `${scopeName}_${start}_${end}_外勤报告.html`;
      summaryName = scopeName;
      summaryMetrics = `填报/估算里程：${Math.round(orgOverview.stats.totalReportedKm)} / ${Math.round(orgOverview.stats.totalEstimatedKm)} km\n\n预估油费：${estimatedFuelCost.toFixed(2)} 元\n\n拜访频率：${visitFrequency.toFixed(2)} 次/天`;
    }

    tempFile = path.join(
      os.tmpdir(),
      `console-report-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
    );
    fs.writeFileSync(tempFile, html, "utf-8");

    const mediaId = await uploadMediaToDingTalk(tempFile, fileName);
    await sendFileToDingTalkChat(mediaId, fileName);

    const summary = `**${summaryName}** 外勤行为报告已生成\n\n时间：${start} ~ ${end}\n\n${summaryMetrics}`;
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

router.post("/scope-report-to-doc", async (req: Request, res: Response) => {
  const { scope, node, userId, start, end } = req.body || {};

  if (!scope || !["company", "department", "sub_department", "person"].includes(scope)) {
    res.status(400).json({ error: "Invalid or missing scope" });
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
  if (scope === "person" && (!userId || typeof userId !== "string")) {
    res.status(400).json({ error: "Missing userId for person scope" });
    return;
  }
  if ((scope === "department" || scope === "sub_department") && (!node || typeof node !== "string")) {
    res.status(400).json({ error: "Missing node for department/sub_department scope" });
    return;
  }
  if (!process.env.DINGTALK_OPERATOR_USERID) {
    res.status(503).json({ error: "未配置 DINGTALK_OPERATOR_USERID" });
    return;
  }

  try {
    const operatorUserId = process.env.DINGTALK_OPERATOR_USERID!;
    const workspaceName =
      process.env.DINGTALK_DOC_WORKSPACE_NAME || "外勤拜访报告";

    let target: ReportScopeTarget;
    if (scope === "company") {
      target = { scope: "company" };
    } else if (scope === "department") {
      target = { scope: "department", deptName: node };
    } else if (scope === "sub_department") {
      target = { scope: "sub_department", subDeptName: node };
    } else {
      const userName = await getUserName(userId);
      target = { scope: "person", userId, userName };
    }

    const result = await exportReportToDingTalkDoc({
      operatorUserId,
      workspaceName,
      scope,
      target,
      start,
      end,
    });

    res.json({
      success: true,
      message: `已导出到钉钉文档「${result.reportType}」目录`,
      url: result.url,
      docKey: result.docKey,
      nodeId: result.nodeId,
      scope: result.scope,
      reportType: result.reportType,
      hasData: result.hasData,
    });
  } catch (err: any) {
    console.error("导出范围报告到钉钉文档失败:", err);
    res.status(500).json({ error: err?.message || "导出失败" });
  }
});

router.post("/generate-reports", async (req: Request, res: Response) => {
  const { type, date, start, end, year, month } = req.body || {};

  if (!type || !["daily", "weekly", "monthly"].includes(type)) {
    res.status(400).json({ error: "Invalid or missing type (daily|weekly|monthly)" });
    return;
  }

  if (!process.env.DINGTALK_OPERATOR_USERID) {
    res.status(503).json({ error: "未配置 DINGTALK_OPERATOR_USERID" });
    return;
  }

  try {
    let results;
    if (type === "daily") {
      results = await generateDailyReports(date);
    } else if (type === "weekly") {
      results = await generateWeeklyReports(start, end);
    } else {
      const y = year ? parseInt(String(year), 10) : undefined;
      const m = month ? parseInt(String(month), 10) : undefined;
      results = await generateMonthlyReports(y, m);
    }

    res.json({
      success: true,
      type,
      count: results.length,
      results,
    });
  } catch (err: any) {
    console.error("手动触发报告生成失败:", err);
    res.status(500).json({ error: err?.message || "生成失败" });
  }
});

export default router;
