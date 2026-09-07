import { useEffect, useState } from "react";

/**
 * 是否为移动端竖屏手机（宽度 < 768px）。
 * 仅监听 resize，保持简单；桌面端布局不受影响。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return isMobile;
}
