/**
 * CRM MCP 同步运维接口（admin-only）。
 * - GET /crm-mcp/sync-logs：同步记录分页列表（同步中心「CRM 同步」Tab 数据源）
 * - GET /crm-mcp/sync-status：最近一轮状态 + 各表单水位线
 * - POST /crm-mcp/sync：手动触发一轮同步（body { full?: boolean }），异步执行
 */

import { Router, Response } from "express";
import { pool } from "../db";
import { authMiddleware, AuthRequest, requireRole } from "../services/auth";
import { syncCrmFromMcp } from "../services/crmMcpSyncService";
import { isCrmMcpConfigured } from "../services/crmMcpClient";

const router = Router();

// GET /crm-mcp/sync-logs?page=1&pageSize=20&status=
router.get("/sync-logs", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "20"), 10) || 20, 1), 100);
  const status = String(req.query.status || "").trim();
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [countRes, listRes] = await Promise.all([
      pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_sync_logs ${whereSql}`, params),
      pool.query(
        `SELECT id, run_id, trigger_source, status, full_sync, stats, error_message, started_at, finished_at
         FROM crm_sync_logs ${whereSql}
         ORDER BY started_at DESC
         OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
        [...params, (page - 1) * pageSize, pageSize]
      ),
    ]);
    res.json({
      success: true,
      total: parseInt(countRes.rows[0]?.n ?? "0", 10),
      page,
      pageSize,
      logs: listRes.rows,
    });
  } catch (err) {
    console.error("Failed to fetch CRM sync logs:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-mcp/sync-status —— 最近一轮 + 各表单水位线 + 配置状态
router.get("/sync-status", authMiddleware, requireRole("admin"), async (_req: AuthRequest, res: Response) => {
  try {
    const [latestRes, stateRes] = await Promise.all([
      pool.query(
        `SELECT id, run_id, trigger_source, status, full_sync, stats, error_message, started_at, finished_at
         FROM crm_sync_logs ORDER BY started_at DESC LIMIT 1`
      ),
      pool.query(`SELECT form_key, last_update_time, last_run_at, last_total, last_status FROM crm_mcp_sync_state ORDER BY form_key`),
    ]);
    res.json({
      success: true,
      configured: isCrmMcpConfigured(),
      sync_enabled: process.env.CRM_MCP_SYNC_ENABLED === "true",
      latest: latestRes.rows[0] ?? null,
      watermarks: stateRes.rows,
    });
  } catch (err) {
    console.error("Failed to fetch CRM sync status:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /crm-mcp/sync —— 手动触发一轮（异步执行，立即返回）
router.post("/sync", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  if (!isCrmMcpConfigured()) {
    res.status(400).json({ error: "CRM_MCP_TOKEN 未配置" });
    return;
  }
  const full = req.body?.full === true;
  syncCrmFromMcp({ full, triggerSource: "manual" })
    .then((r) => console.log(`[crmMcpSync] 手动同步结束 status=${r.status}`))
    .catch((err) => console.error("[crmMcpSync] 手动同步失败:", err));
  res.json({ success: true, message: full ? "全量同步已触发" : "增量同步已触发" });
});

export default router;
