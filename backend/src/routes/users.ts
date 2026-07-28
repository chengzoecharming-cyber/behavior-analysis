import { Router, Response } from "express";
import { pool } from "../db";
import {
  authMiddleware,
  AuthRequest,
  requireRole,
} from "../services/auth";
import { getUserIdsUnderNode } from "../services/orgService";
import { previewReconcile, reconcileUsers } from "../services/userSyncService";

const router = Router();

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  res.json(req.currentUser);
});

// 用户列表：附带 last_visit_date（最近签到日期）；is_invalid（部门白名单外）用户不返回
// 权限：admin 全量；manager 看自己 + 本部门（含子部门）成员；staff 仅自己
router.get("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.currentUser!;
    const baseSelect = `
      SELECT u.*, v.last_visit_date
      FROM users u
      LEFT JOIN (
        SELECT user_id, MAX(business_date) AS last_visit_date
        FROM visits
        GROUP BY user_id
      ) v ON v.user_id = u.user_id
      WHERE u.is_invalid = false`;

    let result;
    if (user.role === "admin") {
      result = await pool.query(`${baseSelect} ORDER BY u.created_at DESC`);
    } else if (user.role === "manager") {
      // department 为空时仅自己；否则加上本部门（含子部门）成员
      const visibleUserIds = user.department
        ? await getUserIdsUnderNode(user.department)
        : [];
      const ids = Array.from(new Set([user.user_id, ...visibleUserIds]));
      result = await pool.query(
        `${baseSelect} AND u.user_id = ANY($1) ORDER BY u.created_at DESC`,
        [ids]
      );
    } else {
      result = await pool.query(
        `${baseSelect} AND u.user_id = $1`,
        [user.user_id]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to list users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 手动触发用户对账：body { dryRun?: boolean }
// dryRun=true 只返回预览不写库；否则执行真实对账
router.post("/sync", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const dryRun = !!req.body?.dryRun;
  try {
    const result = dryRun ? await previewReconcile() : await reconcileUsers();
    res.json(result);
  } catch (err) {
    console.error("Failed to reconcile users:", err);
    res.status(500).json({ error: "User reconcile failed" });
  }
});

router.post("/", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const { user_id, user_name, department, role, manager_id, is_resigned } = req.body;
  if (!user_id || !user_name || !role) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (!["admin", "manager", "staff"].includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (user_id, user_name, department, role, manager_id, is_resigned)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, user_name, department || null, role, manager_id || null, !!is_resigned]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error("Failed to create user:", err);
    if (err.code === "23505") {
      res.status(409).json({ error: "User already exists" });
    } else {
      res.status(500).json({ error: "Database error" });
    }
  }
});

router.put("/:id", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const { user_name, department, role, manager_id, is_resigned } = req.body;
  if (role && !["admin", "manager", "staff"].includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET user_name = COALESCE($1, user_name),
           department = COALESCE($2, department),
           role = COALESCE($3, role),
           manager_id = COALESCE($4, manager_id),
           is_resigned = COALESCE($5, is_resigned)
       WHERE id = $6
       RETURNING *`,
      [user_name, department, role, manager_id, is_resigned, req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete(
  "/:id",
  authMiddleware,
  requireRole("admin"),
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await pool.query(
        "DELETE FROM users WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ message: "Deleted" });
    } catch (err) {
      console.error("Failed to delete user:", err);
      res.status(500).json({ error: "Database error" });
    }
  }
);

export default router;
