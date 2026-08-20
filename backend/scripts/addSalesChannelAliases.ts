import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * 销售渠道顶层部门归一化别名配置（幂等，可重复执行）。
 *
 * 背景：部分销售挂在钉钉「销售渠道-X区域」顶层部门下，业务主部门是「销售部-*」子部门。
 * 系统所有组织归属/聚合/级联选择器口径已改为查询时归一化
 * （见 departmentAliasService.normalizePrimaryDepartment / normalizedPrimaryDeptSql），
 * 本脚本只需把别名写入 department_aliases 即全链路生效，无需回填 visits 数据。
 *
 * 用法：cd backend && npm run alias:sales-channels
 */
const MAPPINGS: { alias: string; canonicalName: string }[] = [
  { alias: "销售渠道-华南区域", canonicalName: "华南一部" },
  { alias: "销售渠道-江苏区域", canonicalName: "华东昆山" },
  { alias: "销售渠道-浙江区域", canonicalName: "华东宁波" },
];

async function main() {
  console.log("=== 销售渠道部门归一化别名配置 ===\n");

  for (const { alias, canonicalName } of MAPPINGS) {
    await pool.query(
      `INSERT INTO department_aliases (alias, canonical_name, source)
       VALUES ($1, $2, 'manual')
       ON CONFLICT (alias) DO UPDATE SET
         canonical_name = EXCLUDED.canonical_name,
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [alias, canonicalName]
    );
    console.log(`UPSERT ${alias} → ${canonicalName}`);
  }

  // 打印当前生效的相关映射，便于核对
  const result = await pool.query(
    `SELECT alias, canonical_name, source, updated_at
     FROM department_aliases
     WHERE alias LIKE '销售渠道%'
        OR alias = ANY($1::text[])
     ORDER BY alias`,
    [MAPPINGS.map((m) => m.canonicalName)]
  );
  console.log("\n当前销售渠道相关别名：");
  for (const row of result.rows) {
    console.log(`  ${row.alias} → ${row.canonical_name ?? "(待确认)"} [${row.source}]`);
  }

  console.log("\n完成。归一化为查询时生效，无需重算派生数据。");
}

main()
  .catch((err) => {
    console.error("执行失败：", err);
    process.exit(1);
  })
  .finally(() => pool.end());
