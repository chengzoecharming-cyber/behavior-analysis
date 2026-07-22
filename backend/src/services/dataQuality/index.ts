import { initDataQualitySchema } from "./schema";
import {
  recordQualityRecord,
  recordQualitySummary,
  checkVisitQuality,
  persistVisitQualityFailures,
  getUnresolvedQualityRecords,
} from "./assertions";
import {
  runReconciliationChecks,
  getReconciliationChecks,
  isSyncReconciliationPassed,
  hashIdList,
} from "./reconciliation";
import {
  runMetricBaselineChecks,
  getMetricHistory,
  updateMetricBaseline,
  buildDailyHealthSummary,
} from "./metricBaselines";
import {
  enqueueDownstreamComputations,
  runPendingComputations,
  getComputationQueue,
  getLineage,
  refreshTableAndDownstream,
} from "./lineage";
import {
  sendDataQualityAlert,
  buildReconciliationAlert,
  buildImportQualityAlert,
  buildDailyHealthAlert,
  buildComputationFailedAlert,
} from "./alerts";

export const DataQuality = {
  // schema
  initDataQualitySchema,

  // assertions
  recordQualityRecord,
  recordQualitySummary,
  checkVisitQuality,
  persistVisitQualityFailures,
  getUnresolvedQualityRecords,

  // reconciliation
  runReconciliationChecks,
  getReconciliationChecks,
  isSyncReconciliationPassed,
  hashIdList,

  // metric baselines
  runMetricBaselineChecks,
  getMetricHistory,
  updateMetricBaseline,
  buildDailyHealthSummary,

  // lineage
  enqueueDownstreamComputations,
  runPendingComputations,
  getComputationQueue,
  getLineage,
  refreshTableAndDownstream,

  // alerts
  sendDataQualityAlert,
  buildReconciliationAlert,
  buildImportQualityAlert,
  buildDailyHealthAlert,
  buildComputationFailedAlert,
};

export default DataQuality;

// 类型再导出
export type { QualityRecordInput, QualitySummaryInput, Severity, CheckType } from "./assertions";
export type { ReconciliationContext, ReconciliationCheckInput } from "./reconciliation";
export type { MetricCheckResult } from "./metricBaselines";
export type { DataQualityAlert } from "./alerts";
