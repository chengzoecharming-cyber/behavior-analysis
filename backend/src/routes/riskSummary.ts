import { Router, Response } from "express";
import { getRiskSummary, getRiskSummaryRange, computeRiskSummaryForDate, persistRiskSummaryCache } from "../services/riskSummaryService";
import { authMiddleware, AuthRequest, requireRole } from "../services/auth";

const router = Router();

// GET /analytics/risk-summary?date=YYYY-MM-DD
// 总览数据源：所有角色均可见全量数据，不做权限收敛
router.get("/risk-summary", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { date } = req.query;
  if (!date) {
    res.status(400).json({ error: "Missing date parameter" });
    return;
  }

  try {
    const result = await getRiskSummary(date as string);
    res.json({
      date: result.date,
      total_employees: result.total_employees,
      high_risk_count: result.high_risk_count,
      medium_risk_count: result.medium_risk_count,
      low_risk_count: result.low_risk_count,
      employees: result.employees,
      from_cache: result.from_cache,
    });
  } catch (err) {
    console.error("Failed to compute risk summary:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /analytics/risk-summary/range?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get("/risk-summary/range", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { start, end } = req.query;
  if (!start || !end) {
    res.status(400).json({ error: "Missing start or end parameter" });
    return;
  }

  try {
    const result = await getRiskSummaryRange(start as string, end as string);
    res.json({
      date: result.date,
      start_date: result.start_date,
      end_date: result.end_date,
      total_employees: result.total_employees,
      high_risk_count: result.high_risk_count,
      medium_risk_count: result.medium_risk_count,
      low_risk_count: result.low_risk_count,
      employees: result.employees,
      from_cache: result.from_cache,
    });
  } catch (err) {
    console.error("Failed to compute risk summary range:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /analytics/risk-summary/refresh?date=YYYY-MM-DD
// 手动刷新某天的缓存（仅 admin）
router.post("/risk-summary/refresh", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  const { date } = req.query;
  if (!date) {
    res.status(400).json({ error: "Missing date parameter" });
    return;
  }

  try {
    const result = await computeRiskSummaryForDate(date as string);
    await persistRiskSummaryCache(date as string);
    res.json({
      date: result.date,
      total_employees: result.total_employees,
      message: "缓存已刷新",
    });
  } catch (err) {
    console.error("Failed to refresh risk summary cache:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
