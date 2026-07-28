import { Router, Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../db";
import { createSession, deleteSession } from "../services/auth";
import {
  getDingTalkConfig,
  getLoginAuthorizeUrl,
  getUserAccessToken,
  getUserIdByUnionId,
  getUserMeByUserToken,
} from "../services/dingtalk";

const router = Router();

const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "admin123";

/** state 有效期 10 分钟（单进程内存存储够用） */
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, number>();

function createState(): string {
  const state = crypto.randomBytes(16).toString("hex");
  // 顺手清理过期 state
  const now = Date.now();
  for (const [s, ts] of pendingStates) {
    if (now - ts > STATE_TTL_MS) pendingStates.delete(s);
  }
  pendingStates.set(state, now);
  return state;
}

/** 校验并消费 state（一次性） */
function consumeState(state: string): boolean {
  const ts = pendingStates.get(state);
  if (ts === undefined) return false;
  pendingStates.delete(state);
  return Date.now() - ts <= STATE_TTL_MS;
}

/** 扫码登录回调 origin 白名单（防止重定向到任意外部域名） */
function getAllowedOrigins(): string[] {
  return (
    process.env.DINGTALK_LOGIN_ALLOWED_ORIGINS ||
    "http://localhost:5173,http://8.219.97.3:5173"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface SessionUserPayload {
  user_id: string;
  user_name: string;
  department: string | null;
  role: string;
}

/** 签发 session 并返回统一结构 */
async function issueSession(res: Response, user: SessionUserPayload): Promise<void> {
  const token = await createSession(user.user_id);
  res.json({ token, user });
}

// GET /auth/dingtalk/authorize-url?origin=<前端origin>
// 返回钉钉扫码授权页 URL，前端直接跳转
router.get("/dingtalk/authorize-url", (req: Request, res: Response) => {
  const cfg = getDingTalkConfig();
  if (!cfg.appKey || !cfg.appSecret) {
    res.status(500).json({ error: "钉钉登录未配置" });
    return;
  }

  const origin = String(req.query.origin || "");
  if (!getAllowedOrigins().includes(origin)) {
    res.status(400).json({ error: "不允许的回调来源" });
    return;
  }

  const state = createState();
  const redirectUri = `${origin}/login/callback`;
  res.json({ url: getLoginAuthorizeUrl(redirectUri, state) });
});

// POST /auth/dingtalk/callback { authCode, state }
// 扫码回调：authCode → 用户 token → unionId → 企业 userid → 查 users 签发 session
router.post("/dingtalk/callback", async (req: Request, res: Response) => {
  const { authCode, state } = req.body || {};
  if (!authCode || !state) {
    res.status(400).json({ error: "缺少 authCode 或 state" });
    return;
  }
  if (!consumeState(String(state))) {
    res.status(400).json({ error: "登录状态已过期，请重新扫码" });
    return;
  }

  try {
    const userToken = await getUserAccessToken(String(authCode));
    const me = await getUserMeByUserToken(userToken);
    const dingtalkUserId = await getUserIdByUnionId(me.unionId);

    const result = await pool.query(
      `SELECT user_id, user_name, department, role, is_resigned, is_invalid
       FROM users WHERE user_id = $1 LIMIT 1`,
      [dingtalkUserId]
    );

    if (result.rows.length === 0) {
      // 有外勤数据的人会在每日对账后自动进入 users 表
      res.status(403).json({ error: "无系统访问权限，请联系管理员" });
      return;
    }

    const user = result.rows[0];
    if (user.is_resigned) {
      res.status(403).json({ error: "账号已停用" });
      return;
    }
    if (user.is_invalid) {
      res.status(403).json({ error: "无系统访问权限，请联系管理员" });
      return;
    }

    await issueSession(res, {
      user_id: user.user_id,
      user_name: user.user_name,
      department: user.department,
      role: user.role,
    });
  } catch (err: any) {
    console.error("DingTalk login callback failed:", err);
    res.status(502).json({ error: `钉钉登录失败: ${err.message}` });
  }
});

// POST /auth/login
// 应急密码登录通道（管理员），默认关闭，需 AUTH_PASSWORD_LOGIN_ENABLED=true
router.post("/login", async (req: Request, res: Response) => {
  if (process.env.AUTH_PASSWORD_LOGIN_ENABLED !== "true") {
    res.status(403).json({ error: "密码登录未启用" });
    return;
  }

  const { username, password } = req.body;

  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT user_id, user_name, department, role
       FROM users
       WHERE user_id = $1
       LIMIT 1`,
      [AUTH_USERNAME]
    );

    if (result.rows.length === 0) {
      res.status(500).json({ error: "默认管理员用户不存在" });
      return;
    }

    await issueSession(res, result.rows[0]);
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "登录失败" });
  }
});

// POST /auth/logout
// 删除当前 session（幂等）
router.post("/logout", async (req: Request, res: Response) => {
  const raw = req.headers["authorization"];
  const token = raw?.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : null;
  if (token) {
    try {
      await deleteSession(token);
    } catch (err) {
      console.error("Logout failed:", err);
    }
  }
  res.json({ success: true });
});

export default router;
