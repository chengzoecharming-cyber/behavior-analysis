import { Anomaly } from "../types";
import { getEnabledAnomalyWeights } from "./anomalyWeights";

export interface RiskReason {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  count: number;
  counted_in_score: boolean;
}

export interface RiskScoreResult {
  score: number;
  reasons: RiskReason[];
}

export function getRiskLevel(score: number): "high" | "medium" | "low" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export async function calculateRiskScore(anomalies: Anomaly[]): Promise<RiskScoreResult> {
  const weights = await getEnabledAnomalyWeights();

  // 按异常类型聚合
  const grouped: Record<
    string,
    { count: number; severity: "low" | "medium" | "high"; description: string }
  > = {};

  for (const a of anomalies) {
    const type = a.type || "unknown";
    if (!grouped[type]) {
      grouped[type] = { count: 0, severity: a.severity, description: a.description };
    }
    grouped[type].count += 1;
    // 同一类型有多个时，取最高严重级别
    const severityOrder = { low: 1, medium: 2, high: 3 };
    if (severityOrder[a.severity] > severityOrder[grouped[type].severity]) {
      grouped[type].severity = a.severity;
    }
  }

  let score = 0;
  const reasons: RiskReason[] = [];

  for (const [type, info] of Object.entries(grouped)) {
    const weight = weights[type]?.weight ?? 0.05; // 未配置权重的异常给一个很低的默认权重
    const layer = weights[type]?.layer;
    // 只有判定层（judge）的规则参与风险分计算；事实层/分析层只作为原因展示，不计分
    const countedInScore = layer === "judge";
    if (countedInScore) {
      const typeScore = weight * info.count * 100;
      score += typeScore;
    }
    reasons.push({
      type,
      description: info.description,
      severity: info.severity,
      count: info.count,
      counted_in_score: countedInScore,
    });
  }

  // 基础风险分：无异常时给 5 分，避免完全为 0
  if (score === 0) {
    score = 5;
  }

  return {
    score: Math.min(Math.round(score), 100),
    reasons,
  };
}
