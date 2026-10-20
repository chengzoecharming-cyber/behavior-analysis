import type { CSSProperties } from "react";

/**
 * KPI 指标条共享样式（标签/数字字号层级）。
 * ConsolePage 与 OrgQueryPanel 复用；DecisionPage 保持自有副本不动，避免牵连。
 */
export const statLabelStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--text-tertiary)",
  fontWeight: 500,
};

export const statValueStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  color: "var(--text-primary)",
};
