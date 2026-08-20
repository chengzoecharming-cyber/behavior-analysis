import { pool } from "../db";

// 业务方确认的目标销售部门（以钉钉通讯录「销售部」下子部门为准）
export const TARGET_DEPARTMENTS = [
  "华南一部",
  "华东昆山",
  "华东宁波",
  "华北一部",
  "新品业务部",
  "软件业务部",
  "海外业务部",
];

/**
 * 根据原始 department 字符串返回规范部门名称。
 * 优先查 department_aliases 表；未命中时按规则推断。
 */
export async function getCanonicalDepartment(
  raw: string | null
): Promise<string | null> {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const cached = await getAliasFromDB(trimmed);
  if (cached !== undefined) return cached;

  // 首次遇到：按规则推断并写入表
  const inferred = inferCanonicalDepartment(trimmed);
  await saveAlias(trimmed, inferred, "inferred");
  return inferred;
}

async function getAliasFromDB(
  alias: string
): Promise<string | undefined | null> {
  const result = await pool.query(
    `SELECT canonical_name FROM department_aliases WHERE alias = $1`,
    [alias]
  );
  if (result.rows.length === 0) return undefined;
  return result.rows[0].canonical_name;
}

async function saveAlias(
  alias: string,
  canonicalName: string | null,
  source: string
): Promise<void> {
  await pool.query(
    `INSERT INTO department_aliases (alias, canonical_name, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (alias) DO UPDATE SET
       canonical_name = EXCLUDED.canonical_name,
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [alias, canonicalName, source]
  );
}

/**
 * 规则推断：
 * 1. 本身就在目标列表中 → 原样
 * 2. 销售部-前缀 → 去掉前缀后匹配目标
 * 3. 包含多个目标部门名 → 取最后一个匹配（通常靠后的更具体）
 * 4. 其他 → 保留原样（canonical_name = null 表示待人工确认）
 */
export function inferCanonicalDepartment(raw: string): string | null {
  // 1. 完全匹配
  if (TARGET_DEPARTMENTS.includes(raw)) return raw;

  // 2. 销售部-前缀
  if (raw.startsWith("销售部-")) {
    const suffix = raw.slice("销售部-".length);
    if (TARGET_DEPARTMENTS.includes(suffix)) return suffix;
  }

  // 3. 包含目标部门名，取最后一个匹配
  let lastMatch: string | null = null;
  for (const dept of TARGET_DEPARTMENTS) {
    if (raw.includes(dept)) {
      lastMatch = dept;
    }
  }
  if (lastMatch) return lastMatch;

  // 4. 无法推断，留空待确认
  return null;
}

/**
 * 扫描 visits 表中所有 department，为每个原始值生成/更新别名映射。
 */
export async function initDepartmentAliases(): Promise<{
  total: number;
  mapped: number;
  pending: number;
}> {
  const result = await pool.query(
    `SELECT DISTINCT department FROM visits WHERE department IS NOT NULL AND department <> ''`
  );

  let mapped = 0;
  let pending = 0;

  for (const row of result.rows) {
    const raw = row.department;
    const canonical = inferCanonicalDepartment(raw);
    await saveAlias(raw, canonical, canonical ? "inferred" : "pending");
    if (canonical) mapped++;
    else pending++;
  }

  return {
    total: result.rows.length,
    mapped,
    pending,
  };
}

/**
 * ============ 查询时部门归一化（组织树/归属/聚合口径用） ============
 *
 * 背景：部分销售在钉钉里挂在「销售渠道-华南区域 / 销售渠道-江苏区域 / 销售渠道-浙江区域」
 * 等顶层部门下，但业务主部门是「销售部-华南一部 / 销售部-华东昆山 / 销售部-华东宁波」。
 * visits.department 保留原始值不改，所有组织归属与聚合在查询时按本模块归一化：
 *
 *   第一段部门名 → department_aliases 命中且 canonical_name 非空
 *     → canonical 本身含 "-" 则取 canonical，否则取 "销售部-" + canonical
 *   未命中 → 保持原始第一段
 *
 * 因此「销售渠道-华南区域 → 华南一部」这类别名一配置即全链路生效，无需回填数据。
 * 注意：canonical_name 的语义仍是短名（如「华南一部」），归一化出的组织路径才是
 * 「销售部-华南一部」，与 orgService 的节点路径口径一致。
 */

/** 加载全部别名映射（alias → canonical_name），供 JS 侧批量归一化 */
export async function loadDepartmentAliasMap(): Promise<Map<string, string | null>> {
  const result = await pool.query(
    `SELECT alias, canonical_name FROM department_aliases`
  );
  return new Map(
    result.rows.map((r) => [String(r.alias), r.canonical_name as string | null])
  );
}

/**
 * JS 侧归一化主部门路径（与 normalizedPrimaryDeptSql 口径一致）。
 * primary 为 department 的第一段（逗号前）， aliasMap 来自 loadDepartmentAliasMap。
 * 会先按完整第一段查别名，未命中再按 "-" 后的末段查（兼容「江苏区域」这类短别名）。
 */
export function normalizePrimaryDepartment(
  primary: string,
  aliasMap: Map<string, string | null>
): string {
  const trimmed = primary.trim();
  if (!trimmed) return trimmed;
  let canonical = aliasMap.get(trimmed);
  if (canonical === undefined && trimmed.includes("-")) {
    canonical = aliasMap.get(trimmed.split("-").slice(1).join("-"));
  }
  if (canonical === undefined || canonical === null || canonical === "") {
    return trimmed;
  }
  return canonical.includes("-") ? canonical : `销售部-${canonical}`;
}

/**
 * SQL 侧归一化表达式：把 visits 的 department 第一段归一化为组织路径。
 * 需配合 departmentAliasJoinSql 使用（JOIN 别名固定为 da）。
 * @param column department 列引用，如 "department" 或 "v.department"
 */
export function normalizedPrimaryDeptSql(column = "department"): string {
  const firstSegment = `SPLIT_PART(${column}, ',', 1)`;
  return `COALESCE(
    CASE WHEN da.canonical_name IS NOT NULL AND da.canonical_name <> '' THEN
      CASE WHEN POSITION('-' IN da.canonical_name) > 0
           THEN da.canonical_name
           ELSE '销售部-' || da.canonical_name
      END
    END,
    ${firstSegment}
  )`;
}

/** SQL 侧别名 JOIN 片段（与 normalizedPrimaryDeptSql 配套，别名固定 da） */
export function departmentAliasJoinSql(column = "department"): string {
  return `LEFT JOIN department_aliases da ON da.alias = SPLIT_PART(${column}, ',', 1)`;
}

/**
 * 更新单条映射（供管理接口使用）。
 */
export async function updateDepartmentAlias(
  alias: string,
  canonicalName: string | null
): Promise<void> {
  await saveAlias(alias, canonicalName, "manual");
}

/**
 * 获取所有映射（供管理界面使用）。
 */
export async function listDepartmentAliases(): Promise<
  { alias: string; canonical_name: string | null; source: string }[]
> {
  const result = await pool.query(
    `SELECT alias, canonical_name, source
     FROM department_aliases
     ORDER BY canonical_name NULLS LAST, alias`
  );
  return result.rows;
}
