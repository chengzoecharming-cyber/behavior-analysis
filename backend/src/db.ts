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

      -- RAW 层：钉钉审批原始实例
      CREATE TABLE IF NOT EXISTS raw_approvals (
        id SERIAL PRIMARY KEY,
        approval_id VARCHAR(64) UNIQUE NOT NULL,
        process_instance_id VARCHAR(64),
        process_code VARCHAR(64),
        title VARCHAR(255),
        originator_userid VARCHAR(64),
        originator_user_name VARCHAR(128),
        originator_dept_name VARCHAR(128),
        create_time TIMESTAMPTZ,
        finish_time TIMESTAMPTZ,
        form_json JSONB,
        result VARCHAR(32),
        status VARCHAR(32),
        source VARCHAR(64) DEFAULT 'dingtalk',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_raw_approvals_approval_id
        ON raw_approvals(approval_id);
      CREATE INDEX IF NOT EXISTS idx_raw_approvals_originator
        ON raw_approvals(originator_userid);
      CREATE INDEX IF NOT EXISTS idx_raw_approvals_create_time
        ON raw_approvals(create_time);

      -- 兼容旧库：补充 process_instance_id 字段及索引
      ALTER TABLE raw_approvals ADD COLUMN IF NOT EXISTS process_instance_id VARCHAR(64);
      CREATE INDEX IF NOT EXISTS idx_raw_approvals_process_instance_id
        ON raw_approvals(process_instance_id);

      -- NORMALIZED 层：标准化后的核心数据
      CREATE TABLE IF NOT EXISTS visits (
        id SERIAL PRIMARY KEY,
        raw_visit_id INTEGER REFERENCES raw_visits(id) ON DELETE SET NULL,
        user_id VARCHAR(64) NOT NULL,
        user_name VARCHAR(128) NOT NULL,
        department VARCHAR(128),
        timestamp TIMESTAMPTZ NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        location_name VARCHAR(255),
        address TEXT,
        customer_name VARCHAR(255),
        source VARCHAR(64) DEFAULT 'excel',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 扩展业务字段
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS approval_id VARCHAR(64);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS sequence INTEGER DEFAULT 0;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS trip_type VARCHAR(64);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS vehicle VARCHAR(128);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS start_odometer DOUBLE PRECISION;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS end_odometer DOUBLE PRECISION;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS reported_distance_km DOUBLE PRECISION;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS visit_note TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS special_sign_reason TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]';
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS geocode_status VARCHAR(16) DEFAULT 'pending';
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS source_detail VARCHAR(64);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS business_date DATE;

      -- 坐标失败后允许为 NULL，不再写入 0,0
      ALTER TABLE visits ALTER COLUMN lat DROP NOT NULL;
      ALTER TABLE visits ALTER COLUMN lng DROP NOT NULL;

      -- 常见地址兜底坐标表（用于高德解析失败的简称/惯用地址）
      CREATE TABLE IF NOT EXISTS address_fallback_coordinates (
        id SERIAL PRIMARY KEY,
        address VARCHAR(255) UNIQUE NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_address_fallback_address
        ON address_fallback_coordinates(address);

      CREATE INDEX IF NOT EXISTS idx_visits_user_time
        ON visits(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_visits_user_business_date
        ON visits(user_id, business_date);
      CREATE INDEX IF NOT EXISTS idx_visits_approval
        ON visits(approval_id, sequence);

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

      ALTER TABLE stops ADD COLUMN IF NOT EXISTS business_date DATE;

      CREATE INDEX IF NOT EXISTS idx_stops_user
        ON stops(user_id, start_time);
      CREATE INDEX IF NOT EXISTS idx_stops_user_business_date
        ON stops(user_id, business_date);

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

      ALTER TABLE routes ADD COLUMN IF NOT EXISTS business_date DATE;

      CREATE INDEX IF NOT EXISTS idx_routes_user
        ON routes(user_id, from_visit_id, to_visit_id);
      CREATE INDEX IF NOT EXISTS idx_routes_user_business_date
        ON routes(user_id, business_date);

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
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

      ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS anomaly_date DATE;

      ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS layer VARCHAR(16) CHECK (layer IN ('fact', 'analyze', 'judge'));

      CREATE INDEX IF NOT EXISTS idx_anomalies_user
        ON anomalies(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_anomalies_user_type_time
        ON anomalies(user_id, type, created_at);
      CREATE INDEX IF NOT EXISTS idx_anomalies_user_date
        ON anomalies(user_id, anomaly_date);

      -- 风险摘要预计算缓存表
      CREATE TABLE IF NOT EXISTS risk_summary_cache (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        user_name VARCHAR(128),
        department VARCHAR(128),
        date DATE NOT NULL,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
        anomaly_count INTEGER NOT NULL DEFAULT 0,
        high_anomaly_count INTEGER NOT NULL DEFAULT 0,
        medium_anomaly_count INTEGER NOT NULL DEFAULT 0,
        low_anomaly_count INTEGER NOT NULL DEFAULT 0,
        visit_count INTEGER NOT NULL DEFAULT 0,
        total_stop_minutes INTEGER NOT NULL DEFAULT 0,
        total_distance_km DOUBLE PRECISION NOT NULL DEFAULT 0,
        reasons JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, date)
      );

      ALTER TABLE risk_summary_cache ADD COLUMN IF NOT EXISTS user_name VARCHAR(128);
      ALTER TABLE risk_summary_cache ADD COLUMN IF NOT EXISTS department VARCHAR(128);

      CREATE INDEX IF NOT EXISTS idx_risk_summary_date
        ON risk_summary_cache(date);
      CREATE INDEX IF NOT EXISTS idx_risk_summary_user_date
        ON risk_summary_cache(user_id, date);

      -- 用户系统
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) UNIQUE NOT NULL,
        user_name VARCHAR(128) NOT NULL,
        department VARCHAR(128),
        role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
        manager_id INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_resigned BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS leader_dept_ids BIGINT[] DEFAULT '{}';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_invalid BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS home_address TEXT;

      CREATE INDEX IF NOT EXISTS idx_users_manager
        ON users(manager_id);
      CREATE INDEX IF NOT EXISTS idx_users_user_id
        ON users(user_id);

      -- 反馈申诉表
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        description TEXT,
        status VARCHAR(16) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
        reviewer_id VARCHAR(64),
        review_note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_user
        ON feedback(user_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_status
        ON feedback(status);

      -- 异常豁免表（审批 approved 后写入，不删除原异常）
      CREATE TABLE IF NOT EXISTS anomaly_exceptions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        feedback_id INTEGER REFERENCES feedback(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_anomaly_exceptions_user
        ON anomaly_exceptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_anomaly_exceptions_dates
        ON anomaly_exceptions(user_id, start_date, end_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_anomaly_exceptions_feedback_id
        ON anomaly_exceptions(feedback_id);

      -- 初始化一个默认管理员（可被替换）
      INSERT INTO users (user_id, user_name, department, role)
      VALUES ('admin', '系统管理员', '总部', 'admin')
      ON CONFLICT (user_id) DO UPDATE SET user_name = EXCLUDED.user_name;

      -- 将已有拜访数据中的用户自动导入为用户（默认 staff）
      INSERT INTO users (user_id, user_name, department, role)
      SELECT DISTINCT user_id, user_name, department, 'staff'
      FROM visits
      WHERE user_id IS NOT NULL
      ON CONFLICT (user_id) DO NOTHING;

      -- 异常规则权重配置表
      CREATE TABLE IF NOT EXISTS anomaly_weights (
        id SERIAL PRIMARY KEY,
        rule_key VARCHAR(64) UNIQUE NOT NULL,
        rule_name VARCHAR(128) NOT NULL,
        weight DOUBLE PRECISION NOT NULL DEFAULT 0.1,
        threshold_value DOUBLE PRECISION,
        enabled BOOLEAN DEFAULT true,
        layer VARCHAR(16) CHECK (layer IN ('fact', 'analyze', 'judge')),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE anomaly_weights ADD COLUMN IF NOT EXISTS layer VARCHAR(16) CHECK (layer IN ('fact', 'analyze', 'judge'));

      INSERT INTO anomaly_weights (rule_key, rule_name, weight, threshold_value, enabled, layer, description)
      VALUES
        ('low_visit_count', '拜访量不足', 0.25, 15, true, 'judge', '过去5个工作日累计签到次数<15次'),
        ('duplicate_location', '重复签到', 0.20, 8, true, 'fact', '过去两周同一地点重复签到>=8次'),
        ('mileage_deviation', '里程异常', 0.30, 0.30, true, 'judge', '填报里程 vs 高德里程偏差>30%'),
        ('long_stop', '停留过长', 0.15, 120, false, 'analyze', '停留>120分钟'),
        ('long_idle', '长时间未移动', 0.05, 180, false, 'analyze', '>180分钟无移动记录'),
        ('invalid_trip_type', '异常出行方式', 0.03, 5, false, 'fact', '公共交通/特殊签到但填报较长里程'),
        ('missing_special_reason', '特殊签到缺原因', 0.02, NULL, true, 'fact', '特殊签到未填写原因'),
        ('mileage_reading_invalid', '里程读数异常', 0.02, NULL, true, 'fact', '出发/终点里程读数缺失、非单调递增或超过合理上限')
      ON CONFLICT (rule_key) DO UPDATE SET
        rule_name = EXCLUDED.rule_name,
        weight = EXCLUDED.weight,
        threshold_value = EXCLUDED.threshold_value,
        enabled = EXCLUDED.enabled,
        layer = EXCLUDED.layer,
        description = EXCLUDED.description,
        updated_at = NOW();

      -- 对已有历史数据做幂等迁移：确保层级和启停用状态与目标一致
      UPDATE anomaly_weights SET enabled = false, layer = 'analyze' WHERE rule_key IN ('long_stop', 'long_idle', 'route_detour');
      UPDATE anomaly_weights SET enabled = false, layer = 'fact' WHERE rule_key = 'invalid_trip_type';
      UPDATE anomaly_weights SET layer = 'fact', threshold_value = 8 WHERE rule_key = 'duplicate_location';
      UPDATE anomaly_weights SET layer = 'fact' WHERE rule_key IN ('mileage_reading_invalid', 'missing_special_reason');
      UPDATE anomaly_weights SET layer = 'judge' WHERE rule_key IN ('low_visit_count', 'mileage_deviation');

      -- 钉钉通讯录同步（探测/缓存用）
      CREATE TABLE IF NOT EXISTS dingtalk_departments (
        id SERIAL PRIMARY KEY,
        dept_id BIGINT UNIQUE NOT NULL,
        parent_id BIGINT,
        name VARCHAR(128) NOT NULL,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_dingtalk_departments_parent
        ON dingtalk_departments(parent_id);

      CREATE TABLE IF NOT EXISTS dingtalk_users (
        id SERIAL PRIMARY KEY,
        userid VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(128) NOT NULL,
        mobile VARCHAR(32),
        title VARCHAR(128),
        dept_id_list VARCHAR(255),
        source_dept_id BIGINT,
        synced_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_dingtalk_users_source_dept
        ON dingtalk_users(source_dept_id);

      -- 部门别名映射表：原始 department 字符串 → 规范部门名称
      CREATE TABLE IF NOT EXISTS department_aliases (
        id SERIAL PRIMARY KEY,
        alias VARCHAR(255) UNIQUE NOT NULL,
        canonical_name VARCHAR(128),
        source VARCHAR(64) DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_department_aliases_canonical
        ON department_aliases(canonical_name);

      -- 钉钉同步记录表
      CREATE TABLE IF NOT EXISTS dingtalk_sync_logs (
        id SERIAL PRIMARY KEY,
        triggered_by VARCHAR(32) NOT NULL CHECK (triggered_by IN ('scheduler', 'manual', 'startup')),
        status VARCHAR(16) NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        total_instances INTEGER NOT NULL DEFAULT 0,
        parsed_visits INTEGER NOT NULL DEFAULT 0,
        parse_failures INTEGER NOT NULL DEFAULT 0,
        normalized_inserted INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_dingtalk_sync_logs_status_started
        ON dingtalk_sync_logs(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dingtalk_sync_logs_dates
        ON dingtalk_sync_logs(start_date, end_date);
    `);
    console.log("Database initialized");
  } finally {
    client.release();
  }
}
