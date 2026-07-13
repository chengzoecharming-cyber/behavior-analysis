import { Router, Request, Response } from "express";
import { pool } from "../db";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
  toBeijingDayStart,
  toBeijingDayEnd,
  formatBeijingDate,
} from "../utils/timezone";
import { getCanonicalDepartment } from "../services/departmentAliasService";

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
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start as string);
    const { start: rangeStart, end: rangeEnd } = isDateOnly
      ? toBeijingRange(start as string, end as string)
      : { start: ensureBeijingTimestamp(start as string), end: ensureBeijingTimestamp(end as string) };
    const result = await pool.query(
      `SELECT * FROM visits
       WHERE user_id = $1 AND business_date >= $2::date AND business_date <= $3::date
       ORDER BY timestamp ASC`,
      [user, rangeStart, rangeEnd]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch visits:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/users", async (_req: Request, res: Response) => {
  try {
    // 同一 user_id 可能因部门字段写法不同出现重复，按出现次数取最常用的一条
    const result = await pool.query(
      `SELECT user_id, user_name, department
       FROM (
         SELECT user_id, user_name, department,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rn
         FROM visits
         GROUP BY user_id, user_name, department
       ) t
       WHERE rn = 1
       ORDER BY user_name`
    );

    // 把原始 department 映射成规范部门
    const users = await Promise.all(
      result.rows.map(async (row) => ({
        ...row,
        department: (await getCanonicalDepartment(row.department)) || row.department,
      }))
    );

    res.json(users);
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 获取某用户有数据的日期列表
router.get("/available-dates", async (req: Request, res: Response) => {
  const { user, with_anomaly } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT DISTINCT business_date as date
       FROM visits
       WHERE user_id = $1 AND business_date IS NOT NULL
       ORDER BY date DESC`,
      [user]
    );
    const dates = result.rows.map((r) => formatBeijingDate(r.date));

    if (with_anomaly === "true") {
      const anomalyResult = await pool.query(
        `SELECT DISTINCT anomaly_date as date
         FROM anomalies
         WHERE user_id = $1 AND anomaly_date IS NOT NULL`,
        [user]
      );
      const anomalyDates = new Set(
        anomalyResult.rows.map((r) => formatBeijingDate(r.date))
      );
      res.json(
        dates.map((d) => ({
          date: d,
          has_anomaly: anomalyDates.has(d),
        }))
      );
      return;
    }

    res.json(dates);
  } catch (err) {
    console.error("Failed to fetch available dates:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
