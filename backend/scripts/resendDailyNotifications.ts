/**
 * 补发某日日报的钉钉通知（不重新生成报告，只重发消息）。
 *
 * 背景：2026-08-21 发现机器人单聊通道误用 oapi.dingtalk.com 域名，
 * HTTP 200 假成功导致 8-20 日报的个人通知/leader 汇总从未送达。
 * 本脚本按 report_generation_logs 中该日期的成功记录重发通知，
 * 数据口径与 reportGenerationService 的通知部分一致（含陪同拜访行；
 * 2026-10-16 起同样按「每人只收层级最高一条」去重：公司>部门>区总>个人）。
 *
 * 用法：
 *   npx ts-node scripts/resendDailyNotifications.ts 2026-08-20 [--dry]
 */
import { pool } from "../src/db";
import { buildOrgTree, OrgTreeNode } from "../src/services/orgService";
import { computeUserOverview } from "../src/services/userOverviewService";
import { sendReportMessageToUsers } from "../src/services/dingtalkFile";
import {
  getCompanyLeaderIds,
  getDeptLeaderIds,
  getSubDeptLeaderIds,
} from "../src/services/leaderConfig";

const RECENT_DATA_WINDOW_DAYS = 14;

const date = process.argv[2];
const dryRun = process.argv.includes("--dry");

if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("用法: npx ts-node scripts/resendDailyNotifications.ts <YYYY-MM-DD> [--dry]");
  process.exit(1);
}

async function hasRecentData(userIds: string[]): Promise<boolean> {
  if (userIds.length === 0) return false;
  const result = await pool.query(
    `SELECT 1 FROM visits
     WHERE user_id = ANY($1::text[])
       AND business_date >= CURRENT_DATE - INTERVAL '${RECENT_DATA_WINDOW_DAYS} days'
     LIMIT 1`,
    [userIds]
  );
  return result.rows.length > 0;
}

/** 从生成日志取某维度该日期最新一条成功记录的文档链接 */
async function findDocUrl(scope: string, scopeName: string): Promise<string | undefined> {
  const result = await pool.query(
    `SELECT doc_url FROM report_generation_logs
     WHERE report_type = 'daily'
       AND period_start = $1::date
       AND period_end = $1::date
       AND scope = $2
       AND scope_name = $3
       AND status = 'success'
     ORDER BY id DESC
     LIMIT 1`,
    [date, scope, scopeName]
  );
  return result.rows[0]?.doc_url || undefined;
}

async function getUserNameById(userId: string): Promise<string> {
  const result = await pool.query(
    "SELECT user_name FROM users WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return result.rows[0]?.user_name || userId;
}

async function sendPersonNotification(userId: string, userName: string): Promise<{ visitCount: number; sent: boolean }> {
  const url = await findDocUrl("person", userName);
  const overview = await computeUserOverview(userId, date, date);
  const accompanyCount = overview.daily.reduce((s, d) => s + (d.accompany_count || 0), 0);
  const totals = {
    visit_count: overview.totals.visit_count,
    estimated_distance_km: overview.totals.estimated_distance_km,
    anomaly_count: overview.totals.anomaly_count,
  };

  const title = `外勤日报-${userName}-${date}`;
  const lines = [
    `### ${userName} ${date} 外勤日报`,
    "",
    `- 拜访次数：${totals.visit_count} 次`,
    `- 总里程：${Math.round(totals.estimated_distance_km)} km`,
    `- 异常：${totals.anomaly_count} 条`,
  ];
  if (accompanyCount > 0) {
    lines.push(`- 陪同拜访：${accompanyCount} 次`);
  }
  if (url) {
    lines.push("", `[查看完整日报](${url})`);
  }

  if (dryRun) {
    console.log(`[dry] 个人通知: ${userName} (${userId}) url=${url ? "有" : "无"}`);
    return { visitCount: totals.visit_count, sent: false };
  }
  try {
    await sendReportMessageToUsers([userId], title, lines.join("\n"));
    console.log(`已补发个人通知: ${userName}`);
    return { visitCount: totals.visit_count, sent: true };
  } catch (err: any) {
    console.warn(`个人通知发送失败: ${userName}:`, err?.message || err);
    return { visitCount: totals.visit_count, sent: false };
  }
}

async function sendLeaderSummary(
  leaderIds: string[],
  groupName: string,
  stats: { generated: number; failed: number; totalVisits: number },
  reportUrl?: string
): Promise<void> {
  if (leaderIds.length === 0) {
    console.log(`${groupName} 无区总/负责人，跳过汇总补发`);
    return;
  }
  const lines = [
    `### ${groupName} ${date} 外勤日报`,
    "",
    `- 生成日报 ${stats.generated} 份：成功 ${stats.generated - stats.failed}，失败 ${stats.failed}`,
    `- 总拜访：${stats.totalVisits} 次`,
  ];
  if (reportUrl) {
    lines.push("", `[查看${groupName}日报](${reportUrl})`);
  }
  if (dryRun) {
    console.log(`[dry] 汇总通知: ${groupName} → ${leaderIds.length} 人 url=${reportUrl ? "有" : "无"}`);
    return;
  }
  try {
    await sendReportMessageToUsers(leaderIds, `外勤日报-${groupName}-${date}`, lines.join("\n"));
    console.log(`已补发日报汇总: ${groupName} → ${leaderIds.length} 人`);
  } catch (err: any) {
    console.warn(`汇总发送失败: ${groupName}:`, err?.message || err);
  }
}

async function main() {
  console.log(`补发 ${date} 日报通知${dryRun ? "（dry-run，不实际发送）" : ""}`);
  const tree = await buildOrgTree();

  // 与 reportGenerationService 推送去重逻辑一致：每人只收层级最高的一条
  // （公司接收人 > 部门负责人 > 区总 > 个人）
  const companyLeaderIds = await getCompanyLeaderIds();

  const companyStats = { generated: 0, failed: 0, totalVisits: 0 };

  for (const dept of tree) {
    const deptStats = { generated: 0, failed: 0, totalVisits: 0 };
    const deptLeaderIds = await getDeptLeaderIds(dept);

    for (const sub of dept.children) {
      const subStats = { generated: 0, failed: 0, totalVisits: 0 };
      const subLeaderIds = await getSubDeptLeaderIds(dept, sub);
      for (const userId of sub.userIds || []) {
        if (await hasRecentData([userId])) {
          const userName = await getUserNameById(userId);
          const url = await findDocUrl("person", userName);
          subStats.generated++;
          if (url) {
            if (companyLeaderIds.includes(userId) || deptLeaderIds.includes(userId) || subLeaderIds.includes(userId)) {
              console.log(`跳过个人通知（上级接收人）: ${userName}`);
            } else {
              const r = await sendPersonNotification(userId, userName);
              subStats.totalVisits += r.visitCount;
            }
          } else {
            subStats.failed++;
          }
        }
      }
      deptStats.generated += subStats.generated;
      deptStats.failed += subStats.failed;
      deptStats.totalVisits += subStats.totalVisits;
      if (subStats.generated > 0) {
        await sendLeaderSummary(
          subLeaderIds,
          sub.shortName,
          subStats,
          await findDocUrl("sub_department", sub.shortName)
        );
      }
    }

    // 部门直属人员
    for (const userId of dept.userIds || []) {
      if (await hasRecentData([userId])) {
        const userName = await getUserNameById(userId);
        const url = await findDocUrl("person", userName);
        deptStats.generated++;
        if (url) {
          if (companyLeaderIds.includes(userId) || deptLeaderIds.includes(userId)) {
            console.log(`跳过个人通知（上级接收人）: ${userName}`);
          } else {
            const r = await sendPersonNotification(userId, userName);
            deptStats.totalVisits += r.visitCount;
          }
        } else {
          deptStats.failed++;
        }
      }
    }
    companyStats.generated += deptStats.generated;
    companyStats.failed += deptStats.failed;
    companyStats.totalVisits += deptStats.totalVisits;
    if (deptStats.generated > 0) {
      await sendLeaderSummary(
        deptLeaderIds,
        dept.shortName,
        deptStats,
        await findDocUrl("department", dept.shortName)
      );
    }
  }

  if (companyStats.generated > 0) {
    await sendLeaderSummary(
      companyLeaderIds,
      "公司",
      companyStats,
      await findDocUrl("company", "公司")
    );
  }

  console.log(`补发完成: 共 ${companyStats.generated} 份个人日报，失败 ${companyStats.failed}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
