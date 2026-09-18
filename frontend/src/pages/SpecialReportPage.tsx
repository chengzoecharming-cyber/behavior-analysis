import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import AMapLoader from "@amap/amap-jsapi-loader";
import html2canvas from "html2canvas";

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
    points: { lat: number; lng: number; date: string }[]; // date 用于足迹动画排序
    monthly: { month: string; visit_count: number }[]; // 'YYYY-MM'，含 0 月份
    weekday: { counts: number[]; top_weekday: number; top_count: number }; // counts[0]=周一
    longest_day: { date: string; distance_km: number } | null;
    percentile: number | null; // 超过全公司 X% 的人（0-100）
    title: { name: string; desc: string } | null;
    zero_anomaly: boolean;
  };
  team?: {
    member_count: number;
    total_visits: number;
    total_distance_km: number;
    top_members: { user_name: string; visit_count: number; distance_km: number }[];
    star_member: { user_name: string; visit_count: number } | null;
    most_improved: { user_name: string; growth: number } | null;
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

const ORANGE_GRADIENT = "linear-gradient(135deg, #ffd194, #ff9a5a 60%, #ff7e3f)";

// ============ 小部件 ============
function BigNumber({ value, decimals = 0, active }: { value: number; decimals?: number; active: boolean }) {
  const n = useCountUp(value, 1600, decimals, active);
  return (
    <div
      className="font-bold tabular-nums"
      style={{
        fontSize: "clamp(64px, 22vw, 120px)",
        lineHeight: 1.05,
        background: ORANGE_GRADIENT,
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

// ============ 迷你柱状图（纯 div + framer-motion 生长动画） ============
function BarChart({
  values,
  labels,
  highlightIndex,
  active,
  height = 140,
}: {
  values: number[];
  labels: string[];
  highlightIndex: number;
  active: boolean;
  height?: number;
}) {
  const max = Math.max(...values, 1);
  return (
    <motion.div variants={fadeUp} className="mt-8 flex w-full max-w-[320px] items-end justify-center gap-3" style={{ height }}>
      {values.map((v, i) => {
        const hot = i === highlightIndex;
        const barH = Math.max((v / max) * (height - 34), 3);
        return (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-2" style={{ height: "100%" }}>
            <span className="tabular-nums" style={{ fontSize: 11, color: hot ? "#ffb37e" : "rgba(255,255,255,0.4)" }}>
              {v > 0 ? v : ""}
            </span>
            <motion.div
              className="w-full rounded-t-md"
              style={{
                background: hot ? ORANGE_GRADIENT : "rgba(255,255,255,0.16)",
                boxShadow: hot ? "0 0 18px rgba(255,154,90,0.4)" : "none",
              }}
              initial={{ height: 0 }}
              animate={active ? { height: barH } : { height: 0 }}
              transition={{ duration: 0.8, delay: 0.4 + i * 0.12, ease: "easeOut" }}
            />
            <span className="text-white/60" style={{ fontSize: "clamp(11px, 3.2vw, 13px)" }}>
              {labels[i]}
            </span>
          </div>
        );
      })}
    </motion.div>
  );
}

// ============ 足迹地图（按时间顺序点亮 + 连成橙色虚线） ============
function FootprintMap({ points, active }: { points: { lat: number; lng: number; date: string }[]; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active || !ref.current || mapRef.current || points.length === 0) return;
    let cancelled = false;
    const timers: number[] = [];
    AMapLoader.load({ key: AMAP_KEY, version: "2.0" })
      .then((AMap: any) => {
        if (cancelled || !ref.current) return;
        const map = new AMap.Map(ref.current, {
          zoom: 5,
          mapStyle: "amap://styles/darkblue",
          viewMode: "2D",
        });
        mapRef.current = map;

        // 按 date 排序，先布点（隐藏），再按时间顺序逐个亮起
        const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const markers = sorted.map(
          (p) =>
            new AMap.CircleMarker({
              center: [p.lng, p.lat],
              radius: 6,
              fillColor: "#ff9a5a",
              strokeColor: "#ffd194",
              strokeWeight: 1,
              fillOpacity: 0,
              strokeOpacity: 0,
              zIndex: 50,
            }).setMap(map)
        );
        // 点数多时加快节奏，保证整条动画在 ~4s 内完成
        const interval = Math.max(18, Math.min(80, 4000 / Math.max(sorted.length, 1)));
        markers.forEach((m: any, i: number) => {
          timers.push(
            window.setTimeout(() => {
              if (cancelled) return;
              m.setOptions({ fillOpacity: 0.85, strokeOpacity: 1 });
            }, i * interval)
          );
        });
        // 全部亮起后，按时间顺序连成渐变橙色虚线
        timers.push(
          window.setTimeout(
            () => {
              if (cancelled) return;
              new AMap.Polyline({
                path: sorted.map((p) => [p.lng, p.lat]),
                strokeColor: "#ff9a5a",
                strokeWeight: 3,
                strokeOpacity: 0.85,
                strokeStyle: "dashed",
                lineJoin: "round",
                zIndex: 40,
              }).setMap(map);
              map.setFitView();
            },
            markers.length * interval + 300
          )
        );
        map.setFitView();
      })
      .catch((e: any) => {
        console.error("AMap load failed:", e);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
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
  const [shareImg, setShareImg] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const shareCardRef = useRef<HTMLDivElement>(null);
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

  // ============ 生成分享卡片 ============
  const onShare = useCallback(async () => {
    if (!shareCardRef.current || shareBusy) return;
    setShareBusy(true);
    try {
      const canvas = await html2canvas(shareCardRef.current, { backgroundColor: null, scale: 2, useCORS: true });
      setShareImg(canvas.toDataURL("image/png"));
    } catch (e) {
      console.error("share card render failed:", e);
    } finally {
      setShareBusy(false);
    }
  }, [shareBusy]);

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

    // 3. 超越分位
    if (p.percentile != null) {
      list.push({
        key: "percentile",
        node: (a) => (
          <PageShell>
            <motion.div variants={fadeUp} className="flex items-baseline gap-1">
              <BigNumber value={p.percentile!} active={a} />
              <span
                className="font-bold"
                style={{
                  fontSize: "clamp(28px, 8vw, 44px)",
                  background: ORANGE_GRADIENT,
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                %
              </span>
            </motion.div>
            <Sub>超过了全公司 {p.percentile!}% 的同事</Sub>
          </PageShell>
        ),
      });
    }

    // 4. 客户
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

    // 5. 最常拜访客户
    if (p.top_customers.length > 0) {
      const top = p.top_customers[0];
      list.push({
        key: "top-customer",
        node: () => (
          <PageShell>
            <motion.div variants={fadeUp} className="text-white/60" style={{ fontSize: "clamp(15px, 4vw, 18px)" }}>最常拜访的客户是</motion.div>
            <motion.div
              variants={fadeUp}
              className="mt-6 font-bold"
              style={{
                fontSize: "clamp(28px, 8.5vw, 44px)",
                lineHeight: 1.35,
                background: ORANGE_GRADIENT,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                maxWidth: "100%",
                wordBreak: "break-all",
              }}
            >
              {top.name}
            </motion.div>
            <Sub>
              {top.count === 1 ? (
                "你们的故事才刚刚开始"
              ) : (
                <>这家客户，你去了 <span className="text-[#ff9a5a] font-semibold">{top.count}</span> 次，比回家还勤</>
              )}
            </Sub>
          </PageShell>
        ),
      });
    }

    // 6. 里程
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

    // 7. 单日最长里程
    if (p.longest_day) {
      list.push({
        key: "longest-day",
        node: (a) => (
          <PageShell>
            <motion.div variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(26px, 7.5vw, 38px)" }}>
              {fmtDate(p.longest_day!.date)}
            </motion.div>
            <motion.div variants={fadeUp} className="flex items-baseline gap-2">
              <BigNumber value={p.longest_day!.distance_km} decimals={p.longest_day!.distance_km < 100 ? 1 : 0} active={a} />
              <span className="text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>公里</span>
            </motion.div>
            <Sub>
              你一天跑了这么远，
              <br />
              车轮见证了你的拼
            </Sub>
          </PageShell>
        ),
      });
    }

    // 8. 足迹地图（无坐标点则跳过）
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

    // 9. 月度节奏
    if (p.monthly.length > 0) {
      const maxIdx = p.monthly.reduce((mi, m, i, arr) => (m.visit_count > arr[mi].visit_count ? i : mi), 0);
      const topMonth = Number(p.monthly[maxIdx].month.split("-")[1]);
      list.push({
        key: "monthly",
        node: (a) => (
          <PageShell>
            <motion.div variants={fadeUp} className="text-white/60" style={{ fontSize: "clamp(15px, 4vw, 18px)" }}>这个夏天的每个月，你都没闲着</motion.div>
            <BarChart
              values={p.monthly.map((m) => m.visit_count)}
              labels={p.monthly.map((m) => `${Number(m.month.split("-")[1])}月`)}
              highlightIndex={maxIdx}
              active={a}
            />
            <Sub>{topMonth} 月的你，最上头</Sub>
          </PageShell>
        ),
      });
    }

    // 10. 星期人格
    if (p.weekday && p.weekday.counts.length === 7 && p.weekday.top_count > 0) {
      const wdNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      list.push({
        key: "weekday",
        node: (a) => (
          <PageShell>
            <motion.div
              variants={fadeUp}
              className="font-bold"
              style={{
                fontSize: "clamp(44px, 13vw, 68px)",
                lineHeight: 1.2,
                background: ORANGE_GRADIENT,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              {wdNames[p.weekday.top_weekday - 1] ?? ""}
            </motion.div>
            <Sub>是你最爱的工作日</Sub>
            <BarChart values={p.weekday.counts} labels={["一", "二", "三", "四", "五", "六", "日"]} highlightIndex={p.weekday.top_weekday - 1} active={a} height={110} />
          </PageShell>
        ),
      });
    }

    // 11. 最忙的一天
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

    // 12. 最早的一天
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

    // 13. 全勤彩蛋（0 异常才展示）
    if (p.zero_anomaly) {
      list.push({
        key: "clean",
        node: (a) => (
          <PageShell>
            <motion.div variants={fadeUp} className="flex items-baseline gap-2">
              <BigNumber value={0} active={a} />
              <span className="text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>异常</span>
            </motion.div>
            <Sub>
              三个月，干干净净。
              <br />
              稳。
            </Sub>
          </PageShell>
        ),
      });
    }

    // 14. 称号页（压轴）：名字 + 称号 + 数据证据
    if (p.title) {
      const titleEvidence = (() => {
        switch (p.title!.name) {
          case "卷王":
            return `拜访 ${p.visit_count} 次，超过全公司 ${p.percentile ?? 90}% 的同事`;
          case "行者":
            return `三个月跑了 ${Math.round(p.distance_km)} 公里，跻身全公司前 10%`;
          case "追光者":
            return p.earliest_visit ? `最早一次出发，是 ${p.earliest_visit.time}` : p.title!.desc;
          case "劳模":
            return `${p.active_days} 个活跃工作日，一半以上的日子都在路上`;
          default:
            return p.title!.desc;
        }
      })();
      list.push({
        key: "title",
        node: () => (
          <PageShell>
            <motion.div variants={fadeUp} className="text-white/60 tracking-[0.3em]" style={{ fontSize: "clamp(13px, 3.6vw, 16px)" }}>
              这个夏天，{report.user.user_name} 的称号是
            </motion.div>
            <motion.div
              variants={fadeUp}
              className="mt-8 font-bold"
              style={{
                fontSize: "clamp(64px, 22vw, 110px)",
                lineHeight: 1.2,
                letterSpacing: "0.12em",
                background: ORANGE_GRADIENT,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                textShadow: "0 0 60px rgba(255,154,90,0.25)",
              }}
            >
              {p.title!.name}
            </motion.div>
            <Sub>{p.title!.desc}</Sub>
            <motion.div variants={fadeUp} className="mt-6 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-white/70" style={{ fontSize: "clamp(12px, 3.4vw, 15px)" }}>
              {titleEvidence}
            </motion.div>
          </PageShell>
        ),
      });
    }

    }

    // 15. 团队：总览+奖项一页，排行榜单独一页
    if (report.team && report.team.top_members.length > 0) {
      const medal = ["#ffd700", "#c0c0c0", "#cd7f32"];
      const t = report.team;
      list.push({
        key: "team-overview",
        node: (a) => (
          <PageShell>
            <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
              你身后，还有一支队伍
            </motion.h2>
            <Sub>
              {t.member_count} 人同行 · 全队 {t.total_visits} 次拜访 · {Math.round(t.total_distance_km)} 公里
            </Sub>
            <div className="mt-6 flex w-full max-w-[340px] flex-col items-center gap-2">
              <motion.div variants={fadeUp} className="flex items-baseline gap-2">
                <BigNumber value={t.total_visits} active={a} />
                <span className="whitespace-nowrap text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>次团队拜访</span>
              </motion.div>
              {t.star_member && (
                <motion.div variants={fadeUp} className="mt-4 flex w-full items-center justify-between rounded-xl border border-[#ff9a5a]/30 bg-[#ff9a5a]/10 px-4 py-2.5">
                  <span className="text-[#ffb37e]" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>🏆 本区之星</span>
                  <span className="text-white/90" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                    {t.star_member.user_name}
                    <span className="ml-2 text-white/50 text-sm">{t.star_member.visit_count} 次</span>
                  </span>
                </motion.div>
              )}
              {t.most_improved && (
                <motion.div variants={fadeUp} className="flex w-full items-center justify-between rounded-xl border border-[#ff9a5a]/30 bg-[#ff9a5a]/10 px-4 py-2.5">
                  <span className="text-[#ffb37e]" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>📈 进步最大</span>
                  <span className="text-white/90" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                    {t.most_improved.user_name}
                    <span className="ml-2 text-white/50 text-sm">+{t.most_improved.growth} 次</span>
                  </span>
                </motion.div>
              )}
            </div>
          </PageShell>
        ),
      });
      list.push({
        key: "team",
        node: () => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                团队排行榜
              </motion.h2>
              <Sub>这个夏天，跑得最勤的他们</Sub>
              <div className="mt-5 w-full max-w-[340px] space-y-2 overflow-hidden">
                {t.top_members.slice(0, 10).map((m, i) => (
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

    // 16. 结尾 + 分享卡片
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
                山海自有归期，风雨自有相逢。
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
          <motion.div variants={fadeUp} className="mt-10 flex flex-col items-center gap-3">
            <button
              className="cursor-pointer rounded-full border border-[#ff9a5a]/60 bg-transparent px-8 py-2.5 text-[#ffb37e] transition hover:bg-[#ff9a5a]/10"
              style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}
              onClick={() => {
                setDirection(-1);
                setPage(0);
              }}
            >
              从头再看一遍
            </button>
            <button
              className="cursor-pointer rounded-full border-none px-8 py-2.5 font-semibold text-[#1a1a2e] transition hover:opacity-90 disabled:opacity-60"
              style={{ fontSize: "clamp(14px, 3.8vw, 16px)", background: ORANGE_GRADIENT }}
              onClick={onShare}
              disabled={shareBusy}
            >
              {shareBusy ? "生成中…" : "生成分享卡片"}
            </button>
          </motion.div>
        </PageShell>
      ),
    });

    return list;
  }, [report, onShare, shareBusy]);

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
  const p = report.personal;
  const sharePeriod = `${fmtPeriodS(report.period.start)} — ${fmtPeriodS(report.period.end)}`;

  function fmtPeriodS(s: string) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}.${d.getDate()}`;
  }

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

      {/* 隐藏的分享卡片 DOM（html2canvas 截图源） */}
      <div style={{ position: "fixed", left: -2000, top: 0, pointerEvents: "none" }}>
        <div
          ref={shareCardRef}
          style={{
            width: 375,
            height: 600,
            padding: "48px 32px",
            background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 55%, #1f1a33 100%)",
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div style={{ color: "rgba(255,255,255,0.5)", letterSpacing: "0.4em", fontSize: 13 }}>2026 · 盛夏战报</div>
          <div style={{ marginTop: 20, fontSize: 34, fontWeight: 700 }}>{report.user.user_name}</div>
          <div style={{ marginTop: 6, color: "rgba(255,255,255,0.55)", fontSize: 14 }}>{report.user.department}</div>
          <div style={{ marginTop: 8, color: "rgba(255,255,255,0.45)", fontSize: 13 }}>{sharePeriod}</div>
          {p.title && (
            <div
              style={{
                marginTop: 26,
                fontSize: 40,
                fontWeight: 700,
                letterSpacing: "0.12em",
                color: "#ff9a5a",
              }}
            >
              {p.title.name}
            </div>
          )}
          <div style={{ marginTop: p.title ? 24 : 48, width: "100%", display: "flex", justifyContent: "space-around" }}>
            {(p.visit_count > 0 || !report.team
              ? [
                  { label: "拜访次数", value: p.visit_count, unit: "次" },
                  { label: "客户", value: p.customer_count, unit: "家" },
                  { label: "里程", value: Math.round(p.distance_km), unit: "km" },
                ]
              : [
                  { label: "团队人数", value: report.team.member_count, unit: "人" },
                  { label: "团队拜访", value: report.team.total_visits, unit: "次" },
                  { label: "团队里程", value: Math.round(report.team.total_distance_km), unit: "km" },
                ]
            ).map((it) => (
              <div key={it.label} style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 700,
                    color: "#ff9a5a",
                  }}
                >
                  {it.value.toLocaleString()}
                </div>
                <div style={{ marginTop: 4, color: "rgba(255,255,255,0.55)", fontSize: 13 }}>
                  {it.label} · {it.unit}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, letterSpacing: "0.2em" }}>山海自有归期 · 下一程继续加油</div>
        </div>
      </div>

      {/* 分享卡片预览弹层 */}
      <AnimatePresence>
        {shareImg && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 px-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShareImg(null)}
          >
            <motion.img
              src={shareImg}
              alt="分享卡片"
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="max-h-[72vh] w-auto rounded-2xl border border-white/15 shadow-2xl"
            />
            <div className="mt-5 text-white/70" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>长按保存图片</div>
            <div className="mt-1 text-white/35 text-xs">点击任意处关闭</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
