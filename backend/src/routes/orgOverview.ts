import { Router, Request, Response } from "express";
import { buildOrgTree, computeOrgOverview } from "../services/orgService";

const router = Router();

// GET /analytics/org-tree
// 返回从 visits.department 解析的组织架构树
router.get("/org-tree", async (_req: Request, res: Response) => {
  try {
    const tree = await buildOrgTree();
    res.json(tree);
  } catch (err) {
    console.error("Failed to build org tree:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /analytics/org-overview?scope=company|department|sub_department&node=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD
// 返回指定组织范围在日期范围内的聚合数据
router.get("/org-overview", async (req: Request, res: Response) => {
  const { scope, node, start, end } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: "Missing start or end parameter" });
    return;
  }

  const validScope = scope === "department" || scope === "sub_department" ? scope : "company";
  const nodeName = typeof node === "string" && node ? node : "__ALL__";

  try {
    const result = await computeOrgOverview(
      validScope,
      nodeName,
      start as string,
      end as string
    );
    res.json(result);
  } catch (err) {
    console.error("Failed to compute org overview:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
