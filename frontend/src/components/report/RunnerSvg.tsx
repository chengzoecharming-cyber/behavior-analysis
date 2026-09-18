// ============ 奔跑者 IP：极简白色线条小人 ============
// running=true 时腿部/手臂做循环摆臂奔跑动画（纯 CSS transform），false 为静态站姿
export function RunnerSvg({
  size = 64,
  running = false,
  className = "",
  style,
}: {
  size?: number;
  running?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const stroke = {
    stroke: "rgba(255,255,255,0.92)",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} style={style} aria-hidden>
      <style>{`
        @keyframes sr-leg-a { from { transform: rotate(-24deg); } to { transform: rotate(26deg); } }
        @keyframes sr-leg-b { from { transform: rotate(26deg); } to { transform: rotate(-24deg); } }
        @keyframes sr-arm-a { from { transform: rotate(22deg); } to { transform: rotate(-22deg); } }
        @keyframes sr-arm-b { from { transform: rotate(-22deg); } to { transform: rotate(22deg); } }
      `}</style>
      {/* 头 */}
      <circle cx="40" cy="13" r="5.5" {...stroke} />
      {/* 躯干（前倾） */}
      <path d="M38 19 L30 37" {...stroke} />
      {/* 手臂：绕肩部 (36,21) 摆动 */}
      <g style={{ transformOrigin: "36px 21px", animation: running ? "sr-arm-a 0.6s ease-in-out infinite alternate" : undefined }}>
        <path d="M36 21 L46 28 L42 37" {...stroke} />
      </g>
      <g style={{ transformOrigin: "36px 21px", animation: running ? "sr-arm-b 0.6s ease-in-out infinite alternate" : undefined }}>
        <path d="M36 21 L27 27 L31 36" {...stroke} />
      </g>
      {/* 腿：绕髋部 (30,37) 摆动 */}
      <g style={{ transformOrigin: "30px 37px", animation: running ? "sr-leg-a 0.6s ease-in-out infinite alternate" : undefined }}>
        <path d="M30 37 L41 44 L37 55" {...stroke} />
      </g>
      <g style={{ transformOrigin: "30px 37px", animation: running ? "sr-leg-b 0.6s ease-in-out infinite alternate" : undefined }}>
        <path d="M30 37 L21 44 L25 55" {...stroke} />
      </g>
    </svg>
  );
}
