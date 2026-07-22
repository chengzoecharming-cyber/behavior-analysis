import { pool } from "../../db";
import { PoolClient } from "pg";

export async function initDataQualitySchema(client?: PoolClient): Promise<void> {
  const shouldRelease = !client;
  const c = client || (await pool.connect());
  try {
    await c.query(`
      -- 记录级数据质量异常
      CREATE TABLE IF NOT EXISTS data_quality_records (
        id SERIAL PRIMARY KEY,
        source VARCHAR(64) NOT NULL, -- 'excel' | 'dingtalk'
        source_id VARCHAR(128),      -- 如 approval_id 或 raw_visit_id
        record_index INTEGER,        -- 原始行号 / sequence
        user_id VARCHAR(64),
        business_date DATE,
        check_type VARCHAR(64) NOT NULL, -- 'timestamp', 'coordinate', 'mileage', 'duplicate', 'user', 'trip_type'
        severity VARCHAR(16) NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
        message TEXT NOT NULL,
        raw_value TEXT,              -- 原始值，方便排查
        resolved BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_dq_records_source
        ON data_quality_records(source, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dq_records_user_date
        ON data_quality_records(user_id, business_date);
      CREATE INDEX IF NOT EXISTS idx_dq_records_unresolved
        ON data_quality_records(resolved, severity, created_at DESC);

      -- 每次导入/同步的汇总
      CREATE TABLE IF NOT EXISTS data_quality_summary (
        id SERIAL PRIMARY KEY,
        job_type VARCHAR(64) NOT NULL, -- 'excel_upload' | 'dingtalk_sync'
        job_id VARCHAR(128),           -- 关联 raw_approvals / upload 批次
        start_date DATE,
        end_date DATE,
        total_records INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        info_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_dq_summary_job
        ON data_quality_summary(job_type, job_id);

      -- 同步对账结果
      CREATE TABLE IF NOT EXISTS reconciliation_checks (
        id SERIAL PRIMARY KEY,
        sync_log_id INTEGER REFERENCES dingtalk_sync_logs(id) ON DELETE CASCADE,
        check_name VARCHAR(128) NOT NULL,
        status VARCHAR(16) NOT NULL CHECK (status IN ('passed', 'failed', 'warning')),
        source_value TEXT,
        target_value TEXT,
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_reconciliation_sync_log
        ON reconciliation_checks(sync_log_id, check_name);

      -- 指标基线配置
      CREATE TABLE IF NOT EXISTS metric_baselines (
        id SERIAL PRIMARY KEY,
        metric_name VARCHAR(128) UNIQUE NOT NULL,
        description TEXT,
        query TEXT NOT NULL,           -- 计算该指标的 SQL
        unit VARCHAR(64),
        min_value DOUBLE PRECISION,
        max_value DOUBLE PRECISION,
        max_delta_percent DOUBLE PRECISION, -- 相对昨天/上周允许的最大波动
        lookback_days INTEGER DEFAULT 30,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 指标历史值
      CREATE TABLE IF NOT EXISTS metric_history (
        id SERIAL PRIMARY KEY,
        metric_name VARCHAR(128) NOT NULL REFERENCES metric_baselines(metric_name),
        value DOUBLE PRECISION NOT NULL,
        business_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(metric_name, business_date)
      );

      CREATE INDEX IF NOT EXISTS idx_metric_history_name_date
        ON metric_history(metric_name, business_date DESC);

      -- 计算血缘
      CREATE TABLE IF NOT EXISTS computation_dependencies (
        id SERIAL PRIMARY KEY,
        output_table VARCHAR(128) NOT NULL,
        depends_on_table VARCHAR(128) NOT NULL,
        refresh_procedure VARCHAR(128) NOT NULL, -- 对应的脚本/函数名
        priority INTEGER DEFAULT 0,
        UNIQUE(output_table, depends_on_table)
      );

      -- 重算任务队列
      CREATE TABLE IF NOT EXISTS computation_queue (
        id SERIAL PRIMARY KEY,
        procedure VARCHAR(128) NOT NULL,
        params JSONB DEFAULT '{}',
        status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
        error_message TEXT,
        scheduled_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_computation_queue_status
        ON computation_queue(status, scheduled_at);
    `);

    // 初始化默认指标基线
    await c.query(`
      INSERT INTO metric_baselines (metric_name, description, query, unit, min_value, max_value, max_delta_percent)
      VALUES
        ('daily_visit_count', '昨日总拜访数', 'SELECT COUNT(*) FROM visits WHERE business_date = CURRENT_DATE - 1', 'count', 100, 10000, 30),
        ('visit_per_user_avg', '人均日拜访数', 'SELECT COUNT(*)::float / NULLIF(COUNT(DISTINCT user_id), 0) FROM visits WHERE business_date = CURRENT_DATE - 1', 'count', 2, 12, 30),
        ('geocode_failure_rate', '坐标缺失率', 'SELECT 100.0 * COUNT(*) FILTER (WHERE geocode_status = ''failed'') / NULLIF(COUNT(*), 0) FROM visits WHERE business_date = CURRENT_DATE - 1', 'percent', 0, 5, 50),
        ('sync_success_rate', '钉钉同步成功率', 'SELECT 100.0 * COUNT(*) FILTER (WHERE status = ''success'') / NULLIF(COUNT(*), 0) FROM dingtalk_sync_logs WHERE started_at >= CURRENT_DATE - 1', 'percent', 100, 100, 0)
      ON CONFLICT (metric_name) DO UPDATE SET
        description = EXCLUDED.description,
        query = EXCLUDED.query,
        unit = EXCLUDED.unit,
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        max_delta_percent = EXCLUDED.max_delta_percent,
        updated_at = NOW();
    `);

    // 初始化计算血缘
    await c.query(`
      INSERT INTO computation_dependencies (output_table, depends_on_table, refresh_procedure, priority)
      VALUES
        ('routes', 'visits', 'recomputeRoutes', 1),
        ('stops', 'visits', 'recomputeStops', 1),
        ('anomalies', 'routes', 'recomputeAnomalies', 2),
        ('anomalies', 'stops', 'recomputeAnomalies', 2),
        ('risk_summary_cache', 'anomalies', 'refreshRiskCache', 3)
      ON CONFLICT (output_table, depends_on_table) DO UPDATE SET
        refresh_procedure = EXCLUDED.refresh_procedure,
        priority = EXCLUDED.priority;
    `);
  } finally {
    if (shouldRelease) c.release();
  }
}
