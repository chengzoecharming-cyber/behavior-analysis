import { Router, Response } from "express";
import { pool } from "../db";
import { authMiddleware, AuthRequest, requireRole } from "../services/auth";
import {
  queryRecoveryList,
  queryPoolHealth,
  queryFunnel,
  sendCrmDigest,
} from "../services/crmDigestService";
import { getVisibleUserIds } from "../services/permission";
import { splitRealCustomerNames, normalizeCustomerName } from "../services/normalization";
import { resolveCrmName } from "../services/customerMatch";
import { geocodeAddress } from "../services/geocoding";
import { formatBeijingDate } from "../utils/timezone";

const router = Router();

/**
 * 客户分析（探迹 CRM 数据）：
 * 行级口径（cross/stuck/opportunity-map）按 getVisibleUserIds 收敛——
 * CRM 客户的 owner_name 与可见用户的 user_name 匹配；
 * 聚合口径（overview/wordcloud）参照总览页约定，登录角色均可见全量。
 */

/** 可见用户名列表；返回 null 表示不过滤（admin） */
async function getVisibleUserNames(req: AuthRequest): Promise<string[] | null> {
  const user = req.currentUser!;
  const visibleIds = await getVisibleUserIds(user);
  if (visibleIds === null) return null;
  if (visibleIds.length === 0) return [];
  const res = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM users WHERE user_id = ANY($1)`,
    [visibleIds]
  );
  return res.rows.map((r) => r.user_name);
}

/** 追加 owner_name 可见性过滤条件；返回下一个参数下标 */
function appendOwnerFilter(
  where: string[],
  params: unknown[],
  visibleNames: string[] | null,
  column: string
): void {
  if (visibleNames !== null) {
    params.push(visibleNames);
    where.push(`${column} = ANY($${params.length})`);
  }
}

function pageParams(req: AuthRequest): { page: number; pageSize: number; offset: number } {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "50"), 10) || 50, 1), 200);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** visits 客户名拆分聚合：norm 名 → { count, users }（排除不计拜访的签到与占位名，
 *  保持「一个打卡点 N 个真实客户 = N 次拜访」口径） */
async function loadVisitNameCounts(): Promise<Map<string, { count: number; users: Set<string> }>> {
  const res = await pool.query<{ customer_name: string; user_name: string }>(
    `SELECT customer_name, user_name FROM visits
     WHERE customer_name IS NOT NULL AND NOT exclude_from_visit_count`
  );
  const map = new Map<string, { count: number; users: Set<string> }>();
  for (const row of res.rows) {
    // v1/Excel 手填数据也有占位名（「虚拟客户（签到用）」「住址」等），统一过滤不计入
    for (const name of splitRealCustomerNames(row.customer_name)) {
      const norm = normalizeCustomerName(name);
      if (!norm) continue;
      let entry = map.get(norm);
      if (!entry) {
        entry = { count: 0, users: new Set() };
        map.set(norm, entry);
      }
      entry.count += 1;
      if (row.user_name) entry.users.add(row.user_name);
    }
  }
  return map;
}

/** visits 客户名 → 最近一次拜访时间（排除不计拜访的签到与占位名，单次全表扫描） */
async function loadVisitNameLastTimes(): Promise<Map<string, Date>> {
  const res = await pool.query<{ customer_name: string; ts: Date }>(
    `SELECT customer_name, "timestamp" AS ts FROM visits
     WHERE customer_name IS NOT NULL AND NOT exclude_from_visit_count`
  );
  const map = new Map<string, Date>();
  for (const row of res.rows) {
    for (const name of splitRealCustomerNames(row.customer_name)) {
      const norm = normalizeCustomerName(name);
      if (!norm) continue;
      const prev = map.get(norm);
      if (!prev || row.ts > prev) map.set(norm, row.ts);
    }
  }
  return map;
}

/** CRM 跟进记录按归一化客户名聚合次数 */
async function loadFollowRecordCounts(): Promise<Map<string, number>> {
  const res = await pool.query<{ norm: string; n: string }>(
    `SELECT customer_name_norm AS norm, COUNT(*)::text AS n
     FROM crm_follow_records WHERE customer_name_norm IS NOT NULL AND customer_name_norm <> ''
     GROUP BY customer_name_norm`
  );
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.norm, parseInt(row.n, 10));
  return map;
}

// GET /crm-analytics/cross —— 客户×拜访交叉（CRM 跟进 vs visits 拜访）
router.get("/cross", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const visibleNames = await getVisibleUserNames(req);
    const [visitMap, followMap] = await Promise.all([
      loadVisitNameCounts(),
      loadFollowRecordCounts(),
    ]);

    // CRM 客户（按可见负责人收敛）
    const where: string[] = ["name_norm IS NOT NULL", "name_norm <> ''"];
    const params: unknown[] = [];
    appendOwnerFilter(where, params, visibleNames, "owner_name");
    const customers = await pool.query<{
      name: string; name_norm: string; owner_name: string | null;
    }>(`SELECT name, name_norm, owner_name FROM crm_customers WHERE ${where.join(" AND ")}`, params);

    interface CrossItem {
      customer_name: string;
      follow_count: number;
      visit_count: number;
      owner_name: string | null;
      in_crm: boolean;
    }
    const items = new Map<string, CrossItem>();

    for (const c of customers.rows) {
      items.set(c.name_norm, {
        customer_name: c.name,
        follow_count: followMap.get(c.name_norm) ?? 0,
        visit_count: 0,
        owner_name: c.owner_name,
        in_crm: true,
      });
    }

    // visits 名 → CRM 客户的三层匹配：① name_norm 精确；② 规则归并（去分支后缀 /
    // 双向包含，见 customerMatch.ts）；③ 仍对不上 → 待确认桶，不计入三个分类结论数字。
    const crmNorms = [...items.keys()];
    const crmNormSet = new Set(crmNorms);
    const unmatched = new Map<string, CrossItem>();
    for (const [norm, v] of visitMap) {
      const target = resolveCrmName(norm, crmNormSet, crmNorms);
      if (target) {
        const it = items.get(target)!;
        it.visit_count += v.count;
        continue;
      }
      // 待确认桶沿用 visits-only 的拜访人可见性收敛
      if (visibleNames !== null && ![...v.users].some((u) => visibleNames.includes(u))) continue;
      let u = unmatched.get(norm);
      if (!u) {
        u = {
          customer_name: norm,
          follow_count: 0,
          visit_count: 0,
          owner_name: [...v.users].join("、"),
          in_crm: false,
        };
        unmatched.set(norm, u);
      }
      u.visit_count += v.count;
    }

    const typeFilter = String(req.query.type || "");
    const isUnmatched = typeFilter === "unmatched";
    const source = isUnmatched ? [...unmatched.values()] : [...items.values()];
    const list = source.filter((it) => {
      if (typeFilter === "follow_only") return it.follow_count > 0 && it.visit_count === 0;
      if (typeFilter === "visit_only") return it.visit_count > 0 && it.follow_count === 0;
      if (typeFilter === "both") return it.follow_count > 0 && it.visit_count > 0;
      return it.follow_count > 0 || it.visit_count > 0;
    });
    list.sort((a, b) => b.visit_count + b.follow_count - (a.visit_count + a.follow_count));

    // 三个分类计数只统计归并后的 CRM 客户（待确认桶不参与）
    let onlyFollow = 0, onlyVisit = 0, both = 0;
    for (const it of items.values()) {
      if (it.follow_count > 0 && it.visit_count > 0) both++;
      else if (it.follow_count > 0) onlyFollow++;
      else if (it.visit_count > 0) onlyVisit++;
    }

    const { pageSize, offset } = pageParams(req);
    res.json({
      only_follow_count: onlyFollow,
      only_visit_count: onlyVisit,
      both_count: both,
      unmatched_count: unmatched.size,
      total: list.length,
      list: list.slice(offset, offset + pageSize),
    });
  } catch (err) {
    console.error("crm-analytics/cross error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// 领域词典（词云匹配用）
const WORDCLOUD_DICT = [
  "报价", "价格", "合同", "方案", "交期", "账期", "售后", "预算", "样品", "竞品",
  "刀具柜", "工具柜", "机加云", "数字仓库", "称重柜", "旋转柜", "工单宝", "刀摆仪",
  "拜访", "电话", "微信", "演示", "培训", "验收", "投诉",
  "试单", "复购", "招标", "投标", "回款", "催款", "发货", "物流", "安装", "调试",
  "意向", "成交", "流失", "代理商", "终端客户", "展会", "验厂", "打样", "定制",
];

// 二元组提取时的停用字（含这些字的二元组不计）
const BIGRAM_STOP_CHARS = new Set(
  "的了和我在是有与及等也都就不又还但而被让对到上下来去着呢吧吗啊嘛么这那您他她它我们你他们为于把被从向以及或者因为所以如果按照今天明天昨天现在没有进行相关通过电话已经需保司目较持" +
  "0123456789"
);

// GET /crm-analytics/wordcloud —— 跟进记录词频（词典匹配 + 高频二元组补充）
router.get("/wordcloud", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query<{ content: string }>(
      `SELECT content FROM crm_follow_records
       WHERE content IS NOT NULL AND length(content) > 10`
    );
    const dictCounts = new Map<string, number>();
    const bigramCounts = new Map<string, number>();

    for (const { content } of result.rows) {
      // 词典匹配：每条记录每个词只计一次
      for (const word of WORDCLOUD_DICT) {
        if (content.includes(word)) {
          dictCounts.set(word, (dictCounts.get(word) ?? 0) + 1);
        }
      }
      // 高频二元组：仅保留纯中文片段滑动提取
      const cjkOnly = content.replace(/[^一-鿿]+/g, " ");
      for (const seg of cjkOnly.split(/\s+/)) {
        for (let i = 0; i + 2 <= seg.length; i++) {
          const bg = seg.slice(i, i + 2);
          if (BIGRAM_STOP_CHARS.has(bg[0]) || BIGRAM_STOP_CHARS.has(bg[1])) continue;
          bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
        }
      }
    }

    const merged = new Map<string, number>(dictCounts);
    for (const [bg, n] of bigramCounts) {
      // 只补充词典未覆盖、且出现足够频繁的二元组
      if (n < 5) continue;
      if ([...WORDCLOUD_DICT].some((w) => w.includes(bg))) continue;
      merged.set(bg, (merged.get(bg) ?? 0) + n);
    }

    const words = [...merged.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);
    res.json(words);
  } catch (err) {
    console.error("crm-analytics/wordcloud error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/opportunity-map —— 客户地址分布（含坐标与拜访次数）
router.get("/opportunity-map", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const visibleNames = await getVisibleUserNames(req);
    const where: string[] = ["address IS NOT NULL", "address <> ''"];
    const params: unknown[] = [];
    appendOwnerFilter(where, params, visibleNames, "owner_name");
    const customers = await pool.query<{
      id: string; name: string; name_norm: string; address: string;
      region: string | null; follow_status: string | null;
      owner_name: string | null; is_in_pool: boolean;
    }>(
      `SELECT id, name, name_norm, address, region, follow_status, owner_name, is_in_pool
       FROM crm_customers WHERE ${where.join(" AND ")}`,
      params
    );

    // 地理编码缓存（含重试计数：attempts>=5 的失败记录不再重试）
    const ids = customers.rows.map((c) => c.id);
    const cache = new Map<string, { lat: number | null; lng: number | null; attempts: number }>();
    if (ids.length > 0) {
      const cached = await pool.query<{ customer_id: string; lat: number | null; lng: number | null; attempts: number }>(
        `SELECT customer_id, lat, lng, attempts FROM crm_customer_geocode WHERE customer_id = ANY($1)`,
        [ids]
      );
      for (const r of cached.rows) cache.set(r.customer_id, { lat: r.lat, lng: r.lng, attempts: r.attempts });
    }

    // 限流解析（高德 QPS 限制，每次请求最多 30 条）：失败记录可重试——
    // 名额优先给从未解析的，其次给之前失败但 attempts < 5 的
    const MAX_NEW_GEOCODE = 30;
    const MAX_GEOCODE_ATTEMPTS = 5;
    const todo = customers.rows
      .filter((c) => {
        const g = cache.get(c.id);
        if (g && g.lat != null) return false; // 已成功
        if (g && g.attempts >= MAX_GEOCODE_ATTEMPTS) return false; // 失败次数用尽
        return true;
      })
      .sort((a, b) => (cache.get(a.id)?.attempts ?? -1) - (cache.get(b.id)?.attempts ?? -1))
      .slice(0, MAX_NEW_GEOCODE);
    let geocoded = 0;
    for (const c of todo) {
      const coords = await geocodeAddress(c.address).catch(() => null);
      const prev = cache.get(c.id);
      const attempts = (prev?.attempts ?? 0) + 1;
      cache.set(c.id, { lat: coords?.lat ?? null, lng: coords?.lng ?? null, attempts });
      await pool.query(
        `INSERT INTO crm_customer_geocode (customer_id, lat, lng, attempts, last_attempt_at)
         VALUES ($1, $2, $3, 1, NOW())
         ON CONFLICT (customer_id) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
             attempts = crm_customer_geocode.attempts + 1,
             last_attempt_at = NOW()`,
        [c.id, coords?.lat ?? null, coords?.lng ?? null]
      );
      geocoded++;
      await new Promise((r) => setTimeout(r, 150));
    }

    const visitMap = await loadVisitNameCounts();
    let failedCount = 0;
    let pendingCount = 0;
    const list = customers.rows.map((c) => {
      const geo = cache.get(c.id);
      const lat = geo?.lat ?? null;
      const lng = geo?.lng ?? null;
      if (lat == null) {
        if ((geo?.attempts ?? 0) >= MAX_GEOCODE_ATTEMPTS) failedCount++;
        else pendingCount++;
      }
      return {
        name: c.name,
        address: c.address,
        region: c.region,
        follow_status: c.follow_status,
        owner_name: c.owner_name,
        is_in_pool: c.is_in_pool,
        visit_count: visitMap.get(c.name_norm)?.count ?? 0,
        lat,
        lng,
      };
    });
    res.json({ total: list.length, geocoded_new: geocoded, failed_count: failedCount, pending_count: pendingCount, list });
  } catch (err) {
    console.error("crm-analytics/opportunity-map error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/stuck —— 审批卡死 + 躺尸客户清单
router.get("/stuck", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const visibleNames = await getVisibleUserNames(req);

    // 拜访信号：visits 客户名归并（精确 + 规则归并，与 cross 同口径）到 CRM name_norm → 最近拜访时间。
    // 待确认（归并失败）的名字不影响已有客户判定。一次性全表扫描，不逐客户查 SQL。
    const [lastTimes, allCrm] = await Promise.all([
      loadVisitNameLastTimes(),
      pool.query<{ name_norm: string }>(
        `SELECT DISTINCT name_norm FROM crm_customers WHERE name_norm IS NOT NULL AND name_norm <> ''`
      ),
    ]);
    const crmNorms = allCrm.rows.map((r) => r.name_norm);
    const crmNormSet = new Set(crmNorms);
    const lastVisitByCrm = new Map<string, Date>();
    for (const [norm, ts] of lastTimes) {
      const target = resolveCrmName(norm, crmNormSet, crmNorms);
      if (!target) continue;
      const prev = lastVisitByCrm.get(target);
      if (!prev || ts > prev) lastVisitByCrm.set(target, ts);
    }

    // 审批卡死：审批中且创建时间超过 7 天
    const whereA: string[] = ["process_status = '审批中'", "created_time < NOW() - INTERVAL '7 days'"];
    const paramsA: unknown[] = [];
    appendOwnerFilter(whereA, paramsA, visibleNames, "owner_name");
    const approvals = await pool.query<{
      id: string; name: string; name_norm: string; owner_name: string | null; process_status: string; days: string;
    }>(
      `SELECT id, name, name_norm, owner_name, process_status,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - created_time)) / 86400)::text AS days
       FROM crm_customers WHERE ${whereA.join(" AND ")}`,
      paramsA
    );

    // 躺尸：私海且（从未跟进 或 最近跟进早于 30 天前），且近 30 天无实际拜访
    const whereZ: string[] = [
      "is_in_pool = false",
      "(follow_times = 0 OR latest_follow_up_time < NOW() - INTERVAL '30 days')",
    ];
    const paramsZ: unknown[] = [];
    appendOwnerFilter(whereZ, paramsZ, visibleNames, "owner_name");
    const zombies = await pool.query<{
      id: string; name: string; name_norm: string; owner_name: string | null; follow_status: string | null; days: string;
    }>(
      `SELECT id, name, name_norm, owner_name, follow_status,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(latest_follow_up_time, created_time))) / 86400)::text AS days
       FROM crm_customers WHERE ${whereZ.join(" AND ")}`,
      paramsZ
    );

    // 近 30 天有拜访（归并口径）的客户不算躺尸
    const visitCutoff = Date.now() - 30 * 86400 * 1000;
    const zombieRows = zombies.rows.filter((r) => {
      const lv = lastVisitByCrm.get(r.name_norm);
      return !lv || lv.getTime() < visitCutoff;
    });

    interface StuckItem {
      kind: "approval_stuck" | "zombie";
      customer_id: string;
      customer_name: string;
      owner_name: string | null;
      status: string | null;
      days: number;
      last_visit_time: string | null;
    }
    const items: StuckItem[] = [
      ...approvals.rows.map((r) => ({
        kind: "approval_stuck" as const,
        customer_id: r.id,
        customer_name: r.name,
        owner_name: r.owner_name,
        status: r.process_status,
        days: parseInt(r.days, 10),
        last_visit_time: lastVisitByCrm.get(r.name_norm)?.toISOString() ?? null,
      })),
      ...zombieRows.map((r) => ({
        kind: "zombie" as const,
        customer_id: r.id,
        customer_name: r.name,
        owner_name: r.owner_name,
        status: r.follow_status,
        days: parseInt(r.days, 10),
        last_visit_time: lastVisitByCrm.get(r.name_norm)?.toISOString() ?? null,
      })),
    ];
    items.sort((a, b) => b.days - a.days);

    const kindFilter = String(req.query.kind || "");
    const filtered = kindFilter ? items.filter((it) => it.kind === kindFilter) : items;
    const { pageSize, offset } = pageParams(req);
    res.json({
      approval_stuck_count: approvals.rows.length,
      zombie_count: zombieRows.length,
      total: filtered.length,
      list: filtered.slice(offset, offset + pageSize),
    });
  } catch (err) {
    console.error("crm-analytics/stuck error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/overview —— 总览数字（聚合口径，登录角色全量可见）
router.get("/overview", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query<{
      total: string; pool_count: string; private_count: string;
      unfollowed: string; approving: string; new_30d: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE is_in_pool)::text AS pool_count,
         COUNT(*) FILTER (WHERE NOT is_in_pool)::text AS private_count,
         COUNT(*) FILTER (WHERE follow_times = 0)::text AS unfollowed,
         COUNT(*) FILTER (WHERE process_status = '审批中')::text AS approving,
         COUNT(*) FILTER (WHERE created_time >= NOW() - INTERVAL '30 days')::text AS new_30d
       FROM crm_customers`
    );
    const byType = await pool.query<{ customer_type: string; n: string }>(
      `SELECT customer_type, COUNT(*)::text AS n FROM crm_customers GROUP BY customer_type`
    );
    // CRM 数据快照日期：最近一次手工导入批次时间（crm_import_batches.created_at）
    const snapshot = await pool.query<{ ts: Date | null }>(
      `SELECT MAX(created_at) AS ts FROM crm_import_batches`
    );
    const row = result.rows[0];
    const total = parseInt(row.total, 10);
    const unfollowed = parseInt(row.unfollowed, 10);
    const byTypeMap: Record<string, number> = {};
    for (const r of byType.rows) byTypeMap[r.customer_type] = parseInt(r.n, 10);
    res.json({
      total,
      pool_count: parseInt(row.pool_count, 10),
      private_count: parseInt(row.private_count, 10),
      by_type: byTypeMap,
      unfollowed_count: unfollowed,
      unfollowed_ratio: total > 0 ? +(unfollowed / total).toFixed(4) : 0,
      approving_count: parseInt(row.approving, 10),
      new_30d_count: parseInt(row.new_30d, 10),
      snapshot_date: snapshot.rows[0]?.ts ? formatBeijingDate(snapshot.rows[0].ts) : null,
    });
  } catch (err) {
    console.error("crm-analytics/overview error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/recovery-list —— 公海挽回清单（公海 + 高阶段客户明细，仅 admin）
router.get("/recovery-list", authMiddleware, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  try {
    const { pageSize, offset } = pageParams(req);
    const result = await queryRecoveryList({
      stage: String(req.query.stage || "") || undefined,
      owner: String(req.query.owner || "") || undefined,
      offset,
      limit: pageSize,
    });
    res.json(result);
  } catch (err) {
    console.error("crm-analytics/recovery-list error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/pool-health —— 私海健康度（按负责人汇总，聚合口径登录可见）
router.get("/pool-health", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    res.json(await queryPoolHealth());
  } catch (err) {
    console.error("crm-analytics/pool-health error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /crm-analytics/funnel —— 阶段漏斗（follow_status 分组计数 × 公私海，聚合口径登录可见）
router.get("/funnel", authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    res.json(await queryFunnel());
  } catch (err) {
    console.error("crm-analytics/funnel error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST /crm-analytics/digest/send —— 手动触发 CRM 周报推送（仅 admin，接收人由 CRM_DIGEST_RECIPIENTS 配置）
router.post("/digest/send", authMiddleware, requireRole("admin"), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await sendCrmDigest();
    res.json(result);
  } catch (err: any) {
    console.error("crm-analytics/digest/send error:", err);
    res.status(500).json({ error: err?.message || "Send failed" });
  }
});

export default router;
