import { Router, Request, Response } from "express";
import { Route } from "../types";
import { computeAndPersistRoutes } from "../services/routeService";

const router = Router();

function eachDate(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const parse = (s: string) => {
    const datePart = s.slice(0, 10); // 兼容 "YYYY-MM-DDTHH:mm:ss"
    const [y, m, d] = datePart.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

router.get("/", async (req: Request, res: Response) => {
  const { user, date, start, end } = req.query;

  if (!user) {
    res.status(400).json({ error: "Missing user parameter" });
    return;
  }

  try {
    // 范围模式：按天分别计算 route，避免跨天连线
    if (start && end) {
      const dates = eachDate(start as string, end as string);
      const allRoutes: Route[] = [];
      for (const d of dates) {
        const dayStart = `${d}T00:00:00+08:00`;
        const dayEnd = `${d}T23:59:59+08:00`;
        const routes = await computeAndPersistRoutes(
          user as string,
          dayStart,
          dayEnd
        );
        allRoutes.push(...routes);
      }
      res.json(allRoutes);
      return;
    }

    if (!date) {
      res.status(400).json({ error: "Missing date or start/end parameter" });
      return;
    }

    const dayStart = `${date}T00:00:00+08:00`;
    const dayEnd = `${date}T23:59:59+08:00`;

    const routes: Route[] = await computeAndPersistRoutes(
      user as string,
      dayStart,
      dayEnd
    );
    res.json(routes);
  } catch (err) {
    console.error("Failed to fetch routes:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
