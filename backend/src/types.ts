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
  created_at: Date;
}

export interface Visit {
  id: number;
  raw_visit_id: number | null;
  user_id: string;
  user_name: string;
  department: string;
  timestamp: Date;
  lat: number | null;
  lng: number | null;
  location_name: string;
  address: string;
  customer_name: string;
  source: string;
  created_at: Date;
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
  geocode_status?: string;
  source_detail?: string;
  business_date?: string;
}

export interface Stop {
  id: number;
  user_id: string;
  start_time: Date;
  end_time: Date;
  duration_minutes: number;
  lat: number;
  lng: number;
  location_name: string;
  visit_ids: number[];
  business_date?: string;
  created_at: Date;
}

export interface Route {
  id: number;
  user_id: string;
  from_visit_id: number;
  to_visit_id: number;
  distance_km: number;
  duration_min: number;
  polyline: string;
  business_date?: string;
  created_at: Date;
}

export interface Anomaly {
  id: number;
  user_id: string;
  type: "long_stop" | "long_idle" | "route_detour" | string;
  description: string;
  start_time: Date | null;
  end_time: Date | null;
  lat: number | null;
  lng: number | null;
  severity: "low" | "medium" | "high";
  related_visit_ids: number[];
  metadata: Record<string, any>;
  created_at: Date;
}

export interface RawVisitRow {
  user_name: string;
  time: string | number | Date;
  location_name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  customer_name: string;
}

export interface ParsedVisit {
  user_id: string;
  user_name: string;
  department: string;
  time: string;
  location_name: string;
  address: string;
  customer_name: string;
  lat: number | null;
  lng: number | null;
  approval_id?: string;
  sequence?: number;
  trip_type?: string;
  vehicle?: string;
  start_odometer?: number;
  end_odometer?: number;
  reported_distance_km?: number;
  visit_note?: string;
  special_sign_reason?: string;
  sign_count?: number;
  continues_to_next?: boolean;
  source_detail?: string;
}

export interface User {
  id: number;
  user_id: string;
  user_name: string;
  department: string | null;
  role: "admin" | "manager" | "staff";
  manager_id: number | null;
  is_resigned: boolean;
  created_at: Date;
}

export interface Feedback {
  id: number;
  user_id: string;
  start_date: Date;
  end_date: Date;
  description: string | null;
  status: "pending" | "approved" | "denied";
  reviewer_id: string | null;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AnomalyException {
  id: number;
  user_id: string;
  start_date: Date;
  end_date: Date;
  feedback_id: number | null;
  created_at: Date;
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
  started_at: Date;
  finished_at: Date | null;
}
