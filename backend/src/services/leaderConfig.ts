import { pool } from "../db";
import { OrgTreeNode } from "./orgService";

/**
 * 区总/负责人统一配置（日报推送接收人 + 控制台「员工可看上级」权限共用）。
 *
 * REPORT_DEPT_LEADERS 格式：华南一部:李朝晖;华东昆山:季昕亚;软件产品线:洪晨备
 * - key 匹配子部门/部门的 shortName 或全名（另支持「公司」作为全公司级接收人）；
 * - value 为钉钉姓名（users.user_name → 通讯录 dingtalk_users → 直接配 userid），逗号分隔多人；
 * - 某子部门/部门一旦配置即以配置为准，未配置的回退为 role=manager 的用户。
 */

/** 解析 leader 配置为 Map<部门key, 姓名/userid 列表> */
export function parseDeptLeaderNames(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const raw = process.env.REPORT_DEPT_LEADERS || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const dept = part.slice(0, idx).trim();
    const names = part
      .slice(idx + 1)
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (dept && names.length > 0) map.set(dept, names);
  }
  return map;
}

/** 配置的负责人标识解析成钉钉 userid：users 姓名 → 通讯录姓名（精确/前缀唯一）→ 视为 userid */
export async function resolveLeaderUserIds(names: string[]): Promise<string[]> {
  const ids = new Set<string>();
  if (names.length === 0) return [];
  const userRows = (
    await pool.query(
      // 排除 is_invalid 隐藏账号（如同名脏数据「陈盐」会被重复解析成 2 个接收人）
      `SELECT user_id, user_name FROM users WHERE user_name = ANY($1::text[]) AND NOT is_invalid`,
      [names]
    )
  ).rows;
  const found = new Set(userRows.map((r) => r.user_name));
  for (const r of userRows) ids.add(r.user_id);

  for (const name of names.filter((n) => !found.has(n))) {
    // 通讯录缓存兜底（如洪晨备不在 users 表，从未产生签到数据）
    const rows = (
      await pool.query(
        `SELECT userid, name FROM dingtalk_users WHERE name LIKE $1 ORDER BY name LIMIT 3`,
        [`${name}%`]
      )
    ).rows;
    const exact = rows.find((r) => r.name === name);
    if (exact) {
      ids.add(exact.userid);
    } else if (rows.length === 1) {
      ids.add(rows[0].userid);
    } else if (/^[0-9A-Za-z_-]{6,}$/.test(name)) {
      ids.add(name); // 配置里直接写的钉钉 userid
    } else {
      console.warn(`[Leader Config] 负责人姓名未匹配到用户: ${name}`);
    }
  }
  return Array.from(ids);
}

/** 某部门/子部门配置了的 leader（shortName 与全名两种 key 都认）；未配置返回 [] */
export async function getConfiguredLeaderIds(
  shortName: string,
  fullName: string
): Promise<string[]> {
  const leaderMap = parseDeptLeaderNames();
  const names = [
    ...new Set([
      ...(leaderMap.get(shortName) || []),
      ...(leaderMap.get(fullName) || []),
    ]),
  ];
  return resolveLeaderUserIds(names);
}

/** 配置里全部 leader 的 userid（用于权限模块识别「嵌入式 leader admin」） */
export async function getAllConfiguredLeaderIds(): Promise<string[]> {
  const leaderMap = parseDeptLeaderNames();
  const names = [...new Set([...leaderMap.values()].flat())];
  return resolveLeaderUserIds(names);
}

/** 区总：REPORT_DEPT_LEADERS 配了该子部门就用配置（精确控制），否则回退到子部门 role=manager */
export async function getSubDeptLeaderIds(
  dept: OrgTreeNode,
  sub: OrgTreeNode
): Promise<string[]> {
  const configured = await getConfiguredLeaderIds(sub.shortName, sub.name);
  if (configured.length > 0) return configured;

  const ids = new Set<string>();
  const mgr = await pool.query(
    `SELECT user_id FROM users
     WHERE department = $1 AND role = 'manager' AND NOT is_resigned AND NOT is_invalid`,
    [sub.name]
  );
  for (const r of mgr.rows) ids.add(r.user_id);
  return Array.from(ids);
}

/** 部门负责人：REPORT_DEPT_LEADERS 配了该部门就用配置，否则回退到部门 role=manager */
export async function getDeptLeaderIds(dept: OrgTreeNode): Promise<string[]> {
  const configured = await getConfiguredLeaderIds(dept.shortName, dept.name);
  if (configured.length > 0) return configured;

  const ids = new Set<string>();
  const mgr = await pool.query(
    `SELECT user_id FROM users
     WHERE department = $1 AND role = 'manager' AND NOT is_resigned AND NOT is_invalid`,
    [dept.name]
  );
  for (const r of mgr.rows) ids.add(r.user_id);
  return Array.from(ids);
}

/** 公司级接收人：REPORT_DEPT_LEADERS 中「公司」的配置 */
export async function getCompanyLeaderIds(): Promise<string[]> {
  const leaderMap = parseDeptLeaderNames();
  return resolveLeaderUserIds([...new Set([...(leaderMap.get("公司") || [])])]);
}
