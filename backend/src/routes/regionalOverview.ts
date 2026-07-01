import { Router, Request, Response } from "express";
import { pool } from "../db";
import {
  ensureBeijingTimestamp,
  toBeijingRange,
} from "../utils/timezone";
import {
  getCanonicalDepartment,
  initDepartmentAliases,
  listDepartmentAliases,
  updateDepartmentAlias,
  TARGET_DEPARTMENTS,
} from "../services/departmentAliasService";

const router = Router();

async function cleanDepartment(raw: string | null): Promise<string> {
  const canonical = await getCanonicalDepartment(raw);
  return canonical || "未分类";
}

interface HeatMapPoint {
  lat: number;
  lng: number;
  count: number;
  userName: string;
  locationName: string;
  address: string;
  timestamp: string;
}

interface DepartmentStat {
  name: string;
  visitCount: number;
  employeeCount: number;
}

interface RegionalOverviewResponse {
  start: string;
  end: string;
  department?: string;
  totalVisits: number;
  totalEmployees: number;
  totalLocations: number;
  departments: DepartmentStat[];
  heatMapPoints: HeatMapPoint[];
}

// GET /analytics/regional-overview?start=YYYY-MM-DD&end=YYYY-MM-DD&department=xxx
router.get("/regional-overview", async (req: Request, res: Response) => {
  const { start, end, department } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: "Missing start or end parameter" });
    return;
  }

  try {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start as string);
    const { start: rangeStart, end: rangeEnd } = isDateOnly
      ? toBeijingRange(start as string, end as string)
      : {
          start: ensureBeijingTimestamp(start as string),
          end: ensureBeijingTimestamp(end as string),
        };

    // 基础过滤条件：时间范围 + 有效坐标
    const baseParams: any[] = [rangeStart, rangeEnd];
    let departmentFilter = "";
    if (department && department !== "all") {
      departmentFilter = "AND department ILIKE $3";
      baseParams.push(`%${department}%`);
    }

    // 1. 总拜访数、员工数、不重复地点数
    const overviewResult = await pool.query(
      `SELECT
         COUNT(*) AS total_visits,
         COUNT(DISTINCT user_id) AS total_employees,
         COUNT(DISTINCT CONCAT(ROUND(lat::numeric, 5), ',', ROUND(lng::numeric, 5))) AS total_locations
       FROM visits
       WHERE timestamp >= $1 AND timestamp <= $2
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND (lat <> 0 OR lng <> 0)
         ${departmentFilter}`,
      baseParams
    );

    // 2. 按部门聚合
    const deptResult = await pool.query(
      `SELECT
         department AS raw_department,
         COUNT(*) AS visit_count,
         COUNT(DISTINCT user_id) AS employee_count
       FROM visits
       WHERE timestamp >= $1 AND timestamp <= $2
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND (lat <> 0 OR lng <> 0)
         ${departmentFilter}
       GROUP BY department
       ORDER BY visit_count DESC`,
      baseParams
    );

    // 3. 热力图点位：按坐标和员工聚合，减少重复点
    const heatResult = await pool.query(
      `SELECT
         lat,
         lng,
         COUNT(*) AS count,
         STRING_AGG(DISTINCT user_name, ', ' ORDER BY user_name) AS user_names,
         STRING_AGG(DISTINCT location_name, '; ' ORDER BY location_name) AS location_names,
         STRING_AGG(DISTINCT address, '; ' ORDER BY address) AS addresses,
         MIN(timestamp) AS first_timestamp
       FROM visits
       WHERE timestamp >= $1 AND timestamp <= $2
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND (lat <> 0 OR lng <> 0)
         ${departmentFilter}
       GROUP BY lat, lng
       ORDER BY count DESC`,
      baseParams
    );

    const deptMap = new Map<string, DepartmentStat>();
    for (const row of deptResult.rows) {
      const name = await cleanDepartment(row.raw_department);
      const existing = deptMap.get(name);
      if (existing) {
        existing.visitCount += parseInt(row.visit_count, 10);
        existing.employeeCount += parseInt(row.employee_count, 10);
      } else {
        deptMap.set(name, {
          name,
          visitCount: parseInt(row.visit_count, 10),
          employeeCount: parseInt(row.employee_count, 10),
        });
      }
    }

    const heatMapPoints: HeatMapPoint[] = heatResult.rows.map((row) => ({
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      count: parseInt(row.count, 10),
      userName: row.user_names || "",
      locationName: row.location_names || "",
      address: row.addresses || "",
      timestamp: row.first_timestamp,
    }));

    const response: RegionalOverviewResponse = {
      start: start as string,
      end: end as string,
      department: (department as string) || undefined,
      totalVisits: parseInt(overviewResult.rows[0].total_visits, 10),
      totalEmployees: parseInt(overviewResult.rows[0].total_employees, 10),
      totalLocations: parseInt(overviewResult.rows[0].total_locations, 10),
      departments: Array.from(deptMap.values()).sort(
        (a, b) => b.visitCount - a.visitCount
      ),
      heatMapPoints,
    };

    res.json(response);
  } catch (err) {
    console.error("Failed to compute regional overview:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /analytics/init-department-aliases
// 扫描 visits 生成部门别名映射表（幂等，可重复执行）
router.post("/init-department-aliases", async (_req: Request, res: Response) => {
  try {
    const result = await initDepartmentAliases();
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("Failed to init department aliases:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /analytics/departments
// 返回所有规范部门名称（供 Dashboard 下拉框使用）
router.get("/departments", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT canonical_name
       FROM department_aliases
       WHERE canonical_name IS NOT NULL AND canonical_name <> ''
       ORDER BY canonical_name`
    );
    const departments = result.rows.map((r) => r.canonical_name);
    res.json(departments);
  } catch (err) {
    console.error("Failed to list departments:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /analytics/department-aliases
// 列出所有部门别名映射
router.get("/department-aliases", async (_req: Request, res: Response) => {
  try {
    const aliases = await listDepartmentAliases();
    res.json(aliases);
  } catch (err) {
    console.error("Failed to list department aliases:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// PUT /analytics/department-aliases
// body: { alias, canonical_name }
router.put("/department-aliases", async (req: Request, res: Response) => {
  const { alias, canonical_name } = req.body;
  if (!alias) {
    res.status(400).json({ error: "Missing alias parameter" });
    return;
  }

  try {
    await updateDepartmentAlias(alias, canonical_name || null);
    res.json({ success: true, alias, canonical_name });
  } catch (err) {
    console.error("Failed to update department alias:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
