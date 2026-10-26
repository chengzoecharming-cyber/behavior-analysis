import { pool } from "../db";
import { formatBeijingDate } from "../utils/timezone";
import { resolveLeaderUserIds } from "./leaderConfig";
import { sendReportMessageToUsers } from "./dingtalkFile";

/**
 * CRM 公海挽回 / 私海健康度 / 阶段漏斗 统一查询与周报推送。
 * 查询口径与 crmAnalytics.ts 的三个接口共用（接口路由层只做参数解析）。
 * 数据全部为查询时计算，无派生落库，改口径不需要重算历史数据。
 */

/** 公海挽回关注的业务阶段（公海高阶段被掉保客户） */
export const RECOVERY_STAGES = ["方案/报价", "已发合同", "合同回传", "付款/发货", "已经交付"] as const;

export interface RecoveryItem {
  name: string;
  follow_status: string;
  last_owner: string | null;
  owner_name: string | null;
  return_pool_time: string | null;
  return_pool_reason: string | null;
  return_pool_times: number | null;
  latest_follow_up_time: string | null;
  follow_times: number;
  region: string | null;
  channel: string | null;
}

export interface RecoveryListResult {
  total: number;
  /** 按阶段分组计数（无条件口径，不含 stage/owner 筛选），key 为 follow_status */
  summary: Record<string, number>;
  list: RecoveryItem[];
}

/** 公海挽回清单：公海且 follow_status 为高阶段的客户，按阶段权重 + 退回时间倒序 */
export async function queryRecoveryList(opts: {
  stage?: string;
  owner?: string;
  offset: number;
  limit: number;
}): Promise<RecoveryListResult> {
  const params: unknown[] = [RECOVERY_STAGES as unknown as string[]];
  const where: string[] = ["is_in_pool = true", "follow_status = ANY($1)", "NOT COALESCE(is_deleted, false)"];
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`follow_status = $${params.length}`);
  }
  if (opts.owner) {
    params.push(`%${opts.owner}%`);
    where.push(`last_owner ILIKE $${params.length}`);
  }
  const whereSql = where.join(" AND ");

  const [countRes, summaryRes, listRes] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM crm_customers WHERE ${whereSql}`,
      params
    ),
    pool.query<{ follow_status: string; n: string }>(
      `SELECT follow_status, COUNT(*)::text AS n FROM crm_customers
       WHERE is_in_pool = true AND NOT COALESCE(is_deleted, false) AND follow_status = ANY($1) GROUP BY follow_status`,
      [RECOVERY_STAGES as unknown as string[]]
    ),
    pool.query<{
      name: string; follow_status: string; last_owner: string | null; owner_name: string | null;
      return_pool_time: Date | null; return_pool_reason: string | null; return_pool_times: number | null;
      latest_follow_up_time: Date | null; follow_times: number; region: string | null; channel: string | null;
    }>(
      `SELECT name, follow_status, last_owner, owner_name, return_pool_time, return_pool_reason,
              return_pool_times, latest_follow_up_time, follow_times, region, channel
       FROM crm_customers WHERE ${whereSql}
       ORDER BY CASE follow_status
                  WHEN '合同回传' THEN 4 WHEN '已发合同' THEN 3 WHEN '方案/报价' THEN 2
                  WHEN '付款/发货' THEN 1 WHEN '已经交付' THEN 0 ELSE -1 END DESC,
                return_pool_time DESC NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, opts.offset]
    ),
  ]);

  const summary: Record<string, number> = {};
  for (const s of RECOVERY_STAGES) summary[s] = 0;
  for (const r of summaryRes.rows) summary[r.follow_status] = parseInt(r.n, 10);

  return {
    total: parseInt(countRes.rows[0].n, 10),
    summary,
    list: listRes.rows.map((r) => ({
      ...r,
      return_pool_time: r.return_pool_time ? r.return_pool_time.toISOString() : null,
      latest_follow_up_time: r.latest_follow_up_time ? r.latest_follow_up_time.toISOString() : null,
    })),
  };
}

export interface PoolHealthRow {
  owner_name: string;
  private_count: number;
  zero_follow_count: number;
  stale_30d_count: number;
  dropped_count: number;
  /** 掉保率 = 历史被掉保数 / (当前私海数 + 历史被掉保数) */
  drop_ratio: number;
}

export interface PoolHealthResult {
  company: {
    private_count: number;
    zero_follow_count: number;
    zero_follow_ratio: number;
    stale_30d_count: number;
    stale_30d_ratio: number;
    dropped_count: number;
  };
  rows: PoolHealthRow[];
}

/** 私海健康度：按负责人汇总私海跟进情况与历史掉保率，按掉保率降序 */
export async function queryPoolHealth(): Promise<PoolHealthResult> {
  const res = await pool.query<{
    owner_name: string; private_count: string; zero_follow: string; stale_30d: string; dropped: string;
  }>(
    `WITH cur AS (
       SELECT owner_name,
              COUNT(*) AS private_count,
              COUNT(*) FILTER (WHERE follow_times = 0) AS zero_follow,
              COUNT(*) FILTER (WHERE latest_follow_up_time IS NULL
                                 OR latest_follow_up_time < NOW() - INTERVAL '30 days') AS stale_30d
       FROM crm_customers
       WHERE NOT is_in_pool AND NOT COALESCE(is_deleted, false) AND owner_name IS NOT NULL AND owner_name <> ''
       GROUP BY owner_name
     ), drp AS (
       SELECT last_owner, COUNT(*) AS dropped
       FROM crm_customers
       WHERE is_in_pool AND NOT COALESCE(is_deleted, false) AND COALESCE(return_pool_times, 0) > 0
         AND last_owner IS NOT NULL AND last_owner <> ''
       GROUP BY last_owner
     )
     SELECT cur.owner_name,
            cur.private_count::text,
            cur.zero_follow::text,
            cur.stale_30d::text,
            COALESCE(drp.dropped, 0)::text AS dropped
     FROM cur LEFT JOIN drp ON drp.last_owner = cur.owner_name`
  );

  const rows: PoolHealthRow[] = res.rows.map((r) => {
    const priv = parseInt(r.private_count, 10);
    const dropped = parseInt(r.dropped, 10);
    return {
      owner_name: r.owner_name,
      private_count: priv,
      zero_follow_count: parseInt(r.zero_follow, 10),
      stale_30d_count: parseInt(r.stale_30d, 10),
      dropped_count: dropped,
      drop_ratio: priv + dropped > 0 ? +(dropped / (priv + dropped)).toFixed(4) : 0,
    };
  });
  rows.sort((a, b) => b.drop_ratio - a.drop_ratio || b.dropped_count - a.dropped_count);

  // 全公司汇总（历史被掉保数含 last_owner 为空的部分，口径 = 公海中 return_pool_times>0 全量）
  const totalRes = await pool.query<{
    private_count: string; zero_follow: string; stale_30d: string; dropped: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE NOT is_in_pool)::text AS private_count,
       COUNT(*) FILTER (WHERE NOT is_in_pool AND follow_times = 0)::text AS zero_follow,
       COUNT(*) FILTER (WHERE NOT is_in_pool AND (latest_follow_up_time IS NULL
                          OR latest_follow_up_time < NOW() - INTERVAL '30 days'))::text AS stale_30d,
       COUNT(*) FILTER (WHERE is_in_pool AND COALESCE(return_pool_times, 0) > 0)::text AS dropped
     FROM crm_customers
     WHERE NOT COALESCE(is_deleted, false)`
  );
  const t = totalRes.rows[0];
  const priv = parseInt(t.private_count, 10);

  return {
    company: {
      private_count: priv,
      zero_follow_count: parseInt(t.zero_follow, 10),
      zero_follow_ratio: priv > 0 ? +(parseInt(t.zero_follow, 10) / priv).toFixed(4) : 0,
      stale_30d_count: parseInt(t.stale_30d, 10),
      stale_30d_ratio: priv > 0 ? +(parseInt(t.stale_30d, 10) / priv).toFixed(4) : 0,
      dropped_count: parseInt(t.dropped, 10),
    },
    rows,
  };
}

export interface FunnelStage {
  stage: string;
  private_count: number;
  pool_count: number;
}

export interface FunnelResult {
  stages: FunnelStage[];
  snapshot_date: string | null;
}

/** 阶段漏斗：按 follow_status 分组计数，公私海拆分；空值归「无阶段」桶 */
export async function queryFunnel(): Promise<FunnelResult> {
  const [stageRes, snapshotRes] = await Promise.all([
    pool.query<{ stage: string; private_count: string; pool_count: string }>(
      `SELECT COALESCE(NULLIF(TRIM(follow_status), ''), '无阶段') AS stage,
              COUNT(*) FILTER (WHERE NOT is_in_pool)::text AS private_count,
              COUNT(*) FILTER (WHERE is_in_pool)::text AS pool_count
       FROM crm_customers WHERE NOT COALESCE(is_deleted, false) GROUP BY 1`
    ),
    pool.query<{ ts: Date | null }>(`SELECT MAX(created_at) AS ts FROM crm_import_batches`),
  ]);
  return {
    stages: stageRes.rows.map((r) => ({
      stage: r.stage,
      private_count: parseInt(r.private_count, 10),
      pool_count: parseInt(r.pool_count, 10),
    })),
    snapshot_date: snapshotRes.rows[0]?.ts ? formatBeijingDate(snapshotRes.rows[0].ts) : null,
  };
}

/** 解析 CRM_DIGEST_RECIPIENTS（逗号/分号分隔的姓名或 userid）；为空返回 null 表示推送关闭 */
function parseDigestRecipients(): string[] | null {
  const raw = (process.env.CRM_DIGEST_RECIPIENTS || "").trim();
  if (!raw) return null;
  const names = raw.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? names : null;
}

/** 生成 CRM 周报 markdown（公海挽回 Top10 + 私海健康度预警 Top5 + 漏斗速览） */
export async function buildCrmDigestMarkdown(): Promise<string> {
  const [recovery, health, funnel] = await Promise.all([
    queryRecoveryList({ offset: 0, limit: 10 }),
    queryPoolHealth(),
    queryFunnel(),
  ]);

  const lines: string[] = ["### CRM 客户周报", ""];

  const highStageTotal = Object.values(recovery.summary).reduce((a, b) => a + b, 0);
  lines.push(`#### 一、公海挽回（高阶段被掉保客户共 ${highStageTotal} 家，以下为 Top 10）`, "");
  if (recovery.list.length === 0) {
    lines.push("暂无公海高阶段客户。");
  } else {
    lines.push("| 客户 | 阶段 | 最后负责人 | 退回公海时间 |", "| --- | --- | --- | --- |");
    for (const r of recovery.list) {
      lines.push(
        `| ${r.name} | ${r.follow_status} | ${r.last_owner || "-"} | ${
          r.return_pool_time ? formatBeijingDate(new Date(r.return_pool_time)) : "-"
        } |`
      );
    }
  }
  lines.push("");

  // 私海健康度预警：掉保率最高且私海数 ≥ 10 的负责人 Top 5
  const risky = health.rows.filter((r) => r.private_count >= 10).slice(0, 5);
  lines.push("#### 二、私海健康度预警（掉保率 Top 5，私海数 ≥ 10）", "");
  if (risky.length === 0) {
    lines.push("暂无满足条件的负责人。");
  } else {
    lines.push("| 负责人 | 私海数 | 掉保率 | 零跟进数 |", "| --- | --- | --- | --- |");
    for (const r of risky) {
      lines.push(
        `| ${r.owner_name} | ${r.private_count} | ${(r.drop_ratio * 100).toFixed(1)}% | ${r.zero_follow_count} |`
      );
    }
  }
  lines.push("");

  // 漏斗速览：按固定业务阶段顺序列私海数（「初步接触\拜访」是 CRM 里的原始值）
  const FUNNEL_ORDER = ["初步接触\\拜访", "初步意向", "方案/报价", "已发合同", "合同回传", "付款/发货", "已经交付"];
  const byStage = new Map(funnel.stages.map((s) => [s.stage, s]));
  const fixed = FUNNEL_ORDER.filter((s) => byStage.has(s)).map((s) => `${s} ${byStage.get(s)!.private_count}`);
  const other = funnel.stages
    .filter((s) => !FUNNEL_ORDER.includes(s.stage))
    .reduce((a, s) => a + s.private_count, 0);
  if (other > 0) fixed.push(`其他 ${other}`);
  lines.push("#### 三、阶段漏斗速览（私海数）", "");
  lines.push(fixed.join(" → ") || "暂无数据");
  lines.push("");
  lines.push(`---`, `CRM 数据快照 ${funnel.snapshot_date ?? "未知"}（MCP 定时同步，非实时）`);

  return lines.join("\n");
}

export interface CrmDigestSendResult {
  /** 配置里解析成功的钉钉 userid */
  userIds: string[];
  /** 配置的原始接收人（姓名/userid） */
  recipients: string[];
  /** 解析不到的接收人 */
  unresolved: string[];
  /** 未配置 CRM_DIGEST_RECIPIENTS 时为 true（任务跳过） */
  skipped: boolean;
}

/** 发送 CRM 周报到 CRM_DIGEST_RECIPIENTS 配置的接收人（灰度：为空完全不执行） */
export async function sendCrmDigest(): Promise<CrmDigestSendResult> {
  const recipients = parseDigestRecipients();
  if (!recipients) {
    console.log("[CRM Digest] CRM_DIGEST_RECIPIENTS 未配置，跳过推送");
    return { skipped: true, recipients: [], userIds: [], unresolved: [] };
  }
  // 逐个解析以精确回报解析失败的人（resolveLeaderUserIds 内部对失败项只 warn 不返回）
  const userIds: string[] = [];
  const unresolved: string[] = [];
  for (const name of recipients) {
    const ids = await resolveLeaderUserIds([name]);
    if (ids.length > 0) userIds.push(...ids);
    else unresolved.push(name);
  }
  if (userIds.length === 0) {
    console.warn(`[CRM Digest] 接收人全部解析失败: ${recipients.join(",")}`);
    return { skipped: false, recipients, userIds, unresolved };
  }
  const markdown = await buildCrmDigestMarkdown();
  await sendReportMessageToUsers(userIds, "CRM 客户周报", markdown);
  console.log(`[CRM Digest] 已推送给 ${userIds.length} 人`);
  return { skipped: false, recipients, userIds, unresolved };
}
