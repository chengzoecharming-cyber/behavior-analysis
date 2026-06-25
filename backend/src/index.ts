import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initDB } from "./db";
import visitsRouter from "./routes/visits";
import stopsRouter from "./routes/stops";
import routesRouter from "./routes/routes";
import uploadRouter from "./routes/upload";
import analyticsRouter from "./routes/analytics";
import riskSummaryRouter from "./routes/riskSummary";
import { startRiskSummaryCacheScheduler } from "./services/scheduler";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/visits", visitsRouter);
app.use("/stops", stopsRouter);
app.use("/routes", routesRouter);
app.use("/upload-excel", uploadRouter);
app.use("/analytics", analyticsRouter);
app.use("/analytics", riskSummaryRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function main() {
  await initDB();
  startRiskSummaryCacheScheduler();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
