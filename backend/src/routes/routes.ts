import { Router, Request, Response } from "express";
import { Route } from "../types";
import { computeAndPersistRoutes } from "../services/routeService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const { user, date } = req.query;

  if (!user || !date) {
    res.status(400).json({ error: "Missing user or date parameter" });
    return;
  }

  const start = `${date}T00:00:00+08:00`;
  const end = `${date}T23:59:59+08:00`;

  try {
    const routes: Route[] = await computeAndPersistRoutes(
      user as string,
      start,
      end
    );
    res.json(routes);
  } catch (err) {
    console.error("Failed to fetch routes:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
