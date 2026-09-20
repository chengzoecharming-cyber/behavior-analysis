import { motion } from "framer-motion";

// ============ 客户矩阵墙：等距 3D 斜排彩色方块（网易云"曲风方块矩阵墙"风格） ============
// 每个方块一家客户，拜访越多方块越大、颜色越亮；文字作为「贴纸」跟随方块做同样的等距变换
const PALETTE = ["#e8845c", "#9a7bd0", "#5cb8b2", "#7fb069", "#d98bb0", "#d9b45c", "#6a8fd0"];

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function CustomerMatrix({
  tiles,
  active,
  maxTiles = 9,
}: {
  tiles: { name: string; count: number }[];
  active: boolean;
  maxTiles?: number;
}) {
  const items = tiles.slice(0, maxTiles);
  if (items.length === 0) return null;
  const max = Math.max(...items.map((t) => t.count), 1);
  const cols = 3;
  const cell = 170;
  const rows = Math.ceil(items.length / cols);
  const w = cols * cell;
  const h = rows * cell;

  // 旋转后的包围盒（rotateZ(38°) 展宽，rotateX(50°) 压扁纵向），自动缩放到不溢出
  const cosZ = 0.788;
  const sinZ = 0.616;
  const cosX = 0.643;
  const rotW = w * cosZ + h * sinZ;
  const rotH = (w * sinZ + h * cosZ) * cosX;
  const scale = Math.min(1, 400 / rotW, 400 / rotH);

  return (
    <div className="flex w-full items-center justify-center" style={{ perspective: 1000, height: Math.ceil(rotH * scale) + 16 }}>
      <div
        style={{
          position: "relative",
          width: w,
          height: h,
          flexShrink: 0,
          transform: `rotateX(50deg) rotateZ(-38deg) scale(${scale})`,
          transformStyle: "preserve-3d",
        }}
      >
        {items.map((t, i) => {
          const ratio = t.count / max;
          const size = 108 + 58 * Math.sqrt(ratio);
          const col = i % cols;
          const row = Math.floor(i / cols);
          return (
            <motion.div
              key={t.name + i}
              initial={{ opacity: 0, scale: 0 }}
              animate={active ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
              transition={{ delay: 0.35 + i * 0.07, type: "spring", stiffness: 260, damping: 18 }}
              style={{
                position: "absolute",
                left: col * cell + (cell - size) / 2,
                top: row * cell + (cell - size) / 2,
                width: size,
                height: size,
                borderRadius: 14,
                // 亮度用背景 alpha 表达（motion 会接管元素 opacity，不能放 style.opacity）
                background: hexToRgba(PALETTE[i % PALETTE.length], 0.45 + 0.55 * ratio),
                boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                padding: 6,
                transformStyle: "preserve-3d",
              }}
            >
              {/* 文字不做反旋，直接贴在方块平面上 */}
              <span
                style={{
                  color: "#fff",
                  textShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  fontSize: 15,
                  fontWeight: 600,
                  lineHeight: 1.25,
                  textAlign: "center",
                  maxWidth: "100%",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {t.name.length > 6 ? t.name.slice(0, 6) + "…" : t.name}
              </span>
              <span style={{ color: "rgba(255,255,255,0.9)", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{t.count} 次</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
