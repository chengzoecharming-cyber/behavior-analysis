import { Router, Request, Response } from "express";
import { getRiskSummary, computeRiskSummaryForDate, persistRiskSummaryCache } from "../services/riskSummaryService";

const router = Router();

// GET /analytics/risk-summary?date=YYYY-MM-DD
router.get("/risk-summary", async (req: Request, res: Response) => {
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

// POST /analytics/risk-summary/refresh?date=YYYY-MM-DD
// 手动刷新某天的缓存
router.post("/risk-summary/refresh", async (req: Request, res: Response) => {
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
