import { motion } from "framer-motion";

// ============ 外勤日历点阵（网易云"听歌年历"风格） ============
// 每月一块：月标题 + 7列圆点，有拜访的日子点亮成橙金色（越多越亮/略大），逐月 stagger 浮现
export function CalendarDots({
  daily,
  active,
}: {
  daily: { date: string; visit_count: number }[];
  active: boolean;
}) {
  if (daily.length === 0) return null;
  const max = Math.max(...daily.map((d) => d.visit_count), 1);

  // 按月分组
  const months: { key: string; label: string; year: number; month: number; days: Map<number, number> }[] = [];
  const byMonth = new Map<string, Map<number, number>>();
  for (const d of daily) {
    const dt = new Date(d.date);
    if (isNaN(dt.getTime())) continue;
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    if (!byMonth.has(key)) byMonth.set(key, new Map());
    byMonth.get(key)!.set(dt.getDate(), d.visit_count);
  }
  for (const [key, days] of byMonth) {
    const [y, m] = key.split("-").map(Number);
    months.push({ key, label: `${m + 1}月`, year: y, month: m, days });
  }
  months.sort((a, b) => (a.key < b.key ? -1 : 1));

  return (
    <div className="flex w-full flex-wrap items-start justify-center gap-x-6 gap-y-5" style={{ maxWidth: 380 }}>
      {months.map((mo, mi) => {
        const daysInMonth = new Date(mo.year, mo.month + 1, 0).getDate();
        // 周一开头的偏移
        const offset = (new Date(mo.year, mo.month, 1).getDay() + 6) % 7;
        const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
        return (
          <motion.div
            key={mo.key}
            initial={{ opacity: 0, y: 18 }}
            animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
            transition={{ delay: 0.3 + mi * 0.25, duration: 0.6, ease: "easeOut" }}
            className="flex flex-col items-center gap-2"
          >
            <span className="text-white/60" style={{ fontSize: 13, letterSpacing: "0.15em" }}>
              {mo.label}
            </span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 14px)", gap: 6 }}>
              {cells.map((day, i) => {
                if (day === null) return <span key={i} style={{ width: 14, height: 14 }} />;
                const count = mo.days.get(day) ?? 0;
                const ratio = count / max;
                const lit = count > 0;
                return (
                  <span
                    key={i}
                    style={{
                      width: lit ? 10 + 4 * ratio : 8,
                      height: lit ? 10 + 4 * ratio : 8,
                      margin: lit ? `${(14 - 10 - 4 * ratio) / 2}px` : "3px",
                      borderRadius: "50%",
                      background: lit ? `rgba(255,${Math.round(154 + 55 * ratio)},${Math.round(90 + 60 * ratio)},${0.4 + 0.6 * ratio})` : "rgba(255,255,255,0.10)",
                      boxShadow: ratio > 0.6 ? "0 0 8px rgba(255,154,90,0.55)" : "none",
                    }}
                  />
                );
              })}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

/** 最长连续拜访天数（daily 需按日期排序或本函数内排序） */
export function longestStreak(daily: { date: string; visit_count: number }[]): number {
  const days = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));
  let best = 0;
  let cur = 0;
  let prev = 0;
  for (const d of days) {
    const t = new Date(d.date).getTime();
    if (d.visit_count > 0) {
      cur = prev && Math.round((t - prev) / 86400000) === 1 ? cur + 1 : 1;
      best = Math.max(best, cur);
      prev = t;
    } else {
      cur = 0;
      prev = 0;
    }
  }
  return best;
}
