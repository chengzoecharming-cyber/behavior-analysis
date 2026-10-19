// 日报 markdown 完全 dry run 预览：
// 复用 reportGenerationService 的日报数据装配口径（computeScopeOverview / computeUserOverview）
// 与 renderWikiReportMarkdown 渲染函数，只读数据库，不推送钉钉消息、不写钉钉文档、不写库。
//
// 用法：
//   cd backend && npm run dryrun:daily-report                      # 昨天（北京时间）公司日报
//   npm run dryrun:daily-report -- --date=2026-10-13               # 指定日期
//   npm run dryrun:daily-report -- --person=<用户ID或姓名>          # 个人日报
//   npm run dryrun:daily-report -- --date=2026-10-13 --person=张三
//
// 输出：仓库根目录 tmp/dryrun-daily-report-<date>[-<scope>].md，并打印统计信息。

import "dotenv/config";
import fs from "fs";
import path from "path";
import { pool } from "../src/db";
import { buildOrgTree } from "../src/services/orgService";
import { computeUserOverview } from "../src/services/userOverviewService";
import { renderWikiReportMarkdown } from "../src/services/wikiReportMarkdown";
import {
  batchFilterCompanyVisits,
  batchFilterHomeVisits,
  loadAllHomeAddresses,
  loadCompanyAddresses,
} from "../src/services/addressWhitelistService";
import { getYesterdayBeijing } from "../src/utils/timezone";
import { Visit, Route } from "../src/types";

interface Args {
  date: string;
  person?: string;
}

function parseArgs(): Args {
  const args: Args = { date: getYesterdayBeijing() };
  for (const raw of process.argv.slice(2)) {
    const [key, ...parts] = raw.replace(/^--/, "").split("=");
    const value = parts.join("=");
    if (!value) continue;
    if (key === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) args.date = value;
    if (key === "person") args.person = value;
  }
  return args;
}

async function findUser(nameOrId: string): Promise<{ userId: string; userName: string } | null> {
  const result = await pool.query(
    `SELECT user_id, user_name FROM users
     WHERE user_id = $1 OR user_name = $1
     ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [nameOrId]
  );
  if (!result.rows[0]) return null;
  return {
    userId: result.rows[0].user_id,
    userName: result.rows[0].user_name || result.rows[0].user_id,
  };
}

// 与 reportGenerationService 同口径：v2 的 exclude_from_visit_count 已含「客户名 × 地址」
// 完整判定，地址过滤只作用于 v1/Excel 数据
async function buildHomeVisitIds(visits: Visit[]): Promise<{ ids: Set<number>; companyNames: string[] }> {
  const addressFilterVisits = visits.filter((v) => v.form_version !== "v2");
  const homeAddressMap = await loadAllHomeAddresses();
  const ids = await batchFilterHomeVisits(addressFilterVisits, homeAddressMap);
  const companyAddresses = await loadCompanyAddresses();
  for (const id of batchFilterCompanyVisits(addressFilterVisits, companyAddresses)) {
    ids.add(id);
  }
  return { ids, companyNames: companyAddresses.map((a) => a.name) };
}

function buildSystemLink(date: string, personUserId?: string): string {
  const baseUrl = (
    process.env.REPORT_SYSTEM_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    "http://8.219.97.3:5173"
  ).replace(/\/+$/, "");
  if (personUserId) {
    return `${baseUrl}/console?user=${encodeURIComponent(personUserId)}&date=${date}`;
  }
  return `${baseUrl}/console?${new URLSearchParams({ scope: "company", start: date, end: date }).toString()}`;
}

async function main() {
  const args = parseArgs();
  const date = args.date;
  const scope = args.person ? "person" : "company";
  const tree = await buildOrgTree();

  let titleName: string;
  let scopeName: string;
  let visits: Visit[];
  let routes: Route[];
  let overview: { totals: { visit_count: number; estimated_distance_km: number } };

  if (scope === "person") {
    const user = await findUser(args.person!);
    if (!user) throw new Error(`找不到用户: ${args.person}`);
    // 与 reportGenerationService person 分支同口径的纯查询装配（不含写库/写文档）
    const fullOverview = await computeUserOverview(user.userId, date, date);
    visits = (
      await pool.query(
        `SELECT * FROM visits WHERE user_id = $1 AND business_date = $2::date ORDER BY timestamp`,
        [user.userId, date]
      )
    ).rows;
    routes = (
      await pool.query(
        `SELECT * FROM routes WHERE user_id = $1 AND business_date = $2::date ORDER BY id`,
        [user.userId, date]
      )
    ).rows;
    scopeName = user.userName;
    overview = fullOverview;
    titleName = fullOverview.totals.visit_count > 0 ? scopeName : `${scopeName}（${date}_无拜访）`;
  } else {
    // 公司日报：与 computeScopeOverview("company", ...) 同口径
    const userIds = new Set<string>();
    for (const dept of tree) {
      for (const uid of dept.userIds || []) userIds.add(uid);
      for (const sub of dept.children) {
        for (const uid of sub.userIds || []) userIds.add(uid);
      }
    }
    const ids = Array.from(userIds);
    visits = (
      await pool.query(
        `SELECT * FROM visits
         WHERE user_id = ANY($1::text[]) AND business_date = $2::date
         ORDER BY timestamp`,
        [ids, date]
      )
    ).rows;
    routes = (
      await pool.query(
        `SELECT * FROM routes
         WHERE user_id = ANY($1::text[]) AND business_date = $2::date
         ORDER BY id`,
        [ids, date]
      )
    ).rows;
    const { ids: homeIds } = await buildHomeVisitIds(visits);
    const visitCount = visits
      .filter((v) => !v.exclude_from_visit_count && !homeIds.has(v.id))
      .reduce((sum, v) => sum + (v.customer_count || 1), 0);
    scopeName = "公司";
    overview = {
      totals: {
        visit_count: visitCount,
        estimated_distance_km: Math.round(routes.reduce((s, r) => s + (r.distance_km || 0), 0)),
      },
    };
    titleName = visitCount > 0 ? scopeName : `${scopeName}（${date}_无拜访）`;
  }

  const { ids: homeVisitIds, companyNames } = await buildHomeVisitIds(visits);
  const markdown = renderWikiReportMarkdown({
    scope,
    scopeName,
    titleName,
    start: date,
    end: date,
    reportType: "日报",
    overview: overview as any,
    visits,
    routes,
    homeVisitIds,
    excludedCustomerNames: companyNames,
    systemLink: buildSystemLink(date, scope === "person" ? visits[0]?.user_id : undefined),
    orgTree: tree,
  });

  const outDir = path.resolve(__dirname, "../../tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `dryrun-daily-report-${date}${scope === "person" ? `-person-${scopeName}` : ""}.md`
  );
  fs.writeFileSync(outPath, markdown, "utf8");

  const imageCount = (markdown.match(/<img\s|!\[/g) || []).length;
  const itemCount = (markdown.match(/^\d+\. \*\*/gm) || []).length;
  const peopleCount = new Set(visits.map((v) => v.user_id)).size;

  console.log("=== 日报 dry run 完成（未推送钉钉、未写文档、未写库） ===");
  console.log(`日期: ${date}  范围: ${scope === "person" ? `个人（${scopeName}）` : "公司"}`);
  console.log(`输出文件: ${outPath}`);
  console.log(`总字符数: ${markdown.length}`);
  console.log(`拜访条目数: ${itemCount}`);
  console.log(`图片数: ${imageCount}`);
  console.log(`涉及人数: ${peopleCount}`);
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
