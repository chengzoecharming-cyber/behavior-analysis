import axios from "axios";
import {
  Visit,
  Stop,
  Route,
  Anomaly,
  MileageStats,
  User,
  AnomalyWeight,
  DingTalkSyncLog,
  SyncHealthItem,
  SyncAlert,
} from "./types";

const api = axios.create({
  baseURL: "/api",
});

api.interceptors.request.use((config) => {
  const userId = localStorage.getItem("user_id");
  if (userId) {
    // HTTP header 必须 ASCII，对中文 user_id 做 URL 编码
    config.headers["X-User-Id"] = encodeURIComponent(userId);
  }
  return config;
});

export async function fetchUsers(): Promise<User[]> {
  const res = await api.get("/visits/users");
  return res.data;
}

export interface AvailableDate {
  date: string;
  has_anomaly: boolean;
}

export async function fetchAvailableDates(
  options:
    | { userId: string; scope?: never; node?: never }
    | { userId?: never; scope: "company" | "department" | "sub_department"; node?: string },
  withAnomaly = false
): Promise<AvailableDate[]> {
  const params: Record<string, any> = { with_anomaly: withAnomaly };
  if (options.userId) {
    params.user = options.userId;
  } else {
    params.scope = options.scope;
    if (options.node) params.node = options.node;
  }
  const res = await api.get("/visits/available-dates", { params });
  // 兼容旧版返回字符串数组
  if (Array.isArray(res.data) && typeof res.data[0] === "string") {
    return res.data.map((d: string) => ({ date: d, has_anomaly: false }));
  }
  return res.data;
}

export async function fetchVisits(
  userId: string,
  start: string,
  end: string
): Promise<Visit[]> {
  const res = await api.get("/visits", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export async function fetchStops(
  userId: string,
  start: string,
  end: string
): Promise<Stop[]> {
  const res = await api.get("/stops", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export async function fetchRoutes(
  userId: string,
  start: string,
  end: string
): Promise<Route[]> {
  const res = await api.get("/routes", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export async function fetchMileage(
  userId: string,
  start: string,
  end: string
): Promise<MileageStats> {
  const res = await api.get("/analytics/mileage", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export interface DailyOverview {
  date: string;
  visit_count: number;
  stop_minutes: number;
  reported_distance_km: number;
  estimated_distance_km: number;
  anomaly_count: number;
  has_mileage_reading_invalid?: boolean;
}

export interface UserOverviewAnomaly {
  id: number;
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  anomaly_date: string;
  metadata: Record<string, any>;
}

export interface UserOverviewResult {
  user_id: string;
  start: string;
  end: string;
  totals: {
    visit_count: number;
    stop_minutes: number;
    reported_distance_km: number;
    estimated_distance_km: number;
    anomaly_count: number;
  };
  daily: DailyOverview[];
  anomalies: UserOverviewAnomaly[];
}

export async function fetchUserOverview(
  userId: string,
  start: string,
  end: string
): Promise<UserOverviewResult> {
  const res = await api.get("/analytics/user-overview", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export async function fetchAnomalies(
  userId: string,
  start: string,
  end: string
): Promise<Anomaly[]> {
  const res = await api.get("/analytics/anomaly", {
    params: { user: userId, start, end },
  });
  return res.data;
}

export interface RiskReason {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  count: number;
}

export interface EmployeeRiskSummary {
  user_id: string;
  user_name: string;
  department: string;
  risk_score: number;
  risk_level: "high" | "medium" | "low";
  anomaly_count: number;
  high_anomaly_count: number;
  medium_anomaly_count: number;
  low_anomaly_count: number;
  visit_count: number;
  total_stop_minutes: number;
  total_distance_km: number;
  risk_reasons: RiskReason[];
  summary_text: string;
}

export interface RiskSummaryResponse {
  date: string;
  start_date?: string;
  end_date?: string;
  total_employees: number;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  employees: EmployeeRiskSummary[];
  from_cache?: boolean;
}

export async function fetchRiskSummary(date: string): Promise<RiskSummaryResponse> {
  const res = await api.get("/analytics/risk-summary", {
    params: { date },
  });
  return res.data;
}

export async function fetchRiskSummaryRange(
  start: string,
  end: string
): Promise<RiskSummaryResponse> {
  const res = await api.get("/analytics/risk-summary/range", {
    params: { start, end },
  });
  return res.data;
}

export interface RegionalOverviewResponse {
  start: string;
  end: string;
  department?: string;
  totalVisits: number;
  totalEmployees: number;
  totalLocations: number;
  departments: {
    name: string;
    key: string;
    visitCount: number;
    employeeCount: number;
  }[];
  heatMapPoints: {
    lat: number;
    lng: number;
    count: number;
    userName: string;
    locationName: string;
    address: string;
    timestamp: string;
  }[];
}

export interface OrgTreeNode {
  name: string;
  shortName: string;
  level: number;
  children: OrgTreeNode[];
  userIds?: string[];
}

export interface OrgRankingItem {
  key: string;
  name: string;
  level: "department" | "sub_department" | "person";
  visitCount: number;
  employeeCount: number;
  reportedKm: number;
  estimatedKm: number;
  stopMinutes: number;
  anomalyCount: number;
  /** 该节点是否还有可展开的下一级 */
  hasChildren: boolean;
  /** 风险命中标记（只要下级有命中即 true） */
  hasLowVisitCount: boolean;
  hasDuplicateLocation: boolean;
  hasMileageDeviation: boolean;
  hasMileageReadingInvalid: boolean;
}

export interface OrgTrendItem {
  date: string;
  visitCount: number;
  reportedKm: number;
  estimatedKm: number;
  stopMinutes: number;
  anomalyCount: number;
}

export interface CompanyDashboardSummary {
  totalVisits: number;
  activeEmployees: number;
  customerCoverage: number;
  avgVisitFrequency: number;
}

export interface WeeklyTrendItem {
  week: string;
  weekStart: string;
  weekEnd: string;
  visitCount: number;
  avgVisitsPerEmployee: number;
  reportedKm: number;
  estimatedKm: number;
  activeEmployees: number;
}

export interface WordCloudEmployee {
  userId: string;
  userName: string;
  department: string;
  visitCount: number;
  anomalyCount: number;
}

export interface DepartmentRadarItem {
  department: string;
  avgVisitsPerEmployee: number;
  avgCustomerCoverage: number;
  avgEstimatedKm: number;
}

export interface CompanyDashboardResponse {
  start: string;
  end: string;
  summary: CompanyDashboardSummary;
  weeklyTrend: WeeklyTrendItem[];
  employeeWordCloud: WordCloudEmployee[];
  departmentRadar: DepartmentRadarItem[];
}

export interface OrgOverviewResponse {
  scope: "company" | "department" | "sub_department";
  node: string;
  start: string;
  end: string;
  stats: {
    totalVisits: number;
    totalEmployees: number;
    totalLocations: number;
    totalCustomers: number;
    totalReportedKm: number;
    totalEstimatedKm: number;
    totalStopMinutes: number;
    totalAnomalies: number;
  };
  ranking: OrgRankingItem[];
  trend: OrgTrendItem[];
  heatMapPoints: {
    lat: number;
    lng: number;
    count: number;
    userName: string;
    locationName: string;
    address: string;
    timestamp: string;
  }[];
  provinceDistribution: { name: string; count: number }[];
}

export async function fetchRegionalOverview(
  start: string,
  end: string,
  department?: string
): Promise<RegionalOverviewResponse> {
  const res = await api.get("/analytics/regional-overview", {
    params: { start, end, department: department && department !== "all" ? department : undefined },
  });
  return res.data;
}

export async function fetchOrgTree(): Promise<OrgTreeNode[]> {
  const res = await api.get("/analytics/org-tree");
  return res.data;
}

export async function fetchDingTalkOrgTree(): Promise<OrgTreeNode[]> {
  const res = await api.get("/dingtalk/org-tree");
  return res.data.tree || [];
}

export async function fetchDingTalkOrgUsers(): Promise<User[]> {
  const res = await api.get("/dingtalk/users");
  return res.data.users || [];
}

export async function fetchCompanyDashboard(
  start: string,
  end: string
): Promise<CompanyDashboardResponse> {
  const res = await api.get("/analytics/company-dashboard", {
    params: { start, end },
  });
  return res.data;
}

export async function fetchOrgOverview(
  scope: "company" | "department" | "sub_department",
  node: string,
  start: string,
  end: string
): Promise<OrgOverviewResponse> {
  const res = await api.get("/analytics/org-overview", {
    params: { scope, node, start, end },
  });
  return res.data;
}

export async function fetchDepartments(): Promise<string[]> {
  const res = await api.get("/analytics/departments");
  return res.data;
}

export async function fetchAnomalyWeights(): Promise<AnomalyWeight[]> {
  const res = await api.get("/analytics/anomaly-weights");
  return res.data;
}

export async function updateAnomalyWeight(
  ruleKey: string,
  updates: Partial<Pick<AnomalyWeight, "weight" | "threshold_value" | "enabled" | "rule_name" | "description">>
): Promise<AnomalyWeight> {
  const res = await api.put(`/analytics/anomaly-weights/${ruleKey}`, updates);
  return res.data;
}

export interface PreviewRow {
  user_name: string;
  time: string;
  location_name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  customer_name: string;
  approval_id?: string;
  sequence?: number;
  trip_type?: string;
  vehicle?: string;
  start_odometer?: number;
  end_odometer?: number;
  reported_distance_km?: number;
  visit_note?: string;
}

export async function previewExcel(file: File): Promise<{
  success: boolean;
  preview: PreviewRow[];
  isDingTalk: boolean;
}> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await api.post("/upload-excel?preview=true", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
}

export interface GeocodeFailure {
  row: number;
  location: string;
  user: string;
}

export async function uploadExcel(file: File): Promise<{
  success: boolean;
  rawInserted: number;
  normalizedInserted: number;
  geocodeFailures?: GeocodeFailure[];
  geocodeFailureSamples?: GeocodeFailure[];
}> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await api.post("/upload-excel", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
}

export interface DingTalkStatus {
  configured: boolean;
  appKey: string | null;
  processCode: string | null;
  tokenValid: boolean;
  tokenError: string | null;
}

export interface DingTalkSyncResult {
  success: boolean;
  startDate: string;
  endDate: string;
  totalInstances: number;
  parsedVisits: number;
  parseFailures: number;
  rawInserted: number;
  normalizedInserted: number;
  skipped: number;
  geocodeFailures: { row: number; location: string; user: string }[];
  error?: string;
}

export interface DingTalkSyncLogsResponse {
  success: boolean;
  limit: number;
  logs: DingTalkSyncLog[];
}

export interface AuthUser {
  id: number;
  user_id: string;
  user_name: string;
  department: string | null;
  role: "admin" | "manager" | "staff";
  manager_id: number | null;
  is_resigned: boolean;
  created_at: string;
}

export interface FeedbackItem {
  id: number;
  user_id: string;
  start_date: string;
  end_date: string;
  description: string;
  status: "pending" | "approved" | "denied";
  reviewer_id: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  submitter_name?: string;
}

export async function fetchCurrentUser(): Promise<AuthUser> {
  const res = await api.get("/users/me");
  return res.data;
}

export async function login(
  username: string,
  password: string
): Promise<Pick<AuthUser, "user_id" | "user_name" | "department" | "role">> {
  const res = await api.post("/auth/login", { username, password });
  return res.data;
}

export async function fetchAuthUsers(): Promise<AuthUser[]> {
  const res = await api.get("/users/switchable");
  return res.data;
}

export async function createFeedback(payload: {
  start_date: string;
  end_date: string;
  description: string;
}): Promise<FeedbackItem> {
  const res = await api.post("/feedback", payload);
  return res.data;
}

export async function fetchFeedbackList(): Promise<FeedbackItem[]> {
  const res = await api.get("/feedback");
  return res.data;
}

export async function reviewFeedback(
  id: number,
  payload: { status: "approved" | "denied"; review_note?: string }
): Promise<FeedbackItem> {
  const res = await api.put(`/feedback/${id}/review`, payload);
  return res.data;
}

export async function fetchDingTalkStatus(): Promise<DingTalkStatus> {
  const res = await api.get("/dingtalk/status");
  return res.data;
}

export async function testDingTalkConnection(): Promise<any> {
  const res = await api.get("/dingtalk/test");
  return res.data;
}

export async function syncDingTalk(
  startDate: string,
  endDate: string
): Promise<DingTalkSyncResult> {
  const res = await api.post("/dingtalk/sync", { startDate, endDate });
  return res.data;
}

export async function fetchSyncLogs(limit = 50): Promise<DingTalkSyncLogsResponse> {
  const res = await api.get("/dingtalk/sync-logs", { params: { limit } });
  return res.data;
}

export async function retrySyncLog(id: number): Promise<DingTalkSyncResult> {
  const res = await api.post(`/dingtalk/sync-logs/${id}/retry`);
  return res.data;
}

export interface SyncHealthResponse {
  success: boolean;
  limit: number;
  items: SyncHealthItem[];
}

export interface SyncAlertsResponse {
  success: boolean;
  acknowledged: boolean;
  alerts: SyncAlert[];
}

export async function fetchSyncHealth(limit = 7): Promise<SyncHealthResponse> {
  const res = await api.get("/dingtalk/sync-health", { params: { limit } });
  return res.data;
}

export async function fetchSyncAlerts(acknowledged = false): Promise<SyncAlertsResponse> {
  const res = await api.get("/dingtalk/sync-alerts", { params: { acknowledged } });
  return res.data;
}

export async function ackSyncAlert(id: number): Promise<{ success: boolean; id: number }> {
  const res = await api.post(`/dingtalk/sync-alerts/${id}/ack`);
  return res.data;
}

export async function forceSyncDateRange(
  startDate: string,
  endDate: string
): Promise<DingTalkSyncResult> {
  const res = await api.post("/dingtalk/sync-force", { startDate, endDate });
  return res.data;
}

export interface HeatMapPoint {
  lat: number;
  lng: number;
  count: number;
}

export interface ExportConsoleReportPayload {
  scope?: "company" | "department" | "sub_department" | "person";
  node?: string;
  userId?: string;
  start: string;
  end: string;
  amapKey: string;
  points: HeatMapPoint[];
}

export interface ExportConsoleReportResult {
  success: boolean;
  message: string;
}

export async function exportConsoleReport(
  payload: ExportConsoleReportPayload
): Promise<ExportConsoleReportResult> {
  const res = await api.post("/export/console-report", payload);
  return res.data;
}

export interface ExportConsoleReportToDocPayload {
  userId: string;
  start: string;
  end: string;
}

export interface ExportConsoleReportToDocResult {
  success: boolean;
  message: string;
  url: string;
  docKey: string;
  nodeId: string;
  workspaceId: string;
  reportType: "日报" | "周报" | "月报";
  reportDate: string;
}

export async function exportConsoleReportToDoc(
  payload: ExportConsoleReportToDocPayload
): Promise<ExportConsoleReportToDocResult> {
  const res = await api.post("/export/console-report-to-doc", payload);
  return res.data;
}

export interface ExportScopeReportToDocPayload {
  scope: "company" | "department" | "sub_department" | "person";
  node?: string;
  userId?: string;
  start: string;
  end: string;
}

export interface ExportScopeReportToDocResult {
  success: boolean;
  message: string;
  url: string;
  docKey: string;
  nodeId: string;
  scope: string;
  reportType: "日报" | "周报" | "月报";
  hasData: boolean;
}

export async function exportScopeReportToDoc(
  payload: ExportScopeReportToDocPayload
): Promise<ExportScopeReportToDocResult> {
  const res = await api.post("/export/scope-report-to-doc", payload);
  return res.data;
}
