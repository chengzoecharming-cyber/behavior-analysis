import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initDB(): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query(`
      -- RAW 层：原始数据，完全保留导入来源
      CREATE TABLE IF NOT EXISTS raw_visits (
        id SERIAL PRIMARY KEY,
        raw_user_name VARCHAR(128),
        raw_time TEXT,
        raw_location TEXT,
        raw_address TEXT,
        raw_lat TEXT,
        raw_lng TEXT,
        raw_customer_name VARCHAR(255),
        source VARCHAR(64) DEFAULT 'excel',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- NORMALIZED 层：标准化后的核心数据
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        raw_visit_id INTEGER REFERENCES raw_visits(id) ON DELETE SET NULL,
        user_id VARCHAR(64) NOT NULL,
        user_name VARCHAR(128) NOT NULL,
        department VARCHAR(128),
        timestamp TIMESTAMPTZ NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        location_name VARCHAR(255),
        address TEXT,
        customer_name VARCHAR(255),
        source VARCHAR(64) DEFAULT 'excel',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_visits_user_time
        ON visits(user_id, timestamp);

      -- DERIVED 层：停留分析
      CREATE TABLE IF NOT EXISTS stops (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        duration_minutes INTEGER NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        location_name VARCHAR(255),
        visit_ids INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_stops_user
        ON stops(user_id, start_time);

      -- DERIVED 层：路径/segment 分析
      CREATE TABLE IF NOT EXISTS routes (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        from_visit_id INTEGER NOT NULL,
        to_visit_id INTEGER NOT NULL,
        distance_km DOUBLE PRECISION NOT NULL,
        duration_min INTEGER,
        polyline TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_routes_user
        ON routes(user_id, from_visit_id, to_visit_id);

      -- DERIVED 层：异常事件（P1 基础版可持久化，也可按需计算）
      CREATE TABLE IF NOT EXISTS anomalies (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        type VARCHAR(64) NOT NULL,
        description TEXT,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        severity VARCHAR(16) DEFAULT 'medium',
        related_visit_ids INTEGER[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_anomalies_user
        ON anomalies(user_id, created_at);
    `);
    console.log("Database initialized");
  } finally {
    client.release();
  }
}
