import { pool } from "../db";

// 业务方确认的目标销售部门
export const TARGET_DEPARTMENTS = [
  "华南一部",
  "华东昆山",
  "华东宁波",
  "华北一部",
  "东南一部",
  "海外业务部",
  "软件产品线",
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
 * 2. 销售渠道-前缀 → 单独保留（如销售渠道-华南区域）
 * 3. 销售部-前缀 → 去掉前缀后匹配目标
 * 4. 包含多个目标部门名 → 取最后一个匹配（通常靠后的更具体）
 * 5. 其他 → 保留原样（canonical_name = null 表示待人工确认）
 */
export function inferCanonicalDepartment(raw: string): string | null {
  // 1. 完全匹配
  if (TARGET_DEPARTMENTS.includes(raw)) return raw;

  // 2. 销售渠道-前缀：单独保留
  if (raw.startsWith("销售渠道-")) return raw;

  // 3. 销售部-前缀
  if (raw.startsWith("销售部-")) {
    const suffix = raw.slice("销售部-".length);
    if (TARGET_DEPARTMENTS.includes(suffix)) return suffix;
  }

  // 4. 包含目标部门名，取最后一个匹配
  let lastMatch: string | null = null;
  for (const dept of TARGET_DEPARTMENTS) {
    if (raw.includes(dept)) {
      lastMatch = dept;
    }
  }
  if (lastMatch) return lastMatch;

  // 5. 无法推断，留空待确认
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
