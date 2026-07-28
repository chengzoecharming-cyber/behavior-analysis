import { User } from "../types";
import { getUserIdsUnderNode } from "./orgService";

/**
 * 权限收口：按角色计算数据可见范围
 *
 * 口径（已确认）：
 * - admin：返回 null，表示不过滤（全部数据）
 * - manager（Leader）：可见范围由 users.department 自动决定——
 *   '销售部' → 整个部门含子部门；'销售部-华东昆山' → 仅该子部门；
 *   department 为空时仅自己。始终 ∪ 自己。
 * - staff：仅自己
 */

/** 返回 null 表示不过滤（admin）；否则为可见 user_id 列表 */
export async function getVisibleUserIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;
  if (user.role === "manager") {
    const under = user.department
      ? await getUserIdsUnderNode(user.department)
      : [];
    return Array.from(new Set([user.user_id, ...under]));
  }
  return [user.user_id];
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
