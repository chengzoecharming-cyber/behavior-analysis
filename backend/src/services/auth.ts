import { Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { User } from "../types";

export interface AuthRequest extends Request {
  currentUser?: User;
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

export async function getCurrentUser(req: AuthRequest): Promise<User | null> {
  const userId = extractUserId(req);
  if (!userId) return null;
  try {
    const result = await pool.query<User>(
      `SELECT * FROM users WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
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
  const userId = extractUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Missing X-User-Id header" });
    return;
  }

  try {
    const result = await pool.query<User>(
      `SELECT * FROM users WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    req.currentUser = result.rows[0];
    next();
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
