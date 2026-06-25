import axios from "axios";
import {
  Visit,
  Stop,
  Route,
  Anomaly,
  MileageStats,
  User,
  AnomalyWeight,
} from "./types";

const api = axios.create({
  baseURL: "/api",
});

export async function fetchUsers(): Promise<User[]> {
  const res = await api.get("/visits/users");
  return res.data;
}

export async function fetchAvailableDates(userId: string): Promise<string[]> {
  const res = await api.get("/visits/available-dates", {
    params: { user: userId },
  });
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
  totalDistanceKm: number;
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
  totalDistanceKm: number;
  geocodeFailures: { row: number; location: string; user: string }[];
  error?: string;
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
