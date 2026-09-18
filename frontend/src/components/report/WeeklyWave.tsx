import { useId } from "react";
import { motion } from "framer-motion";

// ============ 拜访节奏波形：每周一个波峰，catmull-rom 转 bezier 平滑 ============
// 橙金渐变填充 + 发光描边，路径 draw-in 动画（pathLength），下方标月份刻度
export function WeeklyWave({
  weekly,
  active,
}: {
  weekly: { week_start: string; visit_count: number }[];
  active: boolean;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  if (weekly.length < 2) return null;

  const W = 340;
  const H = 220;
  const padX = 14;
  const padT = 26;
  const padB = 34;
  const max = Math.max(...weekly.map((w) => w.visit_count), 1);
  const pts = weekly.map((w, i) => ({
    x: padX + (i * (W - 2 * padX)) / (weekly.length - 1),
    y: H - padB - (w.visit_count / max) * (H - padT - padB),
  }));

  // catmull-rom → cubic bezier
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  const area = `${d} L ${pts[pts.length - 1].x} ${H - padB} L ${pts[0].x} ${H - padB} Z`;

  // 峰值点
  let peakIdx = 0;
  weekly.forEach((w, i) => {
    if (w.visit_count > weekly[peakIdx].visit_count) peakIdx = i;
  });
  const peak = pts[peakIdx];

  // 月份刻度：每个月第一周的 x 位置
  const monthTicks: { label: string; x: number }[] = [];
  weekly.forEach((w, i) => {
    const m = new Date(w.week_start).getMonth() + 1;
    if (isNaN(m)) return;
    if (!monthTicks.some((t) => t.label === `${m}月`)) {
      monthTicks.push({ label: `${m}月`, x: pts[i].x });
    }
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: 380 }} aria-hidden>
      <defs>
        <linearGradient id={`wg-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffd194" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ff7e3f" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id={`wl-${gid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff7e3f" />
          <stop offset="55%" stopColor="#ff9a5a" />
          <stop offset="100%" stopColor="#ffd194" />
        </linearGradient>
      </defs>

      {/* 基线 */}
      <line x1={padX} y1={H - padB} x2={W - padX} y2={H - padB} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />

      {/* 渐变面积（路径画完后淡入） */}
      <motion.path
        d={area}
        fill={`url(#wg-${gid})`}
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : { opacity: 0 }}
        transition={{ delay: 1.1, duration: 0.9 }}
      />
      {/* 发光底层 + 亮描边，draw-in */}
      <motion.path
        d={d}
        fill="none"
        stroke="rgba(255,154,90,0.35)"
        strokeWidth="8"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={active ? { pathLength: 1 } : { pathLength: 0 }}
        transition={{ duration: 1.6, ease: "easeInOut" }}
      />
      <motion.path
        d={d}
        fill="none"
        stroke={`url(#wl-${gid})`}
        strokeWidth="3"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={active ? { pathLength: 1 } : { pathLength: 0 }}
        transition={{ duration: 1.6, ease: "easeInOut" }}
      />

      {/* 峰值点：呼吸光环 */}
      {weekly[peakIdx].visit_count > 0 && (
        <motion.g initial={{ opacity: 0 }} animate={active ? { opacity: 1 } : { opacity: 0 }} transition={{ delay: 1.7, duration: 0.5 }}>
          <circle cx={peak.x} cy={peak.y} r="10" fill="rgba(255,154,90,0.25)">
            <animate attributeName="r" values="8;13;8" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle cx={peak.x} cy={peak.y} r="4.5" fill="#ffd194" stroke="#ff9a5a" strokeWidth="1.5" />
          <text x={peak.x} y={peak.y - 14} textAnchor="middle" fill="#ffd194" fontSize="12" fontWeight="600">
            {weekly[peakIdx].visit_count}
          </text>
        </motion.g>
      )}

      {/* 月份刻度 */}
      {monthTicks.map((t) => (
        <text key={t.label} x={t.x} y={H - 10} textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize="11">
          {t.label}
        </text>
      ))}
    </svg>
  );
}
