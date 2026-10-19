import { computeCustomerVisitFrequency } from "../src/services/customerVisitFrequency";
import { Visit } from "../src/types";

let id = 0;
function v(userId: string, date: string, customer: string, formVersion?: string): Visit {
  return {
    id: ++id,
    raw_visit_id: null,
    user_id: userId,
    user_name: userId === "u1" ? "张三" : "李四",
    department: "销售部-华东昆山",
    timestamp: new Date(`${date}T10:00:00+08:00`),
    lat: 31.2,
    lng: 121.4,
    location_name: "某地",
    address: "某地址",
    customer_name: customer,
    source: "dingtalk",
    created_at: new Date(),
    business_date: date,
    exclude_from_visit_count: false,
    customer_count: 1,
    form_version: formVersion,
  };
}

const visits: Visit[] = [
  // u1 × 甲公司：同一业务周 4 次（2026-08-10 周一 ~ 08-13），同月 4 次 → 双命中
  v("u1", "2026-08-10", "甲公司"),
  v("u1", "2026-08-11", "甲公司"),
  v("u1", "2026-08-12", "甲公司"),
  v("u1", "2026-08-13", "甲公司"),
  // u1 × 乙公司：跨业务周边界 周日 2026-08-16 两次 + 周一 2026-08-17 一次
  // → 单周峰值只有 2（不命中周），但单月 3 次不命中（阈值 >3）→ 不 flagged
  v("u1", "2026-08-16", "乙公司"),
  v("u1", "2026-08-16", "乙公司"),
  v("u1", "2026-08-17", "乙公司"),
  // u2 × 丙公司：跨周分散 4 次（每周 ≤2），单月 4 次 → 仅月命中
  v("u2", "2026-08-11", "丙（上海）有限公司"),
  v("u2", "2026-08-12", "丙(上海)有限公司"), // 全角括号+后缀归一化为同一客户
  v("u2", "2026-08-18", "丙（上海）有限公司"),
  v("u2", "2026-08-25", "丙（上海）有限公司"),
  // u1 × 占位名：应被 splitRealCustomerNames 过滤，不产生任何条目
  v("u1", "2026-08-10", "虚拟客户"),
  v("u1", "2026-08-11", "住址"),
];

const items = computeCustomerVisitFrequency(visits);
console.log(JSON.stringify(items, null, 2));

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("PASS:", msg);
};

const jia = items.find((i) => i.customerName === "甲公司")!;
assert(jia.flagged && jia.maxWeekCount === 4 && jia.maxMonthCount === 4 && jia.totalCount === 4, "甲公司 单周4+单月4 双命中");
assert(jia.flagReasons.some((r) => r.startsWith("单周4次")) && jia.flagReasons.some((r) => r.includes("单月4次(2026-08)")), "甲公司 flagReasons 文案");

const yi = items.find((i) => i.customerName === "乙公司")!;
assert(!yi.flagged && yi.maxWeekCount === 2 && yi.maxMonthCount === 3, "乙公司 跨周边界：周日两次与周一一次分属不同业务周，周峰值=2 不命中");

const bing = items.find((i) => i.userId === "u2")!;
assert(bing.flagged && bing.maxWeekCount === 2 && bing.maxMonthCount === 4, "丙公司 归一化合并、单月4次命中、周峰值2");
assert(bing.flagReasons.length === 1 && bing.flagReasons[0].includes("单月4次"), "丙公司 仅月命中");

assert(items.length === 3, "占位名（虚拟客户/住址）被过滤，无多余条目");
assert(items[0].flagged, "排序 flagged 优先");

// excludedIds：非 v2 行跳过，v2 行不跳过
const v1 = v("u3", "2026-08-10", "丁公司");
const v2row = v("u3", "2026-08-10", "丁公司", "v2");
const v1b = v("u3", "2026-08-11", "丁公司");
const v1c = v("u3", "2026-08-12", "丁公司");
const filtered = computeCustomerVisitFrequency([v1, v2row, v1b, v1c], new Set([v1.id, v2row.id, v1b.id, v1c.id]));
const ding = filtered.find((i) => i.customerName === "丁公司")!;
assert(ding.totalCount === 1 && ding.maxWeekCount === 1, "excludedIds 只跳过非 v2 行（v2 行保留 1 次）");

console.log("ALL OK");
process.exit(0);
