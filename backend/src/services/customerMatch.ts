/**
 * visits 客户名 → CRM 客户的规则归并匹配（cross / stuck 共用口径）。
 *
 * 三层匹配：
 * 1. name_norm 精确匹配（调用方先做，本文件不负责）；
 * 2. 规则归并：
 *    a) 去掉尾部「分公司/子公司/分厂/办事处/营业部」等分支后缀后再精确匹配
 *       （销售手填常写「XX分公司」，CRM 里只有集团主体名）；
 *    b) 双向包含匹配：一方 name_norm 包含另一方，且较短者长度 ≥ 4
 *       （防止「众恒汽车部件」被短名误配），取候选中 name_norm 最长的 CRM 客户；
 *       并列最长且不是同一个名字 → 视为歧义，不归并；
 * 3. 仍对不上 → 由调用方进「待确认」桶。
 */

// 分支/机构尾缀，可多级叠加（如「XX华东分公司」剥一层后还可再剥）
const BRANCH_SUFFIXES = ["分公司", "子公司", "分厂", "办事处", "营业部"];

/** 循环剥离尾部分支后缀；至少保留 2 个字的主体名 */
export function stripBranchSuffix(name: string): string {
  let s = name;
  for (;;) {
    const hit = BRANCH_SUFFIXES.find((suf) => s.endsWith(suf) && s.length - suf.length >= 2);
    if (!hit) return s;
    s = s.slice(0, -hit.length);
  }
}

/**
 * 双向包含匹配：在候选 CRM name_norm 列表中找与 visitNorm 互相包含的项。
 * 较短者长度 < 4 不参与（太短易误配）；命中多个时取最长候选，并列最长则视为歧义返回 null。
 */
export function findContainmentMatch(visitNorm: string, candidates: string[]): string | null {
  let best: string | null = null;
  let ambiguous = false;
  for (const c of candidates) {
    if (c === visitNorm) continue;
    const short = visitNorm.length <= c.length ? visitNorm : c;
    const long = visitNorm.length <= c.length ? c : visitNorm;
    if (short.length < 4 || !long.includes(short)) continue;
    if (!best || c.length > best.length) {
      best = c;
      ambiguous = false;
    } else if (c.length === best.length && c !== best) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

/**
 * 规则归并入口：精确匹配失败的 visits 名归并到某个 CRM name_norm。
 * @param exactSet 可见 CRM 客户的 name_norm 集合（精确匹配用）
 * @param candidates 同一批 name_norm 列表（包含匹配用）
 * @returns 命中的 CRM name_norm；归并不了返回 null（进待确认桶）
 */
export function resolveCrmName(visitNorm: string, exactSet: Set<string>, candidates: string[]): string | null {
  if (exactSet.has(visitNorm)) return visitNorm;
  const stripped = stripBranchSuffix(visitNorm);
  if (stripped !== visitNorm && exactSet.has(stripped)) return stripped;
  return findContainmentMatch(visitNorm, candidates);
}
