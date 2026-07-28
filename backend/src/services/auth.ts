import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { pool } from "../db";
import { User } from "../types";

export interface AuthRequest extends Request {
  currentUser?: User;
}

/** session 有效期：7 天 */
const SESSION_TTL_DAYS = 7;

/** 签发登录 session，返回 token */
export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO auth_sessions (token, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${SESSION_TTL_DAYS} days')`,
    [token, userId]
  );
  return token;
}

/** 按 token 解析用户（未过期才有效），并惰性清理过期 session */
export async function resolveToken(token: string): Promise<User | null> {
  // 惰性清理过期 session，避免表无限膨胀
  pool.query(`DELETE FROM auth_sessions WHERE expires_at < NOW()`).catch(() => {});

  const result = await pool.query<User>(
    `SELECT u.* FROM auth_sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.token = $1 AND s.expires_at >= NOW()
     LIMIT 1`,
    [token]
  );
  return result.rows[0] || null;
}

/** 删除 session（退出登录，幂等） */
export async function deleteSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM auth_sessions WHERE token = $1`, [token]);
}

/** 从 Authorization: Bearer <token> 中提取 token */
function extractBearerToken(req: Request): string | null {
  const raw = req.headers["authorization"];
  if (!raw || !raw.startsWith("Bearer ")) return null;
  return raw.slice("Bearer ".length).trim() || null;
}

function extractUserId(req: AuthRequest): string | null {
  const raw = req.headers["x-user-id"] as string | undefined;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 旧的 X-User-Id 信任头：仅作本地开发过渡。
 * 生产环境必须保持 AUTH_HEADER_FALLBACK 未设置（关闭），否则任何人都能伪造身份。
 */
function isHeaderFallbackEnabled(): boolean {
  return process.env.AUTH_HEADER_FALLBACK === "true";
}

async function findUserByUserId(userId: string): Promise<User | null> {
  const result = await pool.query<User>(
    `SELECT * FROM users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function getCurrentUser(req: AuthRequest): Promise<User | null> {
  try {
    // 优先 Bearer token（真实登录 session）
    const token = extractBearerToken(req);
    if (token) {
      return await resolveToken(token);
    }
    // 过渡回退：X-User-Id（需显式开启）
    if (isHeaderFallbackEnabled()) {
      const userId = extractUserId(req);
      if (userId) {
        return await findUserByUserId(userId);
      }
    }
    return null;
  } catch (err) {
    console.error("getCurrentUser error:", err);
    return null;
  }
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 优先 Bearer token（真实登录 session）
    const token = extractBearerToken(req);
    if (token) {
      const user = await resolveToken(token);
      if (!user) {
        res.status(401).json({ error: "登录已过期，请重新登录" });
        return;
      }
      req.currentUser = user;
      next();
      return;
    }

    // 过渡回退：X-User-Id（需显式开启，生产必须关闭）
    if (isHeaderFallbackEnabled()) {
      const userId = extractUserId(req);
      if (userId) {
        const user = await findUserByUserId(userId);
        if (!user) {
          res.status(401).json({ error: "User not found" });
          return;
        }
        req.currentUser = user;
        next();
        return;
      }
    }

    res.status(401).json({ error: "未登录" });
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Auth error" });
  }
}

export function requireRole(...roles: User["role"][]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.currentUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export async function getSubordinateUserIds(managerId: number): Promise<string[]> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM users WHERE manager_id = $1`,
    [managerId]
  );
  return result.rows.map((r) => r.user_id);
}

export async function isSubordinate(
  userId: string,
  managerId: number
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM users WHERE user_id = $1 AND manager_id = $2 LIMIT 1`,
    [userId, managerId]
  );
  return result.rows.length > 0;
}

export async function canViewFeedback(
  currentUser: User,
  feedbackUserId: string
): Promise<boolean> {
  if (currentUser.role === "admin") return true;
  if (currentUser.role === "manager") {
    return (
      feedbackUserId === currentUser.user_id ||
      (await isSubordinate(feedbackUserId, currentUser.id))
    );
  }
  return feedbackUserId === currentUser.user_id;
}
