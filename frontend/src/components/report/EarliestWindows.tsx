import { motion } from "framer-motion";

// ============ 最早出发·窗户画框（"这些年你似乎睡得很晚"风格） ============
// 深色楼群里 N 扇亮灯窗户：橙色暖光窗框卡片，最早的那扇最亮，轻微浮动
const BUILDING_HEIGHTS = [185, 150, 205, 165, 175];

export function EarliestWindows({
  days,
  active,
}: {
  days: { date: string; time: string; user_name?: string }[]; // user_name 存在时在窗下小字显示人名（团队视角）
  active: boolean;
}) {
  const items = days.slice(0, 5);
  if (items.length === 0) return null;
  const fmtDate = (s: string) => {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}月${d.getDate()}日`;
  };

  return (
    <>
      <style>{`@keyframes sr-float { from { transform: translateY(0); } to { transform: translateY(-5px); } }`}</style>
      <div className="mt-4 flex w-full items-end justify-center gap-2" style={{ maxWidth: 380 }}>
        {items.map((d, i) => {
          const brightest = i === 0;
          return (
            <motion.div
              key={d.date + i}
              initial={{ opacity: 0, y: 26 }}
              animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 26 }}
              transition={{ delay: 0.35 + i * 0.16, duration: 0.6, ease: "easeOut" }}
              style={{
                width: 62,
                height: BUILDING_HEIGHTS[i % BUILDING_HEIGHTS.length] + (brightest ? 16 : 0),
                borderRadius: "6px 6px 0 0",
                background: "linear-gradient(180deg, #181830, #0d0d17)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderBottom: "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                paddingTop: 14,
                animation: active ? `sr-float ${3 + i * 0.5}s ease-in-out ${i * 0.4}s infinite alternate` : undefined,
                willChange: "transform",
              }}
            >
              {/* 亮灯窗户 */}
              <div
                style={{
                  width: 42,
                  minHeight: 58,
                  borderRadius: 4,
                  background: brightest
                    ? "linear-gradient(180deg, #ffe3b0, #ffb36b)"
                    : "linear-gradient(180deg, rgba(255,209,148,0.85), rgba(255,154,90,0.65))",
                  boxShadow: brightest
                    ? "0 0 24px rgba(255,170,90,0.8), 0 0 60px rgba(255,154,90,0.35)"
                    : "0 0 14px rgba(255,170,90,0.45)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                  padding: "6px 2px",
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: "#4a2c12", fontVariantNumeric: "tabular-nums" }}>{d.time}</span>
                <span style={{ fontSize: 9, color: "rgba(74,44,18,0.75)" }}>{fmtDate(d.date)}</span>
                {d.user_name && (
                  <span style={{ fontSize: 9, fontWeight: 600, color: "rgba(74,44,18,0.9)", maxWidth: 40, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.user_name}
                  </span>
                )}
              </div>
              {/* 楼体上的暗窗点缀 */}
              <div className="mt-3 grid grid-cols-2 gap-1.5" style={{ opacity: 0.5 }}>
                {[0, 1, 2, 3].map((k) => (
                  <span key={k} style={{ width: 8, height: 10, borderRadius: 1.5, background: "rgba(255,255,255,0.08)" }} />
                ))}
              </div>
            </motion.div>
          );
        })}
      </div>
      {/* 地平线 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={active ? { opacity: 1 } : { opacity: 0 }}
        transition={{ delay: 0.3, duration: 0.8 }}
        style={{ width: "100%", maxWidth: 380, height: 1, background: "rgba(255,255,255,0.14)" }}
      />
    </>
  );
}
