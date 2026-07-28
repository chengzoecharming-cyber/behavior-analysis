import { pool } from "../db";
import { syncContacts } from "./dingtalk";

/**
 * 用户同步对账服务
 *
 * 口径：只纳入「有外勤签到数据的人」（visits 表中出现过的 user_id），
 * 与控制台级联选择器同源；无外勤数据的钉钉通讯录成员不进入系统。
 *
 * 对账规则：
 * - visits 中的人不在 users 表 → 插入（姓名取最近一次签到、部门取最常出现的 primary department、role=staff）
 * - visits 中的人已在 users 表 → 只更新姓名/部门，不覆盖 role（角色只由管理员手工指定）
 * - 部门白名单：一级部门不在 DEPARTMENT_WHITELIST 的人不新增；已在 users 表中的非 admin 置
 *   is_invalid=true。admin 不受白名单影响（管理员可能不在业务部门）。
 *   注意：对账**只置位、永不自动恢复** is_invalid——恢复只能由管理员手工操作。
 *   （教训：白色帝豪/蓝黑帝豪是车辆数据误导入的"人"，有真实签到且在白名单部门内，
 *    若允许自动恢复，每晚对账都会把管理员手工隐藏的账号翻回来。）
 * - 仅当本次成功执行过通讯录同步：users 中 role IN ('staff','manager') 且不在 dingtalk_users 中的人标离职；
 *   重新出现在通讯录的人自动恢复在职。admin 永不自动改 is_resigned（防误锁）。
 * - 防误伤：最近 30 天内有 visits 记录的人，即使不在通讯录快照里也不自动标离职
 *   （在职的人一定还在跑外勤；可能因通讯录可见范围缺失等原因漏同步），列入 skippedRecentActive 供人工复核。
 */

/**
 * 部门白名单：只纳入这三个一级部门的外勤人员。
 * 业务背景：系统只服务业务条线（销售/供应链/产品），其他部门（如销售渠道、财务、研发等）
 * 即使有零星签到数据也不进入用户管理；判断口径为 primary department 的第一个「-」分段。
 */
const DEPARTMENT_WHITELIST = new Set(["供应链管理部", "销售部", "产品部"]);

/** 近期活跃保护窗口：近 N 天有 visits 记录的人不自动标离职 */
const RECENT_ACTIVE_DAYS = 30;

/** 取部门字符串的一级段（与 visits.department「部门-子部门」格式一致，多部门取逗号第一段） */
function topDepartment(dept: string | null): string | null {
  const primary = (dept || "").split(",")[0].trim();
  if (!primary) return null;
  return primary.split("-")[0].trim() || null;
}

/** 一级部门是否在白名单内 */
function isInWhitelist(dept: string | null): boolean {
  const top = topDepartment(dept);
  return top !== null && DEPARTMENT_WHITELIST.has(top);
}

export interface ReconcileResult {
  /** 新插入的用户（"姓名(user_id)"） */
  added: string[];
  /** 更新姓名/部门的用户数 */
  updated: number;
  /** 本次标记离职的用户 */
  resigned: string[];
  /** 本次恢复在职的用户 */
  restored: string[];
  /** 近期活跃、跳过离职标记的用户（需人工复核） */
  skippedRecentActive: string[];
  /** 本次因部门白名单置 is_invalid 的用户（is_invalid 只置位不自动恢复，见文件头说明） */
  invalidated: string[];
  /** 本次是否成功执行了钉钉通讯录同步（未执行时不做离职标记） */
  contactsSynced: boolean;
  errors: string[];
}

export interface ReconcileOptions {
  /** 跳过通讯录同步，直接用现有 dingtalk_users 快照对账（此时不做离职标记） */
  skipContactsSync?: boolean;
}

/** visits 中每个 user_id 的聚合信息 */
interface VisitUserAgg {
  user_id: string;
  user_name: string | null;
  primary_dept: string | null;
}

interface ExistingUserRow {
  user_id: string;
  user_name: string;
  department: string | null;
  role: string;
  is_resigned: boolean;
  is_invalid: boolean;
}

interface ReconcilePlan {
  added: { user_id: string; user_name: string; department: string | null }[];
  updated: { user_id: string; user_name: string; department: string | null }[];
  resigned: string[];
  restored: string[];
  skippedRecentActive: string[];
  invalidated: string[];
  contactsSynced: boolean;
  errors: string[];
}

/**
 * 从 visits 取每个 user_id 的「最常出现的 primary department」（与 orgService 的
 * user_primary_dept CTE 口径一致：SPLIT_PART(department, ',', 1)，ROW_NUMBER 取 cnt 最大的），
 * 以及最近一次出现的 user_name。
 */
async function fetchVisitUsers(): Promise<VisitUserAgg[]> {
  const result = await pool.query(
    `WITH dept_ranked AS (
       SELECT user_id,
              SPLIT_PART(department, ',', 1) AS primary_dept,
              COUNT(*) AS cnt,
              ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC) AS rn
       FROM visits
       WHERE department IS NOT NULL AND department <> ''
       GROUP BY user_id, SPLIT_PART(department, ',', 1)
     ),
     latest_name AS (
       SELECT DISTINCT ON (user_id) user_id, user_name
       FROM visits
       WHERE user_name IS NOT NULL AND user_name <> ''
       ORDER BY user_id, timestamp DESC
     )
     SELECT v.user_id, n.user_name, d.primary_dept
     FROM (SELECT DISTINCT user_id FROM visits WHERE user_id IS NOT NULL AND user_id <> '') v
     LEFT JOIN latest_name n ON n.user_id = v.user_id
     LEFT JOIN dept_ranked d ON d.user_id = v.user_id AND d.rn = 1`
  );
  return result.rows;
}

/** 计算对账计划（不写库） */
async function computePlan(contactsSynced: boolean, errors: string[]): Promise<ReconcilePlan> {
  // 通讯录快照无论本次是否刷新都可用于姓名解析（离职标记仍要求本次同步成功）
  const [visitUsers, existingUsers, contacts, recentActive] = await Promise.all([
    fetchVisitUsers(),
    pool.query<ExistingUserRow>(
      `SELECT user_id, user_name, department, role, is_resigned, is_invalid FROM users`
    ),
    pool.query(`SELECT userid, name FROM dingtalk_users`),
    // 近期活跃：近 N 天有签到记录的人不自动标离职（防通讯录可见范围缺失等误伤）
    pool.query(
      `SELECT DISTINCT user_id FROM visits
       WHERE business_date >= CURRENT_DATE - INTERVAL '${RECENT_ACTIVE_DAYS} days'`
    ),
  ]);

  const existingMap = new Map(existingUsers.rows.map((u) => [u.user_id, u]));
  const recentActiveIds = new Set(recentActive.rows.map((r) => r.user_id));
  // 姓名取值优先级：钉钉通讯录姓名 > visits 最近一次姓名 > user_id
  // （钉钉审批同步 originator_user_name 为空时 visits.user_name 会写成 userid 数字串，
  //  命中通讯录时用真名修正，存量脏数据在下次对账后自动恢复）
  const contactNameMap = new Map<string, string>(
    contacts.rows
      .filter((r) => r.name && String(r.name).trim() !== "")
      .map((r) => [r.userid as string, String(r.name).trim()])
  );
  const resolveName = (userId: string, visitName: string | null): string =>
    contactNameMap.get(userId) || visitName || userId;

  const plan: ReconcilePlan = {
    added: [],
    updated: [],
    resigned: [],
    restored: [],
    skippedRecentActive: [],
    invalidated: [],
    contactsSynced,
    errors,
  };

  // a/b/c：visits 中的人新增或更新（不覆盖 role）；一级部门不在白名单的人不新增
  for (const vu of visitUsers) {
    const name = resolveName(vu.user_id, vu.user_name);
    const existing = existingMap.get(vu.user_id);
    if (!existing) {
      if (!isInWhitelist(vu.primary_dept)) continue;
      plan.added.push({ user_id: vu.user_id, user_name: name, department: vu.primary_dept });
    } else if (existing.user_name !== name || existing.department !== vu.primary_dept) {
      plan.updated.push({ user_id: vu.user_id, user_name: name, department: vu.primary_dept });
    }
  }

  // e：部门白名单——非 admin 用户一级部门不在白名单则置 is_invalid（只置位，不自动恢复；
  // 恢复只能由管理员手工操作，防止车辆误导入账号这类被手工隐藏的记录每晚被翻回来）。
  // 部门以本次对账更新后的值为准
  const updatedDeptMap = new Map(plan.updated.map((u) => [u.user_id, u.department]));
  for (const u of existingUsers.rows) {
    if (u.role === "admin") continue;
    const effectiveDept = updatedDeptMap.has(u.user_id)
      ? updatedDeptMap.get(u.user_id)!
      : u.department;
    if (!isInWhitelist(effectiveDept) && !u.is_invalid) {
      plan.invalidated.push(`${u.user_name}(${u.user_id})`);
    }
  }

  // d：仅当通讯录同步成功执行过，才做离职标记/恢复；admin 永不自动改
  if (contactsSynced) {
    const contactIds = new Set(contacts.rows.map((r) => r.userid));
    for (const u of existingUsers.rows) {
      if (u.role === "admin") continue;
      const inContacts = contactIds.has(u.user_id);
      if (!inContacts && !u.is_resigned) {
        // 防误伤：近期活跃的人跳过标记，单独列出供人工复核
        if (recentActiveIds.has(u.user_id)) {
          plan.skippedRecentActive.push(`${u.user_name}(${u.user_id})`);
        } else {
          plan.resigned.push(`${u.user_name}(${u.user_id})`);
        }
      } else if (inContacts && u.is_resigned) {
        plan.restored.push(`${u.user_name}(${u.user_id})`);
      }
    }
  }

  return plan;
}

/** 应用对账计划（写库） */
async function applyPlan(plan: ReconcilePlan): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const u of plan.added) {
      await client.query(
        `INSERT INTO users (user_id, user_name, department, role)
         VALUES ($1, $2, $3, 'staff')
         ON CONFLICT (user_id) DO NOTHING`,
        [u.user_id, u.user_name, u.department]
      );
    }

    for (const u of plan.updated) {
      await client.query(
        `UPDATE users SET user_name = $1, department = $2 WHERE user_id = $3`,
        [u.user_name, u.department, u.user_id]
      );
    }

    // resigned / restored 存的是 "姓名(user_id)"，解析出 user_id
    const extractUserId = (label: string) => label.slice(label.lastIndexOf("(") + 1, -1);
    for (const label of plan.resigned) {
      await client.query(
        `UPDATE users SET is_resigned = true WHERE user_id = $1 AND role <> 'admin'`,
        [extractUserId(label)]
      );
    }
    for (const label of plan.restored) {
      await client.query(
        `UPDATE users SET is_resigned = false WHERE user_id = $1 AND role <> 'admin'`,
        [extractUserId(label)]
      );
    }

    // 部门白名单：is_invalid 只置位不自动恢复（admin 不受影响）
    for (const label of plan.invalidated) {
      await client.query(
        `UPDATE users SET is_invalid = true WHERE user_id = $1 AND role <> 'admin'`,
        [extractUserId(label)]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function toResult(plan: ReconcilePlan): ReconcileResult {
  return {
    added: plan.added.map((u) => `${u.user_name}(${u.user_id})`),
    updated: plan.updated.length,
    resigned: plan.resigned,
    restored: plan.restored,
    skippedRecentActive: plan.skippedRecentActive,
    invalidated: plan.invalidated,
    contactsSynced: plan.contactsSynced,
    errors: plan.errors,
  };
}

/**
 * 刷新钉钉通讯录快照。
 * 未配置钉钉或同步失败时降级：contactsSynced=false，本次不做离职标记
 * （同步中途失败时 dingtalk_users 可能已被清空，据此标离职会误伤全体员工）。
 */
async function prepareContacts(options: ReconcileOptions): Promise<{
  contactsSynced: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  if (options.skipContactsSync) {
    errors.push("已跳过通讯录同步（skipContactsSync），本次不做离职标记");
    return { contactsSynced: false, errors };
  }

  try {
    const result = await syncContacts();
    errors.push(...result.errors);
    console.log(
      `[UserSync] Contacts synced: ${result.departments} departments, ${result.users} users`
    );
    return { contactsSynced: true, errors };
  } catch (err: any) {
    console.warn(`[UserSync] Contacts sync skipped: ${err.message}`);
    errors.push(`通讯录同步失败，本次不做离职标记: ${err.message}`);
    return { contactsSynced: false, errors };
  }
}

/** 执行对账：先同步通讯录（可跳过/降级），再按规则对账写库 */
export async function reconcileUsers(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const { contactsSynced, errors } = await prepareContacts(options);
  const plan = await computePlan(contactsSynced, errors);
  await applyPlan(plan);

  const result = toResult(plan);
  console.log(
    `[UserSync] Reconcile done: added=${result.added.length}, updated=${result.updated}, ` +
      `resigned=${result.resigned.length}, restored=${result.restored.length}, ` +
      `skippedRecentActive=${result.skippedRecentActive.length}, ` +
      `invalidated=${result.invalidated.length}, ` +
      `contactsSynced=${result.contactsSynced}`
  );
  return result;
}

/**
 * 预览对账结果（不写 users 表，结构与 reconcileUsers 相同）。
 * 仍会刷新通讯录快照，保证预览中的离职名单与真实执行一致。
 */
export async function previewReconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const { contactsSynced, errors } = await prepareContacts(options);
  return toResult(await computePlan(contactsSynced, errors));
}
