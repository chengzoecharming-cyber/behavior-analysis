import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";

router.post("/login", async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, user_id, user_name, department, role, manager_id, created_at
       FROM users
       WHERE user_id = $1
       LIMIT 1`,
      [AUTH_USERNAME]
    );

    if (result.rows.length === 0) {
      res.status(500).json({ error: "默认管理员用户不存在" });
      return;
    }

    res.json({
      user_id: result.rows[0].user_id,
      user_name: result.rows[0].user_name,
      department: result.rows[0].department,
      role: result.rows[0].role,
    });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "登录失败" });
  }
});

export default router;
