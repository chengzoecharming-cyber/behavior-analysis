import axios from "axios";
import {
  Visit,
  Stop,
  Route,
  Anomaly,
  MileageStats,
  User,
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

export async function fetchStops(userId: string, date: string): Promise<Stop[]> {
  const res = await api.get("/stops", {
    params: { user: userId, date },
  });
  return res.data;
}

export async function fetchRoutes(
  userId: string,
  date: string
): Promise<Route[]> {
  const res = await api.get("/routes", {
    params: { user: userId, date },
  });
  return res.data;
}

export async function fetchMileage(
  userId: string,
  date: string
): Promise<MileageStats> {
  const res = await api.get("/analytics/mileage", {
    params: { user: userId, date },
  });
  return res.data;
}

export async function fetchAnomalies(
  userId: string,
  date: string
): Promise<Anomaly[]> {
  const res = await api.get("/analytics/anomaly", {
    params: { user: userId, date },
  });
  return res.data;
}

export interface PreviewRow {
  user_name: string;
  time: string;
  location_name: string;
  address: string;
  lat: number;
  lng: number;
  customer_name: string;
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

export async function uploadExcel(file: File): Promise<{
  success: boolean;
  rawInserted: number;
  normalizedInserted: number;
  totalDistanceKm: number;
  geocodeFailures?: number;
  geocodeFailureSamples?: string[];
}> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await api.post("/upload-excel", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
}
