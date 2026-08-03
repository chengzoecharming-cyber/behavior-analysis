import { Router, Response } from "express";
import { pool } from "../db";
import { computeAndPersistStops } from "../services/stopDetection";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
  toBeijingDayStart,
  toBeijingDayEnd,
} from "../utils/timezone";
import { authMiddleware, AuthRequest } from "../services/auth";
import { canViewUser, FORBIDDEN_MESSAGE } from "../services/permission";

const router = Router();

router.get("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { user, date, start, end } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  if (!(await canViewUser(req.currentUser!, user as string))) {
    res.status(403).json({ error: FORBIDDEN_MESSAGE });
    return;
  }

  // 范围模式：直接查询已持久化的 stops
  if (start && end) {
    try {
      const result = await pool.query(
        `SELECT * FROM stops
         WHERE user_id = $1 AND business_date >= $2::date AND business_date <= $3::date
         ORDER BY start_time ASC`,
        [user, start, end]
      );
      res.json(result.rows);
      return;
    } catch (err) {
      console.error("Failed to fetch stops range:", err);
      res.status(500).json({ error: "Database error" });
      return;
    }
  }

  if (!date) {
    res.status(400).json({ error: "Missing date or start/end parameter" });
    return;
  }

  try {
    const persisted = await computeAndPersistStops(user as string, date as string);
    res.json(persisted);
  } catch (err) {
    console.error("Failed to fetch stops:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
