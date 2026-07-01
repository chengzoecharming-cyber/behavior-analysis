import { Router, Response } from "express";
import { pool } from "../db";
import {
  authMiddleware,
  AuthRequest,
  requireRole,
} from "../services/auth";

const router = Router();

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  res.json(req.currentUser);
});

// 切换用户列表：返回所有用户，不区分权限（仅用于本地演示/切换身份）
router.get("/switchable", async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users ORDER BY role, user_name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to list switchable users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.currentUser!;
    let result;
    if (user.role === "admin") {
      result = await pool.query(
        "SELECT * FROM users ORDER BY created_at DESC"
      );
    } else if (user.role === "manager") {
      result = await pool.query(
        "SELECT * FROM users WHERE id = $1 OR manager_id = $1 ORDER BY created_at DESC",
        [user.id]
      );
    } else {
      result = await pool.query("SELECT * FROM users WHERE id = $1", [user.id]);
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to list users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const { user_id, user_name, department, role, manager_id } = req.body;
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
      `INSERT INTO users (user_id, user_name, department, role, manager_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, user_name, department || null, role, manager_id || null]
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
  const { user_name, department, role, manager_id } = req.body;
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
           manager_id = COALESCE($4, manager_id)
       WHERE id = $5
       RETURNING *`,
      [user_name, department, role, manager_id, req.params.id]
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
