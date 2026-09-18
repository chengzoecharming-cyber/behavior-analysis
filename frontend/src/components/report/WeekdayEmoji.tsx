import { motion } from "framer-motion";

// ============ 一周作战风格（"一周听歌心情 emoji 谱"风格） ============
// 7 行：星期标签 + 按拜访数归一化的 emoji 横排（💤→🚶→🚗→💪→🔥）+ 右侧词标签
const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function emojiFor(ratio: number): string {
  if (ratio > 0.8) return "🔥";
  if (ratio > 0.6) return "💪";
  if (ratio > 0.4) return "🚗";
  if (ratio > 0.15) return "🚶";
  return "💤";
}

export function WeekdayEmoji({
  counts,
  active,
}: {
  counts: number[];
  active: boolean;
}) {
  if (counts.length !== 7) return null;
  const max = Math.max(...counts, 1);
  // 按数量排名，决定词标签
  const order = counts.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
  const tags = new Array<string>(7).fill("");
  order.forEach(({ c, i }, rank) => {
    if (c === 0) {
      tags[i] = i >= 5 ? "满血复活" : "打个盹儿";
    } else if (rank === 0) {
      tags[i] = "燃起来了";
    } else if (rank === 1) {
      tags[i] = "高效输出";
    } else if (c / max >= 0.45) {
      tags[i] = "稳定发挥";
    } else {
      tags[i] = "蓄力中";
    }
  });

  return (
    <div className="mt-6 w-full" style={{ maxWidth: 340 }}>
      {counts.map((c, i) => {
        const ratio = c / max;
        const n = c === 0 ? 1 : Math.max(1, Math.round(ratio * 6));
        const emoji = emojiFor(c === 0 ? 0 : ratio);
        const isTop = c > 0 && c === max;
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -18 }}
            animate={active ? { opacity: 1, x: 0 } : { opacity: 0, x: -18 }}
            transition={{ delay: 0.35 + i * 0.1, duration: 0.5, ease: "easeOut" }}
            className="flex items-center gap-3 py-1.5"
          >
            <span
              className="w-9 shrink-0 text-right"
              style={{ fontSize: 14, color: isTop ? "#ffb37e" : "rgba(255,255,255,0.6)", fontWeight: isTop ? 600 : 400 }}
            >
              {WD_NAMES[i]}
            </span>
            <span className="flex-1 text-left tracking-wider" style={{ fontSize: 17, opacity: c === 0 ? 0.45 : 1 }}>
              {emoji.repeat(n)}
            </span>
            <span
              className="w-16 shrink-0 text-right"
              style={{ fontSize: 12, color: isTop ? "#ffb37e" : "rgba(255,255,255,0.45)" }}
            >
              {tags[i]}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}
