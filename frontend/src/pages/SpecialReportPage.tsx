import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import AMapLoader from "@amap/amap-jsapi-loader";

// ============ 类型（与后端契约一致） ============
interface SpecialReport {
  scope: "staff" | "manager" | "admin";
  user: { user_id: string; user_name: string; department: string };
  period: { start: string; end: string };
  personal: {
    visit_count: number;
    customer_count: number;
    distance_km: number;
    active_days: number;
    busiest_day: { date: string; visit_count: number } | null;
    earliest_visit: { date: string; time: string } | null;
    top_customers: { name: string; count: number }[];
    cities: string[];
    city_count: number;
    anomaly_count: number;
    points: { lat: number; lng: number }[];
  };
  team?: {
    member_count: number;
    total_visits: number;
    total_distance_km: number;
    top_members: { user_name: string; visit_count: number; distance_km: number }[];
  };
}

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || "";

// ============ 数字滚动 hook（requestAnimationFrame + easeOut） ============
function useCountUp(target: number, duration = 1600, decimals = 0, start = true) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(Number((target * eased).toFixed(decimals)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, decimals, start]);
  return value;
}

// ============ 通用动效 variants ============
const stagger = {
  show: { transition: { staggerChildren: 0.18, delayChildren: 0.25 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: "easeOut" as const } },
};

// ============ 小部件 ============
function BigNumber({ value, decimals = 0, active }: { value: number; decimals?: number; active: boolean }) {
  const n = useCountUp(value, 1600, decimals, active);
  return (
    <div
      className="font-bold tabular-nums"
      style={{
        fontSize: "clamp(64px, 22vw, 120px)",
        lineHeight: 1.05,
        background: "linear-gradient(135deg, #ffd194, #ff9a5a 60%, #ff7e3f)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        textShadow: "0 0 60px rgba(255,154,90,0.25)",
      }}
    >
      {decimals > 0 ? n.toFixed(decimals) : Math.round(n).toLocaleString()}
    </div>
  );
}

function PageShell({ children, center = true }: { children: React.ReactNode; center?: boolean }) {
  return (
    <motion.div
      className={`absolute inset-0 flex flex-col px-8 py-12 ${center ? "items-center justify-center text-center" : ""}`}
      variants={stagger}
      initial="hidden"
      animate="show"
      exit="hidden"
    >
      {children}
    </motion.div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return (
    <motion.p variants={fadeUp} className="mt-4 text-white/70" style={{ fontSize: "clamp(15px, 4.2vw, 19px)", lineHeight: 1.8 }}>
      {children}
    </motion.p>
  );
}

// ============ 足迹地图 ============
function FootprintMap({ points, active }: { points: { lat: number; lng: number }[]; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active || !ref.current || mapRef.current || points.length === 0) return;
    let cancelled = false;
    AMapLoader.load({ key: AMAP_KEY, version: "2.0" })
      .then((AMap: any) => {
        if (cancelled || !ref.current) return;
        const map = new AMap.Map(ref.current, {
          zoom: 5,
          mapStyle: "amap://styles/darkblue",
          viewMode: "2D",
        });
        mapRef.current = map;
        points.forEach((p) => {
          new AMap.CircleMarker({
            center: [p.lng, p.lat],
            radius: 6,
            fillColor: "#ff9a5a",
            strokeColor: "#ffd194",
            strokeWeight: 1,
            fillOpacity: 0.85,
            zIndex: 50,
          }).setMap(map);
        });
        map.setFitView();
      })
      .catch((e: any) => {
        console.error("AMap load failed:", e);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, [active, points]);

  return (
    <motion.div variants={fadeUp} className="mt-6 w-full overflow-hidden rounded-2xl border border-white/10" style={{ height: "46vh" }}>
      {failed ? (
        <div className="flex h-full items-center justify-center text-white/50 text-sm">地图加载失败</div>
      ) : (
        <div ref={ref} className="h-full w-full" />
      )}
    </motion.div>
  );
}

// ============ 主页面 ============
export default function SpecialReportPage() {
  const { token } = useParams<{ token: string }>();
  const [report, setReport] = useState<SpecialReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState(1);
  const touchStartY = useRef<number | null>(null);
  const wheelLock = useRef(false);

  useEffect(() => {
    if (!token) {
      setError("战报链接无效");
      return;
    }
    // 用裸 axios：该页面免登录，不走带 Bearer 拦截器的 api 实例
    axios
      .get<SpecialReport>(`/api/special-report/${token}`)
      .then((res) => setReport(res.data))
      .catch((err) => {
        const msg = err?.response?.data?.error;
        setError(typeof msg === "string" ? msg : "战报加载失败");
      });
  }, [token]);

  // ============ 分镜组装 ============
  type Slide = { key: string; node: (active: boolean) => React.ReactNode };
  const slides: Slide[] = useMemo(() => {
    if (!report) return [];
    const p = report.personal;
    const fmtPeriod = (s: string) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}.${d.getDate()}`;
    };
    const fmtDate = (s: string) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    };

    // 空数据（且无团队榜可看）：只有一页
    if (p.visit_count === 0 && !(report.team && report.team.top_members.length > 0)) {
      return [
        {
          key: "empty",
          node: () => (
            <PageShell>
              <motion.div variants={fadeUp} className="text-white/50 tracking-[0.4em] text-sm">2026 · 盛夏战报</motion.div>
              <motion.h1 variants={fadeUp} className="mt-8 font-bold text-white" style={{ fontSize: "clamp(26px, 7vw, 38px)", lineHeight: 1.6 }}>
                这个夏天，
                <br />
                榜单上暂时没有你的故事
              </motion.h1>
              <Sub>{report.user.user_name} · {report.user.department}</Sub>
            </PageShell>
          ),
        },
      ];
    }

    const list: Slide[] = [];

    // 1. 封面
    list.push({
      key: "cover",
      node: () => (
        <PageShell>
          <motion.div variants={fadeUp} className="text-white/50 tracking-[0.4em]" style={{ fontSize: "clamp(12px, 3.4vw, 15px)" }}>
            2026 · 盛夏战报
          </motion.div>
          <motion.h1
            variants={fadeUp}
            className="mt-6 font-bold"
            style={{
              fontSize: "clamp(40px, 12vw, 64px)",
              lineHeight: 1.25,
              background: "linear-gradient(135deg, #fff, #ffd194)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            {report.user.user_name}
          </motion.h1>
          <Sub>{report.user.department}</Sub>
          <motion.div variants={fadeUp} className="mt-10 rounded-full border border-white/20 px-6 py-2 text-white/70" style={{ fontSize: "clamp(13px, 3.6vw, 16px)" }}>
            {fmtPeriod(report.period.start)} — {fmtPeriod(report.period.end)}
          </motion.div>
        </PageShell>
      ),
    });

    // 个人分镜（个人 0 拜访但有团队榜时，只展示封面 + 团队 + 结尾）
    if (p.visit_count > 0) {
    // 2. 拜访数
    list.push({
      key: "visits",
      node: (a) => (
        <PageShell>
          <motion.div variants={fadeUp} className="text-white/60" style={{ fontSize: "clamp(15px, 4vw, 18px)" }}>这个夏天，你敲开了</motion.div>
          <motion.div variants={fadeUp}>
            <BigNumber value={p.visit_count} active={a} />
          </motion.div>
          <Sub>次客户的门</Sub>
        </PageShell>
      ),
    });

    // 3. 客户
    list.push({
      key: "customers",
      node: (a) => (
        <PageShell>
          <motion.div variants={fadeUp}>
            <BigNumber value={p.customer_count} active={a} />
          </motion.div>
          <Sub>家客户，记住了你的名字</Sub>
          {p.top_customers.length > 0 && (
            <div className="mt-8 w-full max-w-[320px] space-y-3">
              {p.top_customers.slice(0, 5).map((c, i) => (
                <motion.div
                  key={c.name + i}
                  variants={fadeUp}
                  className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3 border border-white/10"
                >
                  <span className="flex items-center gap-3 text-white/90" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                    <span className="text-[#ff9a5a] font-semibold w-5">{i + 1}</span>
                    <span className="truncate max-w-[180px]">{c.name}</span>
                  </span>
                  <span className="text-white/50 text-sm">{c.count} 次</span>
                </motion.div>
              ))}
            </div>
          )}
        </PageShell>
      ),
    });

    // 4. 里程
    const roundTrips = p.distance_km / 2200;
    list.push({
      key: "distance",
      node: (a) => (
        <PageShell>
          <motion.div variants={fadeUp} className="flex items-baseline gap-2">
            <BigNumber value={p.distance_km} decimals={p.distance_km < 100 ? 1 : 0} active={a} />
            <span className="text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>公里</span>
          </motion.div>
          <Sub>
            {roundTrips >= 0.5 ? (
              <>相当于从深圳到北京，{roundTrips.toFixed(1)} 个来回</>
            ) : (
              <>相当于绕标准操场 {Math.round(p.distance_km / 0.4)} 圈</>
            )}
          </Sub>
        </PageShell>
      ),
    });

    // 5. 足迹地图（无坐标点则跳过）
    if (p.points.length > 0) {
      list.push({
        key: "map",
        node: (a) => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              {p.city_count > 0 && (
                <motion.div variants={fadeUp}>
                  <BigNumber value={p.city_count} active={a} />
                </motion.div>
              )}
              <Sub>{p.city_count > 0 ? "座城市，留下过你的足迹" : "你的足迹，遍布这个夏天的路"}</Sub>
              <FootprintMap points={p.points} active={a} />
            </div>
          </PageShell>
        ),
      });
    }

    // 6. 最忙的一天
    if (p.busiest_day) {
      list.push({
        key: "busiest",
        node: () => (
          <PageShell>
            <motion.div variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(30px, 8.5vw, 46px)" }}>
              {fmtDate(p.busiest_day!.date)}
            </motion.div>
            <Sub>
              是你最拼的一天，
              <br />
              一天跑了 <span className="text-[#ff9a5a] font-semibold">{p.busiest_day!.visit_count}</span> 家
            </Sub>
          </PageShell>
        ),
      });
    }

    // 7. 最早的一天
    if (p.earliest_visit) {
      list.push({
        key: "earliest",
        node: () => (
          <PageShell>
            <motion.div
              variants={fadeUp}
              className="font-bold tabular-nums"
              style={{
                fontSize: "clamp(52px, 16vw, 84px)",
                background: "linear-gradient(135deg, #ffd194, #ff9a5a)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              {p.earliest_visit!.time}
            </motion.div>
            <Sub>
              城市还没醒，
              <br />
              你已经出发了
            </Sub>
          </PageShell>
        ),
      });
    }

    }

    // 8. 团队榜
    if (report.team && report.team.top_members.length > 0) {
      const medal = ["#ffd700", "#c0c0c0", "#cd7f32"];
      list.push({
        key: "team",
        node: () => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                你身后，还有一支队伍
              </motion.h2>
              <Sub>
                {report.team!.member_count} 人同行 · 全队 {report.team!.total_visits} 次拜访 · {Math.round(report.team!.total_distance_km)} 公里
              </Sub>
              <div className="mt-6 w-full max-w-[340px] space-y-2 overflow-hidden">
                {report.team!.top_members.slice(0, 10).map((m, i) => (
                  <motion.div
                    key={m.user_name + i}
                    variants={fadeUp}
                    className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5"
                  >
                    <span
                      className="w-6 text-center font-bold"
                      style={{ color: i < 3 ? medal[i] : "rgba(255,255,255,0.45)", fontSize: "clamp(14px, 4vw, 17px)" }}
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate text-left text-white/90" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                      {m.user_name}
                    </span>
                    <span className="text-white/60 text-sm tabular-nums">{m.visit_count} 次</span>
                    <span className="text-white/40 text-xs tabular-nums w-16 text-right">{Math.round(m.distance_km)} km</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </PageShell>
        ),
      });
    }

    // 9. 结尾
    list.push({
      key: "finale",
      node: (a) => (
        <PageShell>
          <motion.div variants={fadeUp} className="flex items-baseline gap-2">
            <BigNumber value={p.visit_count > 0 ? p.active_days : (report.team?.total_visits ?? 0)} active={a} />
            <span className="text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>{p.visit_count > 0 ? "天" : "次拜访"}</span>
          </motion.div>
          <Sub>
            {p.visit_count > 0 ? (
              <>
                天奔波，山海自有归期，风雨自有相逢。
                <br />
                下一程，继续加油。
              </>
            ) : (
              <>
                这是团队一起走过的夏天。
                <br />
                山海自有归期，下一程继续加油。
              </>
            )}
          </Sub>
          <motion.button
            variants={fadeUp}
            className="mt-10 cursor-pointer rounded-full border border-[#ff9a5a]/60 bg-transparent px-8 py-2.5 text-[#ffb37e] transition hover:bg-[#ff9a5a]/10"
            style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}
            onClick={() => {
              setDirection(-1);
              setPage(0);
            }}
          >
            从头再看一遍
          </motion.button>
        </PageShell>
      ),
    });

    return list;
  }, [report]);

  const total = slides.length;

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total || next === page) return;
      setDirection(next > page ? 1 : -1);
      setPage(next);
    },
    [page, total]
  );

  // ============ 手势 / 滚轮翻页 ============
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (touchStartY.current === null) return;
      const deltaY = touchStartY.current - e.changedTouches[0].clientY;
      touchStartY.current = null;
      if (Math.abs(deltaY) < 50) return;
      goTo(deltaY > 0 ? page + 1 : page - 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (wheelLock.current || Math.abs(e.deltaY) < 24) return;
      wheelLock.current = true;
      setTimeout(() => (wheelLock.current = false), 700);
      goTo(e.deltaY > 0 ? page + 1 : page - 1);
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("wheel", onWheel);
    };
  }, [page, goTo]);

  // ============ 错误态 ============
  if (error) {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ background: "linear-gradient(160deg, #1a1a2e, #16213e)" }}>
        <div className="text-center px-8">
          <div className="text-white/80 font-medium" style={{ fontSize: "clamp(18px, 5vw, 24px)" }}>{error}</div>
          <div className="mt-3 text-white/40 text-sm">请确认链接正确，或联系管理员重新获取</div>
        </div>
      </div>
    );
  }

  // ============ 加载态 ============
  if (!report) {
    return (
      <div className="flex h-screen w-full items-center justify-center" style={{ background: "linear-gradient(160deg, #1a1a2e, #16213e)" }}>
        <div className="text-white/50 tracking-widest text-sm">战报生成中…</div>
      </div>
    );
  }

  const slide = slides[page];

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 55%, #1f1a33 100%)" }}>
      {/* 漂移光斑 */}
      <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full opacity-30 blur-3xl" style={{ background: "#ff7e3f", animation: "sr-drift1 18s ease-in-out infinite alternate" }} />
      <div className="pointer-events-none absolute -right-28 top-1/3 h-96 w-96 rounded-full opacity-25 blur-3xl" style={{ background: "#4a6fa5", animation: "sr-drift2 22s ease-in-out infinite alternate" }} />
      <div className="pointer-events-none absolute bottom-[-80px] left-1/4 h-72 w-72 rounded-full opacity-20 blur-3xl" style={{ background: "#ffd194", animation: "sr-drift1 26s ease-in-out infinite alternate-reverse" }} />
      <style>{`
        @keyframes sr-drift1 { from { transform: translate(0,0) scale(1); } to { transform: translate(60px,40px) scale(1.15); } }
        @keyframes sr-drift2 { from { transform: translate(0,0) scale(1); } to { transform: translate(-50px,60px) scale(0.9); } }
        @keyframes sr-bounce { 0%,100% { transform: translateY(0); opacity:.9 } 50% { transform: translateY(10px); opacity:.4 } }
      `}</style>

      {/* 内容容器：窄屏居中，两侧透出背景 */}
      <div className="relative mx-auto h-full w-full max-w-[480px]">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={slide.key}
            className="absolute inset-0"
            custom={direction}
            initial={{ y: direction > 0 ? "100%" : "-100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: direction > 0 ? "-60%" : "60%", opacity: 0 }}
            transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
          >
            {slide.node(true)}
          </motion.div>
        </AnimatePresence>

        {/* 页码指示器 */}
        {total > 1 && (
          <div className="absolute bottom-6 right-4 z-10 flex flex-col gap-1.5">
            {slides.map((s, i) => (
              <button
                key={s.key}
                aria-label={`第 ${i + 1} 页`}
                onClick={() => goTo(i)}
                className="cursor-pointer rounded-full border-none transition-all"
                style={{
                  width: 6,
                  height: i === page ? 18 : 6,
                  background: i === page ? "#ff9a5a" : "rgba(255,255,255,0.25)",
                }}
              />
            ))}
          </div>
        )}

        {/* 首屏上滑提示 */}
        {page === 0 && total > 1 && (
          <div className="absolute bottom-6 left-0 right-0 z-10 flex flex-col items-center gap-1 text-white/60 pointer-events-none">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ animation: "sr-bounce 1.6s ease-in-out infinite" }}>
              <path d="M6 14l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-xs tracking-widest">上滑开启</span>
          </div>
        )}
      </div>
    </div>
  );
}
