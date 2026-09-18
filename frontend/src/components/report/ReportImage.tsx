import { useState } from "react";

// ============ 插画氛围层：加载失败静默降级（不渲染），带缓慢 scale 呼吸动画（只动 transform） ============
export function ReportImage({
  src,
  className = "",
  style,
  breathe = true,
  alt = "",
}: {
  src: string;
  className?: string;
  style?: React.CSSProperties;
  breathe?: boolean;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <>
      {breathe && <style>{`@keyframes sr-breathe { from { transform: scale(1); } to { transform: scale(1.05); } }`}</style>}
      <img
        src={src}
        alt={alt}
        onError={() => setFailed(true)}
        className={className}
        style={{
          objectFit: "cover",
          ...(breathe ? { animation: "sr-breathe 9s ease-in-out infinite alternate", willChange: "transform" } : null),
          ...style,
        }}
      />
    </>
  );
}
