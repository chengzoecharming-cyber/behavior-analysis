import { pool } from "../db";
import { Visit, Stop } from "../types";
import { haversineDistance } from "./distance";

const STOP_DISTANCE_METERS = 150;
const STOP_DURATION_MINUTES = 10;

export function detectStops(visits: Visit[]): Stop[] {
  // 只使用有有效坐标的拜访点计算停留点
  const validVisits = visits.filter(
    (v) => v.lat != null && v.lng != null
  );
  if (validVisits.length === 0) return [];

  const sorted = [...validVisits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const stops: Stop[] = [];
  let currentGroup: Visit[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const visit = sorted[i];
    const anchor = currentGroup[0];
    const distance = haversineDistance(
      anchor.lat!,
      anchor.lng!,
      visit.lat!,
      visit.lng!
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

/**
 * 计算并持久化某员工某业务日期的停留点（先删后插，事务内执行）。
 * 同步后重算与控制台单日视图共用——此前 stops 只在有人打开控制台单日
 * 视图时才计算，导致自动链路的停留类异常检测系统性漏检。
 */
export async function computeAndPersistStops(
  userId: string,
  businessDate: string
): Promise<Stop[]> {
  const visitsResult = await pool.query(
    `SELECT * FROM visits
     WHERE user_id = $1 AND business_date = $2::date
     ORDER BY timestamp ASC`,
    [userId, businessDate]
  );

  const visits: Visit[] = visitsResult.rows;
  const stops = detectStops(visits);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM stops WHERE user_id = $1 AND business_date = $2::date`,
      [userId, businessDate]
    );

    const persisted: Stop[] = [];
    for (const stop of stops) {
      const r = await client.query(
        `INSERT INTO stops
         (user_id, start_time, end_time, duration_minutes, lat, lng, location_name, visit_ids, business_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          stop.user_id,
          stop.start_time,
          stop.end_time,
          stop.duration_minutes,
          stop.lat,
          stop.lng,
          stop.location_name,
          stop.visit_ids,
          stop.business_date ?? businessDate,
        ]
      );
      persisted.push(r.rows[0]);
    }
    await client.query("COMMIT");
    return persisted;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    lat: start.lat!,
    lng: start.lng!,
    location_name: start.location_name,
    visit_ids: group.map((v) => v.id),
    business_date: start.business_date,
    created_at: new Date(),
  };
}
