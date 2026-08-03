import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initDB } from "./db";
import visitsRouter from "./routes/visits";
import stopsRouter from "./routes/stops";
import routesRouter from "./routes/routes";
import uploadRouter from "./routes/upload";
import analyticsRouter from "./routes/analytics";
import regionalOverviewRouter from "./routes/regionalOverview";
import orgOverviewRouter from "./routes/orgOverview";
import riskSummaryRouter from "./routes/riskSummary";
import dingtalkRouter from "./routes/dingtalk";
import usersRouter from "./routes/users";
import feedbackRouter from "./routes/feedback";
import authRouter from "./routes/auth";
import exportRouter from "./routes/export";
import dataLineageRouter from "./routes/dataLineage";
import {
  startRiskSummaryCacheScheduler,
  startDingTalkSyncScheduler,
  startReportGenerationScheduler,
  startUserReconcileScheduler,
} from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/visits", visitsRouter);
app.use("/stops", stopsRouter);
app.use("/routes", routesRouter);
app.use("/upload-excel", uploadRouter);
app.use("/analytics", analyticsRouter);
app.use("/analytics", regionalOverviewRouter);
app.use("/analytics", orgOverviewRouter);
app.use("/analytics", riskSummaryRouter);
app.use("/dingtalk", dingtalkRouter);
app.use("/users", usersRouter);
app.use("/feedback", feedbackRouter);
app.use("/auth", authRouter);
app.use("/export", exportRouter);
app.use("/data-lineage", dataLineageRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function main() {
  await initDB();
  // 定时任务开关：默认开启；本地开发建议 SCHEDULER_ENABLED=false，
  // 避免与线上实例重复执行（如日报生成两份钉钉文档）
  if (process.env.SCHEDULER_ENABLED !== "false") {
    startRiskSummaryCacheScheduler();
    const syncCatchup = startDingTalkSyncScheduler();
    // 报告生成依赖同步落库的数据（里程读 routes 表）。
    // 启动补跑必须排在同步补全之后，否则并发启动时报告会读到空/半成品数据
    //（2026-08-03 事故：数据库恢复后两个 catchup 并发，日报里程全 0）。
    if (syncCatchup) {
      syncCatchup.finally(() => startReportGenerationScheduler());
    } else {
      startReportGenerationScheduler();
    }
    startUserReconcileScheduler();
  } else {
    console.log("[Scheduler] SCHEDULER_ENABLED=false，跳过所有定时任务");
  }
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
