import { Router, Request, Response } from "express";
import { listApprovals, getApprovalLineage } from "../services/lineageViewerService";

/**
 * 数据血缘查看器（只读 API）。
 * 让用户直观看到「钉钉原始表单 → 解析结果 → 标准化入库」三步数据，
 * 以及关联的数据质量问题。全部为只读，不修改任何数据。
 */
const router = Router();

/**
 * GET /data-lineage/approvals?start=&end=&user=&limit=&offset=
 * 审批单列表（含每单解析出的签到点数、质量问题数）
 */
router.get("/approvals", async (req: Request, res: Response) => {
  try {
    const { start, end, user, limit, offset } = req.query;
    const result = await listApprovals({
      startDate: start ? String(start) : undefined,
      endDate: end ? String(end) : undefined,
      userName: user ? String(user) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Failed to list approvals:", err);
    res.status(500).json({ error: "Failed to list approvals" });
  }
});

/**
 * GET /data-lineage/approvals/:approvalId
 * 单条审批单的三步血缘详情（原始表单 / 解析结果 / 入库 visits / 质量记录）
 */
router.get("/approvals/:approvalId", async (req: Request, res: Response) => {
  try {
    const { approvalId } = req.params;
    const detail = await getApprovalLineage(approvalId);
    if (!detail) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    res.json({ success: true, ...detail });
  } catch (err) {
    console.error("Failed to get approval lineage:", err);
    res.status(500).json({ error: "Failed to get approval lineage" });
  }
});

export default router;
