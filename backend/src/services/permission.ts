import { User } from "../types";
import { getUserIdsUnderNode } from "./orgService";
import { getAllConfiguredLeaderIds, getConfiguredLeaderIds } from "./leaderConfig";
import { pool } from "../db";

/**
 * 权限收口：按角色计算数据可见范围
 *
 * 口径（已确认）：
 * - admin：返回 null，表示不过滤（全部数据）。
 * - manager（区总/部门负责人）：可见范围由 users.department 自动决定——
 *   '销售部' → 整个部门含子部门；'销售部-华东昆山' → 仅该子部门；
 *   department 为空时仅自己。始终 ∪ 自己 ∪ (全部 admin − 嵌入式 leader admin)。
 * - staff：自己 ∪ (全部 admin − 嵌入式 leader admin) ∪ 本区 leader（见 getDistrictLeaderIds）。
 *   普通成员之间互不可见，区总（manager）之间互不可见。
 * - 「管理相对透明」：role='admin' 的用户数据默认对全员可见（含离职者的历史数据），
 *   但被 REPORT_DEPT_LEADERS 配置为子部门/部门 leader 的 admin（如李朝晖=华南一部）除外——
 *   他们按 leader 处理，数据仅本区下属与 admin 可见。
 */

/** 全部 admin 的 user_id（admin 数据对全员可见，不按 is_resigned 过滤） */
async function getAdminUserIds(): Promise<string[]> {
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM users WHERE role = 'admin'`
  );
  return res.rows.map((r) => r.user_id);
}

/**
 * 嵌入式 leader admin：被 REPORT_DEPT_LEADERS 配置为 leader 且 role='admin' 的用户。
 * 他们从「admin 全员可见」名单中剔除，仅本区下属（leader 身份）与 admin 可见。
 */
async function getEmbeddedLeaderAdminIds(): Promise<string[]> {
  const leaderIds = await getAllConfiguredLeaderIds();
  if (leaderIds.length === 0) return [];
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM users WHERE role = 'admin' AND user_id = ANY($1::text[])`,
    [leaderIds]
  );
  return res.rows.map((r) => r.user_id);
}

/** 全员可见的 admin = 全部 admin − 嵌入式 leader admin */
async function getPublicAdminUserIds(): Promise<string[]> {
  const [admins, embedded] = await Promise.all([
    getAdminUserIds(),
    getEmbeddedLeaderAdminIds(),
  ]);
  if (embedded.length === 0) return admins;
  const embeddedSet = new Set(embedded);
  return admins.filter((id) => !embeddedSet.has(id));
}

/**
 * staff 所在「销售部-X」区的区总（本区 leader）：
 * - 部门第一段必须以 '销售部-' 开头（销售渠道等其他部门不参与，'销售部' 本级无区总概念）；
 * - REPORT_DEPT_LEADERS 配了该子部门就以配置为准（如华南一部:李朝晖，他是 admin 也按 leader 处理）；
 * - 未配置回退「恰好 1 个 role='manager'」规则，0 个或多个（含离职未清理的）都无区总；
 * - manager 回退不按 is_resigned 过滤（离职区总的历史数据组员仍可看）。
 * 运维约定：未配置的子部门换区总时需把旧区总 role 改回 staff，否则该区 2 个 manager 会导致全组退回只看自己。
 */
export async function getDistrictLeaderIds(user: User): Promise<string[]> {
  const dept = (user.department || "").split(",")[0].trim();
  if (!dept.startsWith("销售部-")) return [];

  const shortName = dept.split("-").slice(1).join("-");
  const configured = await getConfiguredLeaderIds(shortName, dept);
  if (configured.length > 0) return configured;

  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM users
     WHERE role = 'manager'
       AND btrim(split_part(COALESCE(department, ''), ',', 1)) = $1`,
    [dept]
  );
  return res.rows.length === 1 ? [res.rows[0].user_id] : [];
}

/** 返回 null 表示不过滤（admin）；否则为可见 user_id 列表 */
export async function getVisibleUserIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const publicAdmins = await getPublicAdminUserIds();
  if (user.role === "manager") {
    const under = user.department
      ? await getUserIdsUnderNode(user.department)
      : [];
    return Array.from(new Set([user.user_id, ...under, ...publicAdmins]));
  }
  const districtLeaders = await getDistrictLeaderIds(user);
  return Array.from(
    new Set([user.user_id, ...publicAdmins, ...districtLeaders])
  );
}

/** 是否可查看指定成员的数据 */
export async function canViewUser(user: User, targetUserId: string): Promise<boolean> {
  const visible = await getVisibleUserIds(user);
  return visible === null || visible.includes(targetUserId);
}

/**
 * scope/node 类接口的范围收敛：manager/staff 请求超出自己范围的 node 时，
 * 收敛到自己的 department；返回调整后的 node（null 表示无部门可收敛，调用方应只给本人数据）。
 */
export function clampNodeForUser(user: User, node: string | undefined): string | null {
  if (user.role === "admin") return node ?? null;
  const dept = (user.department || "").split(",")[0].trim();
  if (!dept) return null; // 无部门：只能看自己
  // 请求的 node 在自己范围内（等于自己部门或是其子节点）则保留，否则收敛到自己部门
  if (node && (node === dept || node.startsWith(`${dept}-`))) return node;
  return dept;
}

/** 取用户部门的一级段（'销售部-华东昆山' → '销售部'） */
export function topDepartmentOf(user: User): string | null {
  const primary = (user.department || "").split(",")[0].trim();
  if (!primary) return null;
  return primary.split("-")[0].trim() || null;
}

/** node（'销售部-华东昆山' 形式）是否在当前用户的管辖范围内 */
export function isNodeInRange(user: User, node: string): boolean {
  if (user.role === "admin") return true;
  const dept = (user.department || "").split(",")[0].trim();
  if (!dept) return false;
  return node === dept || node.startsWith(`${dept}-`);
}

/** 统一的越权响应 */
export const FORBIDDEN_MESSAGE = "无权查看该成员数据";
