import { Router, Request, Response } from "express";
import { pool } from "../db";
import { detectStops } from "../services/stopDetection";
import { Visit, Stop } from "../types";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
  toBeijingDayStart,
  toBeijingDayEnd,
} from "../utils/timezone";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const { user, date, start, end } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
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
    const result = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND business_date = $2::date
       ORDER BY timestamp ASC`,
      [user, date]
    );

    const visits: Visit[] = result.rows;
    const stops = detectStops(visits);

    // 持久化到 DERIVED 层（先删除旧数据避免重复）
    await pool.query(
      `DELETE FROM stops WHERE user_id = $1 AND business_date = $2::date`,
      [user, date]
    );

    const persisted: Stop[] = [];
    for (const stop of stops) {
      const r = await pool.query(
        `INSERT INTO stops
         (user_id, start_time, end_time, duration_minutes, lat, lng, location_name, visit_ids, business_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          stop.user_id,
          stop.start_time,
          stop.end_time,
          stop.duration_minutes,
          stop.lat,
          stop.lng,
          stop.location_name,
          stop.visit_ids,
          stop.business_date ?? date,
        ]
      );
      persisted.push(r.rows[0]);
    }

    res.json(persisted);
  } catch (err) {
    console.error("Failed to fetch stops:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
