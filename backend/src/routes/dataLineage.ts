import { Router, Response } from "express";
import { listApprovals, getApprovalLineage } from "../services/lineageViewerService";
import { authMiddleware, AuthRequest } from "../services/auth";
import { getVisibleUserIds, FORBIDDEN_MESSAGE } from "../services/permission";

/**
 * 数据血缘查看器（只读 API）。
 * 让用户直观看到「钉钉原始表单 → 解析结果 → 标准化入库」三步数据，
 * 以及关联的数据质量问题。全部为只读，不修改任何数据。
 */
const router = Router();

/**
 * GET /data-lineage/approvals?start=&end=&user=&limit=&offset=
 * 审批单列表（含每单解析出的签到点数、质量问题数）
 * 非 admin 只返回可见成员有签到入库的审批单
 */
router.get("/approvals", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { start, end, user, limit, offset } = req.query;
    const visible = await getVisibleUserIds(req.currentUser!);
    const result = await listApprovals({
      startDate: start ? String(start) : undefined,
      endDate: end ? String(end) : undefined,
      userName: user ? String(user) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
      visibleUserIds: visible,
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
 * 非 admin 只能查看可见成员的审批单
 */
router.get("/approvals/:approvalId", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { approvalId } = req.params;
    const detail = await getApprovalLineage(approvalId);
    if (!detail) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const visible = await getVisibleUserIds(req.currentUser!);
    if (visible !== null) {
      const visibleSet = new Set(visible);
      const ownerIds = (detail.storedVisits || []).map((v: any) => v.user_id).filter(Boolean);
      if (ownerIds.length > 0 && !ownerIds.some((id: string) => visibleSet.has(id))) {
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }
    }
    res.json({ success: true, ...detail });
  } catch (err) {
    console.error("Failed to get approval lineage:", err);
    res.status(500).json({ error: "Failed to get approval lineage" });
  }
});

export default router;
