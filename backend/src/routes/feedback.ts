import { Router, Response } from "express";
import { pool } from "../db";
import {
  authMiddleware,
  AuthRequest,
  requireRole,
  canViewFeedback,
} from "../services/auth";

const router = Router();

router.get("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.currentUser!;
    let query =
      "SELECT f.*, u.user_name as submitter_name FROM feedback f LEFT JOIN users u ON f.user_id = u.user_id";
    const params: any[] = [];

    if (user.role === "staff") {
      query += " WHERE f.user_id = $1";
      params.push(user.user_id);
    } else if (user.role === "manager") {
      query +=
        " WHERE f.user_id = $1 OR f.user_id IN (SELECT user_id FROM users WHERE manager_id = $2)";
      params.push(user.user_id, user.id);
    }

    query += " ORDER BY f.created_at DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to list feedback:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.currentUser!;
    const result = await pool.query(
      `SELECT f.*, u.user_name as submitter_name
       FROM feedback f
       LEFT JOIN users u ON f.user_id = u.user_id
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Feedback not found" });
      return;
    }

    const fb = result.rows[0];
    const canView = await canViewFeedback(user, fb.user_id);
    if (!canView) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.json(fb);
  } catch (err) {
    console.error("Failed to get feedback:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.currentUser!;
    const { start_date, end_date, description } = req.body;
    if (!start_date || !end_date || !description) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO feedback (user_id, start_date, end_date, description, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [user.user_id, start_date, end_date, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Failed to create feedback:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.put(
  "/:id/review",
  authMiddleware,
  requireRole("admin", "manager"),
  async (req: AuthRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const user = req.currentUser!;
      const { status, review_note } = req.body;
      if (!status || !["approved", "denied"].includes(status)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }

      await client.query("BEGIN");

      const feedbackResult = await client.query(
        "SELECT * FROM feedback WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (feedbackResult.rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Feedback not found" });
        return;
      }

      const fb = feedbackResult.rows[0];
      const canView = await canViewFeedback(user, fb.user_id);
      if (!canView) {
        await client.query("ROLLBACK");
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const updated = await client.query(
        `UPDATE feedback
         SET status = $1,
             reviewer_id = $2,
             review_note = $3,
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, user.user_id, review_note || null, req.params.id]
      );

      if (status === "approved") {
        await client.query(
          `INSERT INTO anomaly_exceptions (user_id, start_date, end_date, feedback_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (feedback_id) DO NOTHING`,
          [fb.user_id, fb.start_date, fb.end_date, fb.id]
        );
      }

      // 审批结果可能影响该区间内的风险摘要缓存，清除相关缓存
      await client.query(
        `DELETE FROM risk_summary_cache
         WHERE user_id = $1 AND date >= $2 AND date <= $3`,
        [fb.user_id, fb.start_date, fb.end_date]
      );

      await client.query("COMMIT");
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to review feedback:", err);
      res.status(500).json({ error: "Database error" });
    } finally {
      client.release();
    }
  }
);

export default router;
