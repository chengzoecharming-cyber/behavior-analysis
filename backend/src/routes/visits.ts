import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();

// 手动补坐标
router.post("/:id/coordinates", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { lat, lng } = req.body;

  if (!id || isNaN(Number(id))) {
    res.status(400).json({ error: "Invalid visit id" });
    return;
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat and lng must be numbers" });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE visits
       SET lat = $1, lng = $2, geocode_status = 'manual'
       WHERE id = $3
       RETURNING *`,
      [lat, lng, Number(id)]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update coordinates:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/", async (req: Request, res: Response) => {
  const { user, start, end } = req.query;

  if (!user || !start || !end) {
    res.status(400).json({ error: "Missing user, start or end parameter" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user, start, end]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch visits:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/users", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT user_id, user_name, department FROM visits ORDER BY user_name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 获取某用户有数据的日期列表
router.get("/available-dates", async (req: Request, res: Response) => {
  const { user } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT DISTINCT DATE(timestamp) as date
       FROM visits
       WHERE user_id = $1
       ORDER BY date DESC`,
      [user]
    );
    const dates = result.rows.map((r) => r.date.toISOString().split("T")[0]);
    res.json(dates);
  } catch (err) {
    console.error("Failed to fetch available dates:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
