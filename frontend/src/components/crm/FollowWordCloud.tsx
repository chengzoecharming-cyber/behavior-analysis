import { useMemo } from "react";
import type { CrmWordCloudItem } from "../../types";

interface FollowWordCloudProps {
  data: CrmWordCloudItem[];
  width?: number;
  height?: number;
  /** 最多展示的词数 */
  maxWords?: number;
}

interface PlacedWord {
  word: string;
  count: number;
  x: number;
  y: number;
  fontSize: number;
  color: string;
}

// 清爽的蓝绿色系配色
const PALETTE = [
  "#1677ff", "#13c2c2", "#2f54eb", "#52c41a", "#08979c",
  "#1d39c4", "#389e0d", "#0958d9", "#531dab", "#c41d7f",
];

// 近似估算文字包围盒（中文按字号见方，ASCII 半宽）
function measure(word: string, fontSize: number): { w: number; h: number } {
  let units = 0;
  for (const ch of word) {
    units += ch.charCodeAt(0) > 255 ? 1 : 0.55;
  }
  return { w: units * fontSize, h: fontSize };
}

function intersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  padding: number
): boolean {
  return (
    a.x - a.w / 2 - padding < b.x + b.w / 2 &&
    a.x + a.w / 2 + padding > b.x - b.w / 2 &&
    a.y - a.h / 2 - padding < b.y + b.h / 2 &&
    a.y + a.h / 2 + padding > b.y - b.h / 2
  );
}

/**
 * 跟进纪要词云：纯 SVG 实现（无第三方词云依赖，便于复用到其他页面）。
 * 按词频定字号，阿基米德螺旋从中心向外放置，碰撞检测避开已放置词。
 */
export default function FollowWordCloud({
  data,
  width = 800,
  height = 360,
  maxWords = 80,
}: FollowWordCloudProps) {
  const placed = useMemo<PlacedWord[]>(() => {
    if (!data.length) return [];
    const words = [...data].sort((a, b) => b.count - a.count).slice(0, maxWords);
    const max = words[0].count;
    const min = words[words.length - 1].count;
    const fontMin = 13;
    const fontMax = 44;
    const cx = width / 2;
    const cy = height / 2;
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const result: PlacedWord[] = [];

    words.forEach((item, idx) => {
      // 词频线性映射到字号（最低频也保证可读）
      const t = max === min ? 1 : (item.count - min) / (max - min);
      const fontSize = fontMin + (fontMax - fontMin) * Math.sqrt(t);
      const { w, h } = measure(item.word, fontSize);

      let x = cx;
      let y = cy;
      let ok = false;
      // 螺旋扫描：角度步进 + 半径递增，找第一个不碰撞且在画布内的位置
      for (let i = 0; i < 600; i++) {
        const angle = i * 0.35;
        const radius = 4 + angle * 2.2;
        const px = cx + radius * Math.cos(angle);
        const py = cy + radius * Math.sin(angle);
        if (
          px - w / 2 < 4 ||
          px + w / 2 > width - 4 ||
          py - h / 2 < 4 ||
          py + h / 2 > height - 4
        ) {
          if (radius > Math.max(width, height)) break;
          continue;
        }
        const box = { x: px, y: py, w, h };
        if (!boxes.some((b) => intersects(box, b, 3))) {
          x = px;
          y = py;
          boxes.push(box);
          ok = true;
          break;
        }
      }
      if (!ok) return; // 放不下就跳过该词
      result.push({
        word: item.word,
        count: item.count,
        x,
        y,
        fontSize,
        color: PALETTE[idx % PALETTE.length],
      });
    });
    return result;
  }, [data, width, height, maxWords]);

  if (!data.length) {
    return (
      <div
        style={{ height, width: "100%" }}
        className="flex items-center justify-center text-gray-400 text-sm"
      >
        暂无词频数据
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height, display: "block" }}
      role="img"
      aria-label="跟进纪要词云"
    >
      {placed.map((p) => (
        <text
          key={p.word}
          x={p.x}
          y={p.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={p.fontSize}
          fill={p.color}
          style={{ cursor: "default", userSelect: "none" }}
        >
          <title>{`${p.word}：${p.count} 次`}</title>
          {p.word}
        </text>
      ))}
    </svg>
  );
}
