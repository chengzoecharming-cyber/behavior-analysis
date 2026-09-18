import { motion } from "framer-motion";

// ============ 客户矩阵墙：等距 3D 斜排彩色方块（网易云"曲风方块矩阵墙"风格） ============
// 每个方块一家客户，拜访越多方块越大、颜色越亮；文字反向旋转保持可读
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
  maxTiles = 14,
}: {
  tiles: { name: string; count: number }[];
  active: boolean;
  maxTiles?: number;
}) {
  const items = tiles.slice(0, maxTiles);
  if (items.length === 0) return null;
  const max = Math.max(...items.map((t) => t.count), 1);
  const cols = 4;
  const cell = 110;
  const rows = Math.ceil(items.length / cols);
  const w = cols * cell;
  const h = rows * cell;

  // 旋转后的包围盒（rotateZ(38°) 展宽，rotateX(50°) 压扁纵向），自动缩放到不溢出
  const cosZ = 0.788;
  const sinZ = 0.616;
  const cosX = 0.643;
  const rotW = w * cosZ + h * sinZ;
  const rotH = (w * sinZ + h * cosZ) * cosX;
  const scale = Math.min(1, 380 / rotW, 360 / rotH);

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
          const size = 62 + 44 * Math.sqrt(ratio);
          const col = i % cols;
          const row = Math.floor(i / cols);
          return (
            <motion.div
              key={t.name + i}
              initial={{ opacity: 0, scale: 0 }}
              animate={active ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
              transition={{ delay: 0.35 + i * 0.06, type: "spring", stiffness: 260, damping: 18 }}
              style={{
                position: "absolute",
                left: col * cell + (cell - size) / 2,
                top: row * cell + (cell - size) / 2,
                width: size,
                height: size,
                borderRadius: 10,
                // 亮度用背景 alpha 表达（motion 会接管元素 opacity，不能放 style.opacity）
                background: hexToRgba(PALETTE[i % PALETTE.length], 0.45 + 0.55 * ratio),
                boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transformStyle: "preserve-3d",
              }}
            >
              <span
                style={{
                  transform: "rotateZ(38deg) rotateX(-50deg)",
                  color: "#fff",
                  textShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  fontSize: 13,
                  lineHeight: 1.3,
                  textAlign: "center",
                  maxWidth: 128,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {t.name.length > 7 ? t.name.slice(0, 7) + "…" : t.name}
                <span style={{ opacity: 0.85, marginLeft: 3 }}>{t.count}</span>
              </span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
