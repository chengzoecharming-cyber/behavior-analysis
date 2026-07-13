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
  visit_note?: string;
  special_sign_reason?: string;
  photos?: string[];
  geocode_status?: string;
  source_detail?: string;
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
}

export interface AnomalyWeight {
  id: number;
  rule_key: string;
  rule_name: string;
  weight: number;
  threshold_value: number | null;
  enabled: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
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
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}
