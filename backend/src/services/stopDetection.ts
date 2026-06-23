import { Visit, Stop } from "../types";
import { haversineDistance } from "./distance";

const STOP_DISTANCE_METERS = 150;
const STOP_DURATION_MINUTES = 10;

export function detectStops(visits: Visit[]): Stop[] {
  if (visits.length === 0) return [];

  const sorted = [...visits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const stops: Stop[] = [];
  let currentGroup: Visit[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const visit = sorted[i];
    const anchor = currentGroup[0];
    const distance = haversineDistance(
      anchor.lat,
      anchor.lng,
      visit.lat,
      visit.lng
    );

    if (distance * 1000 <= STOP_DISTANCE_METERS) {
      currentGroup.push(visit);
    } else {
      const stop = buildStop(currentGroup);
      if (stop) stops.push(stop);
      currentGroup = [visit];
    }
  }

  const lastStop = buildStop(currentGroup);
  if (lastStop) stops.push(lastStop);

  return stops;
}

function buildStop(group: Visit[]): Stop | null {
  if (group.length < 2) return null;
  const start = group[0];
  const end = group[group.length - 1];
  const durationMs =
    new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime();
  const durationMinutes = Math.round(durationMs / (1000 * 60));

  if (durationMinutes < STOP_DURATION_MINUTES) return null;

  return {
    id: 0,
    user_id: start.user_id,
    start_time: start.timestamp,
    end_time: end.timestamp,
    duration_minutes: durationMinutes,
    lat: start.lat,
    lng: start.lng,
    location_name: start.location_name,
    visit_ids: group.map((v) => v.id),
    created_at: new Date(),
  };
}
