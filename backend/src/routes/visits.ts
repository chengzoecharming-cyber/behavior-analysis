import { Router, Response } from "express";
import { pool } from "../db";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
  toBeijingDayStart,
  toBeijingDayEnd,
  formatBeijingDate,
} from "../utils/timezone";
import { getCanonicalDepartment } from "../services/departmentAliasService";
import { resolveUserIdsForScope } from "../services/orgService";
import { authMiddleware, AuthRequest, requireRole } from "../services/auth";
import {
  canViewUser,
  getVisibleUserIds,
  FORBIDDEN_MESSAGE,
} from "../services/permission";

const router = Router();

// 手动补坐标（admin/manager，且目标成员在可见范围内）
router.post("/:id/coordinates", authMiddleware, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
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
    // 目标签到所属成员必须在可见范围内
    const owner = await pool.query(`SELECT user_id FROM visits WHERE id = $1`, [Number(id)]);
    if (owner.rows.length === 0) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }
    if (!(await canViewUser(req.currentUser!, owner.rows[0].user_id))) {
      res.status(403).json({ error: FORBIDDEN_MESSAGE });
      return;
    }

    const result = await pool.query(
      `UPDATE visits
       SET lat = $1, lng = $2, geocode_status = 'manual'
       WHERE id = $3
       RETURNING *`,
      [lat, lng, Number(id)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update coordinates:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { user, start, end } = req.query;

  if (!user || !start || !end) {
    res.status(400).json({ error: "Missing user, start or end parameter" });
    return;
  }

  try {
    if (!(await canViewUser(req.currentUser!, user as string))) {
      res.status(403).json({ error: FORBIDDEN_MESSAGE });
      return;
    }

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

// 控制台级联选择器数据源之一：只返回当前用户可见范围内的人员
router.get("/users", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // 同一 user_id 可能因部门字段写法不同出现重复，按出现次数取最常用的一条
    const result = await pool.query(
      `WITH grouped AS (
         SELECT user_id, user_name, department, COUNT(*) AS cnt
         FROM visits
         GROUP BY user_id, user_name, department
       ),
       ranked AS (
         SELECT user_id, user_name, department, cnt,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY cnt DESC) AS rn
         FROM grouped
       )
       SELECT user_id, user_name, department
       FROM ranked
       WHERE rn = 1
       ORDER BY user_name`
    );

    const visible = await getVisibleUserIds(req.currentUser!);
    const rows = visible === null
      ? result.rows
      : result.rows.filter((r) => visible.includes(r.user_id));

    // 把原始 department 映射成规范部门
    const users = await Promise.all(
      rows.map(async (row) => ({
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

// 获取某用户/组织维度有数据的日期列表
router.get("/available-dates", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { user, scope, node, with_anomaly } = req.query;

  try {
    const currentUser = req.currentUser!;
    let userIds: string[] = [];

    if (user) {
      if (!(await canViewUser(currentUser, user as string))) {
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }
      userIds = [user as string];
    } else if (scope) {
      const validScope =
        scope === "department" || scope === "sub_department" ? scope : "company";
      const nodeName = typeof node === "string" && node ? node : "__ALL__";
      userIds = await resolveUserIdsForScope(validScope, nodeName);
      // 按当前用户可见范围收敛
      const visible = await getVisibleUserIds(currentUser);
      if (visible !== null) {
        const visibleSet = new Set(visible);
        userIds = userIds.filter((id) => visibleSet.has(id));
      }
    } else {
      res.status(400).json({ error: "Missing user or scope parameter" });
      return;
    }

    if (userIds.length === 0) {
      res.json([]);
      return;
    }

    const result = await pool.query(
      `SELECT DISTINCT business_date as date
       FROM visits
       WHERE user_id = ANY($1::text[]) AND business_date IS NOT NULL
       ORDER BY date DESC`,
      [userIds]
    );
    const dates = result.rows.map((r) => formatBeijingDate(r.date));

    if (with_anomaly === "true") {
      const anomalyResult = await pool.query(
        `SELECT DISTINCT anomaly_date as date
         FROM anomalies
         WHERE user_id = ANY($1::text[]) AND anomaly_date IS NOT NULL`,
        [userIds]
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

// GET /visits/synced-dates
// 返回钉钉同步已成功覆盖的日期列表（全局口径，不含用户数据，所有登录角色可读）。
// 用途：前端日历轴把「已同步但无数据」的日期（如全员未提交审批的周末）展示为置灰，
// 与「尚未同步」的日期区分开。
router.get("/synced-dates", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT generate_series(start_date, end_date, interval '1 day')::date AS date
       FROM dingtalk_sync_logs
       WHERE status = 'success'
       ORDER BY date`
    );
    res.json(result.rows.map((r) => formatBeijingDate(r.date)));
  } catch (err) {
    console.error("Failed to fetch synced dates:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
