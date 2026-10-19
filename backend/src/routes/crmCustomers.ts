import { Router, Response } from "express";
import { authMiddleware, AuthRequest, requireRole } from "../services/auth";
import { listCustomers, getCustomerDetail } from "../services/crmCustomerDirectory";

const router = Router();

/**
 * 客户库（只读，第一版 admin-only）：
 * 列表 + 客户判断详情。业务逻辑全部在 services/crmCustomerDirectory.ts。
 */

// GET /crm-customers —— 客户列表（关键词/类型/公私海/负责人/阶段筛选 + 分页）
router.get("/", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "20"), 10) || 20, 1), 100);
    const poolParam = String(req.query.pool || "");
    const result = await listCustomers({
      keyword: String(req.query.keyword || "") || undefined,
      customerType: String(req.query.customer_type || "") || undefined,
      pool: poolParam === "pool" || poolParam === "private" ? poolParam : undefined,
      owner: String(req.query.owner || "") || undefined,
      stage: String(req.query.stage || "") || undefined,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    res.json(result);
  } catch (err) {
    console.error("crm-customers list error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-customers/:id —— 客户判断详情（基础信息 + 联系人 + 跟进 + 实际拜访 + 判断信号）
router.get("/:id", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  try {
    const detail = await getCustomerDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "客户不存在" });
      return;
    }
    res.json(detail);
  } catch (err) {
    console.error("crm-customers detail error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
