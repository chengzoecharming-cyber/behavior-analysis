import { pool } from "../db";

export interface AnomalyWeight {
  id: number;
  rule_key: string;
  rule_name: string;
  weight: number;
  threshold_value: number | null;
  enabled: boolean;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getAnomalyWeights(): Promise<Record<string, AnomalyWeight>> {
  const result = await pool.query<AnomalyWeight>("SELECT * FROM anomaly_weights ORDER BY rule_key");
  const map: Record<string, AnomalyWeight> = {};
  for (const row of result.rows) {
    map[row.rule_key] = row;
  }
  return map;
}

export async function getEnabledAnomalyWeights(): Promise<Record<string, AnomalyWeight>> {
  const all = await getAnomalyWeights();
  const enabled: Record<string, AnomalyWeight> = {};
  for (const [key, config] of Object.entries(all)) {
    if (config.enabled) {
      enabled[key] = config;
    }
  }
  return enabled;
}

export async function updateAnomalyWeight(
  ruleKey: string,
  updates: Partial<Pick<AnomalyWeight, "weight" | "threshold_value" | "enabled" | "rule_name" | "description">>
): Promise<AnomalyWeight | null> {
  const result = await pool.query<AnomalyWeight>(
    `UPDATE anomaly_weights
     SET weight = COALESCE($1, weight),
         threshold_value = COALESCE($2, threshold_value),
         enabled = COALESCE($3, enabled),
         rule_name = COALESCE($4, rule_name),
         description = COALESCE($5, description),
         updated_at = NOW()
     WHERE rule_key = $6
     RETURNING *`,
    [updates.weight, updates.threshold_value, updates.enabled, updates.rule_name, updates.description, ruleKey]
  );
  return result.rows[0] || null;
}

export async function resetAnomalyWeights(): Promise<void> {
  await pool.query(`
    INSERT INTO anomaly_weights (rule_key, rule_name, weight, threshold_value, enabled, description)
    VALUES
      ('low_visit_count', '拜访量不足', 0.25, 15, true, '过去5个工作日累计签到次数<15次'),
      ('duplicate_location', '重复签到', 0.20, 7, true, '过去两周同一地点重复签到>=7次'),
      ('mileage_deviation', '里程偏差', 0.20, 0.30, true, '填报里程 vs 高德里程偏差>30%'),
      ('long_stop', '停留过长', 0.15, 120, true, '停留>120分钟'),
      ('route_detour', '路径绕行', 0.10, 2.0, true, '实际距离>直线距离*2'),
      ('long_idle', '长时间未移动', 0.05, 180, true, '>180分钟无移动记录'),
      ('invalid_trip_type', '异常出行方式', 0.03, 5, true, '公共交通/特殊签到但填报较长里程'),
      ('missing_special_reason', '特殊签到缺原因', 0.02, NULL, true, '特殊签到未填写原因')
    ON CONFLICT (rule_key) DO UPDATE SET
      rule_name = EXCLUDED.rule_name,
      weight = EXCLUDED.weight,
      threshold_value = EXCLUDED.threshold_value,
      enabled = EXCLUDED.enabled,
      description = EXCLUDED.description,
      updated_at = NOW();
  `);
}
