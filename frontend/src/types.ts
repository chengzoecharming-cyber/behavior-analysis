export interface Visit {
  id: number;
  raw_visit_id: number | null;
  user_id: string;
  user_name: string;
  department: string;
  timestamp: string;
  lat: number;
  lng: number;
  location_name: string;
  address: string;
  customer_name: string;
  source: string;
  created_at: string;
  // 扩展字段
  approval_id?: string;
  sequence?: number;
  trip_type?: string;
  vehicle?: string;
  start_odometer?: number;
  end_odometer?: number;
  reported_distance_km?: number;
  cumulative_mileage_km?: number;
  visit_note?: string;
  special_sign_reason?: string;
  photos?: string[];
  geocode_status?: string;
  source_detail?: string;
  approval_status?: string;
  exclude_from_visit_count?: boolean;
  form_version?: string;
  visit_detail?: { comm?: string; issues?: string; ai?: string; accompany?: string; accompany_photo?: string[] } | null;
}

export interface RawVisit {
  id: number;
  raw_user_name: string;
  raw_time: string;
  raw_location: string;
  raw_address: string;
  raw_lat: string;
  raw_lng: string;
  raw_customer_name: string;
  source: string;
  created_at: string;
}

export interface Stop {
  id: number;
  user_id: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  lat: number;
  lng: number;
  location_name: string;
  visit_ids: number[];
  created_at: string;
}

export interface Route {
  id: number;
  user_id: string;
  from_visit_id: number;
  to_visit_id: number;
  distance_km: number;
  duration_min: number;
  polyline: string;
  created_at: string;
}

export interface Anomaly {
  id: number;
  user_id: string;
  type: string;
  description: string;
  anomaly_date?: string;
  start_time: string | null;
  end_time: string | null;
  lat: number | null;
  lng: number | null;
  severity: "low" | "medium" | "high";
  related_visit_ids: number[];
  metadata: Record<string, any>;
  layer?: "fact" | "analyze" | "judge" | null;
  created_at: string;
}

export interface MileageStats {
  user_id: string;
  date?: string;
  start?: string;
  end?: string;
  totalKm: number;
  reportedDistanceKm: number;
  segmentCount: number;
  estimatedFuelCost: number;
}

export interface User {
  user_id: string;
  user_name: string;
  department: string;
  home_address?: string | null;
}

export interface AnomalyWeight {
  id: number;
  rule_key: string;
  rule_name: string;
  weight: number;
  threshold_value: number | null;
  enabled: boolean;
  layer: "fact" | "analyze" | "judge" | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface RiskReason {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  count: number;
  counted_in_score?: boolean;
}

export interface DingTalkSyncLog {
  id: number;
  triggered_by: "scheduler" | "manual" | "startup";
  status: "running" | "success" | "failed";
  start_date: string;
  end_date: string;
  total_instances: number;
  parsed_visits: number;
  parse_failures: number;
  normalized_inserted: number;
  skipped: number;
  raw_visit_count?: number;
  source_approval_ids_hash?: string | null;
  db_approval_ids_hash?: string | null;
  missing_count?: number;
  duplicate_count?: number;
  alert_sent?: boolean;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export type SyncHealthStatus = "healthy" | "warning" | "error";

export interface SyncHealthItem {
  id: number;
  triggeredBy: string;
  status: string;
  startDate: string;
  endDate: string;
  totalInstances: number;
  parsedVisits: number;
  normalizedInserted: number;
  skipped: number;
  parseFailures: number;
  rawVisitCount: number;
  sourceApprovalIdsHash: string | null;
  dbApprovalIdsHash: string | null;
  missingCount: number;
  duplicateCount: number;
  healthStatus: SyncHealthStatus;
  issues: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface SyncAlert {
  id: number;
  triggeredBy: string;
  startDate: string;
  endDate: string;
  totalInstances: number;
  parsedVisits: number;
  normalizedInserted: number;
  skipped: number;
  parseFailures: number;
  rawVisitCount: number;
  missingCount: number;
  duplicateCount: number;
  issues: string[];
  createdAt: string;
  alertSent: boolean;
}

// ============ 客户分析（探迹 CRM，/crm-analytics）============

/** GET /crm-analytics/overview 返回 */
export interface CrmOverview {
  total: number;
  pool_count: number;
  private_count: number;
  /** 按 customer_type 分组计数，key 如 enterprise_domestic / agent_domestic / terminal_overseas / agent_overseas */
  by_type: Record<string, number>;
  unfollowed_count: number;
  unfollowed_ratio: number;
  approving_count: number;
  new_30d_count: number;
  /** CRM 数据快照日期（最近一次手工导入批次时间，YYYY-MM-DD；从未导入为 null） */
  snapshot_date: string | null;
}

export type CrmCrossType = "follow_only" | "visit_only" | "both" | "unmatched";

export interface CrmCrossItem {
  customer_name: string;
  follow_count: number;
  visit_count: number;
  owner_name: string | null;
  /** 是否在 CRM 客户表内（false = 仅出现在拜访记录中） */
  in_crm: boolean;
}

/** GET /crm-analytics/cross 返回 */
export interface CrmCrossResponse {
  only_follow_count: number;
  only_visit_count: number;
  both_count: number;
  /** 归并后仍匹配不上 CRM 客户的 visits 客户名数量（待确认桶，不计入三个分类） */
  unmatched_count: number;
  total: number;
  list: CrmCrossItem[];
}

/** GET /crm-analytics/wordcloud 返回的元素 */
export interface CrmWordCloudItem {
  word: string;
  count: number;
}

export interface CrmOpportunityItem {
  name: string;
  address: string;
  region: string | null;
  follow_status: string | null;
  owner_name: string | null;
  is_in_pool: boolean;
  visit_count: number;
  /** 坐标可能为 null（未解析或解析失败），前端跳过 */
  lat: number | null;
  lng: number | null;
}

/** GET /crm-analytics/opportunity-map 返回 */
export interface CrmOpportunityMapResponse {
  total: number;
  /** 本次请求新解析的坐标条数（后端限流每次最多 30 条，可轮询逐步补全） */
  geocoded_new: number;
  /** 待解析（含可重试的失败记录）数量 */
  pending_count: number;
  /** 解析失败且重试次数用尽（attempts>=5）的数量 */
  failed_count: number;
  list: CrmOpportunityItem[];
}

export type CrmStuckKind = "approval_stuck" | "zombie";

export interface CrmStuckItem {
  kind: CrmStuckKind;
  customer_id: string;
  customer_name: string;
  owner_name: string | null;
  status: string | null;
  /** 卡死/躺尸天数 */
  days: number;
  /** 最近实际拜访时间（ISO，归并匹配口径；无则 null） */
  last_visit_time: string | null;
}

/** GET /crm-analytics/stuck 返回 */
export interface CrmStuckResponse {
  approval_stuck_count: number;
  zombie_count: number;
  total: number;
  list: CrmStuckItem[];
}

/** GET /crm-analytics/recovery-list 返回的明细行 */
export interface CrmRecoveryItem {
  name: string;
  follow_status: string;
  last_owner: string | null;
  owner_name: string | null;
  return_pool_time: string | null;
  return_pool_reason: string | null;
  return_pool_times: number | null;
  latest_follow_up_time: string | null;
  follow_times: number;
  region: string | null;
  channel: string | null;
}

/** GET /crm-analytics/recovery-list 返回（仅 admin 可调） */
export interface CrmRecoveryListResponse {
  total: number;
  /** 按阶段分组计数（不含筛选条件的全量口径），key 为 follow_status */
  summary: Record<string, number>;
  list: CrmRecoveryItem[];
}

export interface CrmPoolHealthRow {
  owner_name: string;
  private_count: number;
  zero_follow_count: number;
  stale_30d_count: number;
  dropped_count: number;
  /** 掉保率 = 历史被掉保数 / (当前私海数 + 历史被掉保数) */
  drop_ratio: number;
}

/** GET /crm-analytics/pool-health 返回 */
export interface CrmPoolHealthResponse {
  company: {
    private_count: number;
    zero_follow_count: number;
    zero_follow_ratio: number;
    stale_30d_count: number;
    stale_30d_ratio: number;
    dropped_count: number;
  };
  rows: CrmPoolHealthRow[];
}

export interface CrmFunnelStage {
  stage: string;
  private_count: number;
  pool_count: number;
}

/** GET /crm-analytics/funnel 返回 */
export interface CrmFunnelResponse {
  stages: CrmFunnelStage[];
  snapshot_date: string | null;
}

// ============ 同客户高频拜访关注（/analytics/customer-visit-frequency） ============

export interface CustomerFreqItem {
  userId: string;
  userName: string;
  department: string | null;
  customerName: string;
  totalCount: number;
  maxWeekCount: number;
  maxMonthCount: number;
  flagged: boolean;
  flagReasons: string[]; // 如 ["2026-08-03 ~ 2026-08-09（4次）", "2026-08 月（7次）"]
}

/** GET /analytics/customer-visit-frequency 返回（仅含 flagged 条目，最多 100 条） */
export interface CustomerVisitFrequencyResponse {
  start: string;
  end: string;
  flaggedCount: number;
  list: CustomerFreqItem[];
}
