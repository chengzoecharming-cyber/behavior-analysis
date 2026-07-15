import dotenv from "dotenv";
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import { getAccessToken } from "../src/services/dingtalk";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface DeptNode {
  dept_id: number;
  parent_id: number | null;
  name: string;
  synced_at: Date;
  children: DeptNode[];
}

interface DeptLeaderInfo {
  dept_id: number;
  dept_name: string;
  manager_userids: string[];
  manager_names: string[];
}

function buildTree(rows: { dept_id: number; parent_id: number | null; name: string; synced_at: Date }[]): DeptNode[] {
  const map = new Map<number, DeptNode>();
  for (const row of rows) {
    map.set(row.dept_id, { ...row, children: [] });
  }
  const roots: DeptNode[] = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function renderTree(nodes: DeptNode[], prefix = ""): string {
  return nodes
    .map((node, idx) => {
      const isLast = idx === nodes.length - 1;
      const line = `${prefix}${isLast ? "└── " : "├── "}${node.name} (dept_id=${node.dept_id})\n`;
      const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
      return line + renderTree(node.children, childPrefix);
    })
    .join("");
}

async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function fetchDepartmentLeader(deptId: number): Promise<DeptLeaderInfo | null> {
  try {
    const accessToken = await getAccessToken();
    const res = await fetch(`https://oapi.dingtalk.com/topapi/v2/department/get?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dept_id: deptId, language: "zh_CN" }),
    });
    const data: any = await res.json();
    if (data.errcode !== 0) {
      console.warn(`[dept/get] dept_id=${deptId} failed: ${data.errmsg}`);
      return null;
    }
    const result: any = data.result || {};
    const managerUserids: string[] = result.dept_manager_userid_list || [];
    return {
      dept_id: deptId,
      dept_name: result.name || "",
      manager_userids: managerUserids,
      manager_names: [],
    };
  } catch (err: any) {
    console.warn(`[dept/get] dept_id=${deptId} error: ${err.message}`);
    return null;
  }
}

async function enrichLeaderNames(leaders: DeptLeaderInfo[]): Promise<DeptLeaderInfo[]> {
  const allUserIds = [...new Set(leaders.flatMap((l) => l.manager_userids))];
  if (allUserIds.length === 0) return leaders;

  const nameMap = new Map<string, string>();
  const dbUsers = await query<{ userid: string; name: string }>(
    `SELECT userid, name FROM dingtalk_users WHERE userid = ANY($1)`,
    [allUserIds]
  );
  for (const u of dbUsers) {
    nameMap.set(u.userid, u.name);
  }

  return leaders.map((l) => ({
    ...l,
    manager_names: l.manager_userids.map((id) => nameMap.get(id) || id),
  }));
}

async function main() {
  const reportLines: string[] = [];
  const push = (line: string) => reportLines.push(line);
  const pushSection = (title: string, level = 2) => {
    push("");
    push(`${"#".repeat(level)} ${title}`);
    push("");
  };

  const now = new Date().toISOString();
  push(`# 销售部部门归属数据摸底报告`);
  push("");
  push(`生成时间：${now}`);
  push("");
  push(`数据库：${process.env.DATABASE_URL?.replace(/:\/\/[^@]+@/, "://***@")}`);
  push("");
  push("> 本报告为只读生成，未修改任何数据。");

  // 0. 数据概览
  pushSection("0. 拜访数据概览");
  const overview = await query<{ total_visits: number; min_date: Date; max_date: Date; sources: string }>(`
    SELECT
      COUNT(*) AS total_visits,
      MIN(business_date) AS min_date,
      MAX(business_date) AS max_date,
      STRING_AGG(DISTINCT source, ', ' ORDER BY source) AS sources
    FROM visits
  `);
  push(`- 总拜访记录数：${overview[0].total_visits}`);
  push(`- 业务日期范围：${overview[0].min_date} ~ ${overview[0].max_date}`);
  push(`- 数据来源：${overview[0].sources}`);

  // 1. visits.department 全集
  pushSection("1. visits.department 字符串全集");
  const deptStrings = await query<{ department: string; count: number }>(`
    SELECT department, COUNT(*) AS count
    FROM visits
    WHERE department IS NOT NULL AND department <> ''
    GROUP BY department
    ORDER BY count DESC
  `);
  if (deptStrings.length === 0) {
    push("无数据。");
  } else {
    push("| 原始 department 字符串 | 记录数 |");
    push("|---|---|");
    for (const row of deptStrings) {
      push(`| ${row.department || "(空)"} | ${row.count} |`);
    }
  }

  // 2. 用户跨部门情况
  pushSection("2. 用户跨部门情况（取主部门，即逗号分隔第一个）");
  const crossDeptUsers = await query<{
    user_id: string;
    user_name: string;
    dept_count: number;
    departments: string[];
    visit_count: number;
  }>(`
    SELECT
      user_id,
      user_name,
      COUNT(DISTINCT SPLIT_PART(department, ',', 1)) AS dept_count,
      ARRAY_AGG(DISTINCT SPLIT_PART(department, ',', 1)) AS departments,
      COUNT(*) AS visit_count
    FROM visits
    WHERE department IS NOT NULL AND department <> ''
    GROUP BY user_id, user_name
    HAVING COUNT(DISTINCT SPLIT_PART(department, ',', 1)) > 1
    ORDER BY dept_count DESC, visit_count DESC
  `);
  if (crossDeptUsers.length === 0) {
    push("没有跨部门的用户。");
  } else {
    push(`共 ${crossDeptUsers.length} 人。`);
    push("");
    push("| user_id | user_name | 主部门数 | 主部门列表 | 记录数 |");
    push("|---|---|---|---|---|");
    for (const row of crossDeptUsers) {
      push(`| ${row.user_id} | ${row.user_name} | ${row.dept_count} | ${row.departments.join(", ")} | ${row.visit_count} |`);
    }
  }

  // 3. 钉钉当前部门树
  pushSection("3. 钉钉当前部门树（dingtalk_departments）");
  const dingtalkDepts = await query<DeptNode & { parent_id: number | null }>(`
    SELECT dept_id, parent_id, name, synced_at
    FROM dingtalk_departments
    ORDER BY parent_id, dept_id
  `);
  if (dingtalkDepts.length === 0) {
    push("`dingtalk_departments` 表为空，尚未同步钉钉部门树。");
  } else {
    push(`共 ${dingtalkDepts.length} 个部门节点。`);
    push("");
    push("```text");
    push(renderTree(buildTree(dingtalkDepts)).trimEnd());
    push("```");

    const salesDept = dingtalkDepts.find((d) => d.name === "销售部");
    if (salesDept) {
      push("");
      push(`> 销售部节点：**销售部**（dept_id=${salesDept.dept_id}）`);
    }
  }

  // 4. 销售部子部门 & 销售渠道区域 leader
  pushSection("4. 销售部子部门与销售渠道区域 leader");
  const salesDept = dingtalkDepts.find((d) => d.name === "销售部");
  const salesChannelDept = dingtalkDepts.find((d) => d.name === "销售渠道");

  const targetDeptIds: number[] = [];
  if (salesDept) {
    targetDeptIds.push(...dingtalkDepts.filter((d) => d.parent_id === salesDept.dept_id).map((d) => d.dept_id));
  }
  if (salesChannelDept) {
    targetDeptIds.push(...dingtalkDepts.filter((d) => d.parent_id === salesChannelDept.dept_id).map((d) => d.dept_id));
  }

  if (targetDeptIds.length === 0) {
    push("未找到销售部或销售渠道节点。");
  } else {
    const leaderInfos: DeptLeaderInfo[] = [];
    for (const deptId of targetDeptIds) {
      const info = await fetchDepartmentLeader(deptId);
      if (info) leaderInfos.push(info);
    }
    const enriched = await enrichLeaderNames(leaderInfos);

    push("| 部门/区域 | dept_id | leader（钉钉） |");
    push("|---|---|---|");
    for (const info of enriched) {
      const leaderText =
        info.manager_names.length > 0
          ? info.manager_names.map((n, i) => `${n} (${info.manager_userids[i]})`).join(", ")
          : "（未设置/未获取到）";
      push(`| ${info.dept_name} | ${info.dept_id} | ${leaderText} |`);
    }
  }

  // 5. 钉钉用户归属（销售部及销售渠道内部员工）
  pushSection("5. 销售部及销售渠道内部员工归属");
  const salesAndChannelUserIds = await query<{ userid: string; name: string; dept_id_list: string; source_dept_name: string }>(`
    SELECT
      du.userid,
      du.name,
      du.dept_id_list,
      dd.name AS source_dept_name
    FROM dingtalk_users du
    LEFT JOIN dingtalk_departments dd ON du.source_dept_id = dd.dept_id
    WHERE du.dept_id_list IS NOT NULL
      AND (
        du.dept_id_list LIKE '%435668139%'   -- 销售部
        OR du.dept_id_list LIKE '%518053424%' -- 销售渠道
      )
    ORDER BY du.name
  `);
  if (salesAndChannelUserIds.length === 0) {
    push("未找到归属销售部或销售渠道的用户。");
  } else {
    push(`共 ${salesAndChannelUserIds.length} 人。`);
    push("");
    push("| userid | name | 钉钉部门ID列表 | 来源部门 |");
    push("|---|---|---|---|");
    for (const row of salesAndChannelUserIds) {
      push(`| ${row.userid} | ${row.name} | ${row.dept_id_list} | ${row.source_dept_name || ""} |`);
    }
  }

  // 6. 历史审批表单中的部门信息
  pushSection("6. 历史审批表单中的部门信息（raw_approvals）");
  const rawApprovalDepts = await query<{ originator_dept_name: string; count: number }>(`
    SELECT originator_dept_name, COUNT(*) AS count
    FROM raw_approvals
    WHERE originator_dept_name IS NOT NULL AND originator_dept_name <> ''
    GROUP BY originator_dept_name
    ORDER BY count DESC
  `);
  if (rawApprovalDepts.length === 0) {
    push("`raw_approvals` 表为空或没有部门名称。");
  } else {
    push("| 审批单 originator_dept_name | 记录数 | 是否能在钉钉树找到同名 |");
    push("|---|---|---|");
    for (const row of rawApprovalDepts) {
      // 拆出主部门判断
      const mainDept = row.originator_dept_name.split("-")[0];
      const matched = dingtalkDepts.some(
        (d) => d.name === row.originator_dept_name || d.name === mainDept
      );
      push(`| ${row.originator_dept_name} | ${row.count} | ${matched ? "是" : "否"} |`);
    }
  }

  push("");
  push("**审批单 department 字符串 vs 钉钉部门名称映射**");
  const allDingtalkNames = new Set(dingtalkDepts.map((d) => d.name));
  for (const row of rawApprovalDepts) {
    const parts = row.originator_dept_name.split("-");
    const matchedNames = parts.filter((p) => allDingtalkNames.has(p));
    const unmatchedParts = parts.filter((p) => !allDingtalkNames.has(p));
    push(`- \`${row.originator_dept_name}\`：匹配到 [${matchedNames.join(", ") || "无"}]，未匹配 [${unmatchedParts.join(", ") || "无"}]`);
  }

  // 7. visits.user_id 与钉钉 userid 对应情况
  pushSection("7. visits.user_id 与钉钉 userid 对应情况");

  // 7.1 按 user_id 精确匹配
  const userIdMapping = await query<{
    visits_user_id: string;
    visits_user_name: string;
    visit_count: number;
    dingtalk_userid: string;
    dingtalk_name: string;
  }>(`
    SELECT
      v.user_id AS visits_user_id,
      MAX(v.user_name) AS visits_user_name,
      COUNT(*) AS visit_count,
      du.userid AS dingtalk_userid,
      du.name AS dingtalk_name
    FROM visits v
    LEFT JOIN dingtalk_users du ON v.user_id = du.userid
    GROUP BY v.user_id, du.userid, du.name
    ORDER BY v.user_id
  `);
  const matchedById = userIdMapping.filter((r) => r.dingtalk_userid).length;
  const unmatchedById = userIdMapping.filter((r) => !r.dingtalk_userid).length;

  // 7.2 按 user_name 匹配（给 user_id 对不上的人二次匹配）
  const unmatchedUsers = userIdMapping.filter((r) => !r.dingtalk_userid);
  const nameMatchPromises = unmatchedUsers.map(async (u) => {
    const match = await query<{ userid: string; name: string }>(
      `SELECT userid, name FROM dingtalk_users WHERE name = $1 LIMIT 1`,
      [u.visits_user_name]
    );
    return { ...u, name_match: match[0] || null };
  });
  const nameMatches = await Promise.all(nameMatchPromises);
  const matchedByName = nameMatches.filter((m) => m.name_match).length;

  push(`- visits 中不重复 user_id 数：${userIdMapping.length}`);
  push(`- 按 user_id 精确匹配：${matchedById}`);
  push(`- 按 user_id 对不上、但按 user_name 能匹配：${matchedByName}`);
  push(`- 完全对不上：${unmatchedById - matchedByName}`);
  push("");

  if (nameMatches.length > 0) {
    push("| visits.user_id | visits.user_name | 记录数 | 按姓名匹配到的钉钉用户 |");
    push("|---|---|---|---|");
    for (const row of nameMatches) {
      const matchText = row.name_match ? `${row.name_match.name} (${row.name_match.userid})` : "（无）";
      push(`| ${row.visits_user_id} | ${row.visits_user_name} | ${row.visit_count} | ${matchText} |`);
    }
  }

  // 8. users 表现状与角色分布
  pushSection("8. users 表现状与角色分布");
  const userRoles = await query<{ role: string; count: number }>(`
    SELECT role, COUNT(*) AS count
    FROM users
    GROUP BY role
    ORDER BY count DESC
  `);
  if (userRoles.length === 0) {
    push("`users` 表为空。");
  } else {
    push("| role | 人数 |");
    push("|---|---|");
    for (const row of userRoles) {
      push(`| ${row.role} | ${row.count} |`);
    }
  }

  push("");
  push("**users 表字段**");
  const userColumns = await query<{ column_name: string; data_type: string; is_nullable: string }>(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'users'
    ORDER BY ordinal_position
  `);
  push("| 字段名 | 类型 | 可空 |");
  push("|---|---|---|");
  for (const row of userColumns) {
    push(`| ${row.column_name} | ${row.data_type} | ${row.is_nullable} |`);
  }

  // 9. 待确认事项清单
  pushSection("9. 待确认事项清单");
  push("- [ ] 销售部各子部门 leader 名单（已从钉钉自动获取，见第 4 节）");
  push("- [ ] 销售渠道各区域总负责人名单（已从钉钉自动获取，见第 4 节）");
  push("- [ ] 文武江是否确认为「新品业务部」成员/leader");
  push("- [ ] 李朝晖负责销售渠道的哪些区域");
  push("- [ ] super_admin（陈盐/陈总）是否已在 users 表");
  push("- [ ] 审批单中的旧部门字符串如何映射到新钉钉部门树");
  push("- [ ] user_id 对不上的真人账号（黄柔菊、李同邦、危乐、尹功荣）是否需要清洗为钉钉 userid");
  push("- [ ] 车辆/测试账号（白色帝豪、蓝黑帝豪）是否标记为无效");

  const report = reportLines.join("\n");

  // 写入文件
  const timestamp = now.replace(/[:.]/g, "-").split("T")[0];
  const reportFileName = `org-data-audit-report-${timestamp}.md`;
  const reportPath = path.resolve(__dirname, "..", reportFileName);
  fs.writeFileSync(reportPath, report, "utf-8");

  console.log(`报告已生成：${reportPath}`);
  console.log("\n=== 摘要 ===");
  console.log(`拜访记录总数：${overview[0].total_visits}`);
  console.log(`不同 department 字符串数：${deptStrings.length}`);
  console.log(`跨部门用户数：${crossDeptUsers.length}`);
  console.log(`钉钉部门节点数：${dingtalkDepts.length}`);
  console.log(`钉钉用户数：${await query<{ count: number }>(`SELECT COUNT(*) AS count FROM dingtalk_users`).then(r => r[0].count)}`);
  console.log(`visits.user_id 精确匹配：${matchedById} / ${userIdMapping.length}`);
  console.log(`visits.user_id 对不上但按姓名匹配：${matchedByName}`);

  await pool.end();
}

main().catch((err) => {
  console.error("数据摸底失败：", err);
  process.exit(1);
});
