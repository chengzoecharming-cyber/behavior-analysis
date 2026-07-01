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
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start as string);
      const { start: rangeStart, end: rangeEnd } = isDateOnly
        ? toBeijingRange(start as string, end as string)
        : { start: ensureBeijingTimestamp(start as string), end: ensureBeijingTimestamp(end as string) };
      const result = await pool.query(
        `SELECT * FROM stops
         WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3
         ORDER BY start_time ASC`,
        [user, rangeStart, rangeEnd]
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

  const dayStart = toBeijingDayStart(date as string);
  const dayEnd = toBeijingDayEnd(date as string);

  try {
    const result = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [user, dayStart, dayEnd]
    );

    const visits: Visit[] = result.rows;
    const stops = detectStops(visits);

    // 持久化到 DERIVED 层（先删除旧数据避免重复）
    await pool.query(
      `DELETE FROM stops WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3`,
      [user, dayStart, dayEnd]
    );

    const persisted: Stop[] = [];
    for (const stop of stops) {
      const r = await pool.query(
        `INSERT INTO stops
         (user_id, start_time, end_time, duration_minutes, lat, lng, location_name, visit_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
