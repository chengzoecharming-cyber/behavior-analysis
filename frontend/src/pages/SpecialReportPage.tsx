import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import AMapLoader from "@amap/amap-jsapi-loader";
import html2canvas from "html2canvas";
import { Lottie } from "lottie-react";
import { AmbientAudio } from "../components/report/ambientAudio";
import { ReportImage } from "../components/report/ReportImage";
import { RunnerSvg } from "../components/report/RunnerSvg";
import { CustomerMatrix } from "../components/report/CustomerMatrix";
import { WeeklyWave } from "../components/report/WeeklyWave";
import { CalendarDots, longestStreak } from "../components/report/CalendarDots";
import { WeekdayEmoji } from "../components/report/WeekdayEmoji";
import { EarliestWindows } from "../components/report/EarliestWindows";
// ============ 类型（与后端契约一致） ============
interface SpecialReport {
  scope: "staff" | "manager" | "admin";
  user: { user_id: string; user_name: string; department: string };
  period: { start: string; end: string };
  /** 来自 token：'personal' 只显示个人分镜，'team' 只显示团队分镜，null/undefined 全显示（存量链接） */
  kind?: "personal" | "team" | null;
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
    daily?: { date: string; visit_count: number }[]; // 逐日拜访（含 0）
    weekly?: { week_start: string; visit_count: number }[]; // 逐周（周一开头）
    earliest_days?: { date: string; time: string }[]; // 最早签到的前 5 天，time=HH:MM 北京时间
    customer_tiles?: { name: string; count: number }[]; // 全量客户计数降序，最多 40
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
    member_highlights?: {
      user_name: string;
      visit_count: number;
      distance_km: number;
      title_name: string | null; // 卷王/行者/追光者/劳模
      top_customer_name: string | null;
      top_customer_count: number;
      longest_day_km: number;
    }[]; // 按拜访数降序
    frequent_pairs?: { user_name: string; customer_name: string; count: number }[]; // 单人单客户 >10 次，降序
    daily?: { date: string; visit_count: number }[]; // 团队逐日拜访
    weekly?: { week_start: string; visit_count: number }[]; // 团队逐周（周一开头）
    weekday?: { counts: number[]; top_weekday: number; top_count: number }; // counts[0]=周一
    earliest_days?: { user_name: string; date: string; time: string }[]; // 全团队最早 5 次签到，带人名
  };
  // 仅 admin：战报打开情况
  open_stats?: { user_name: string; user_id: string; views: number; last_viewed: string | null }[];
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
    <motion.div
      className="font-bold tabular-nums"
      // 数字落地后做一次 spring 回弹（1600ms 滚动结束 → 1.06 → 1）
      animate={active ? { scale: [1, 1, 1.06, 1] } : { scale: 1 }}
      transition={{ duration: 2.2, times: [0, 0.73, 0.86, 1], ease: "easeOut" }}
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
    </motion.div>
  );
}

// ============ Lottie 动画（/lottie 下的静态 JSON，仅在 slide 激活时渲染） ============
// progressiveLoad：按需分段加载矢量数据，降低首帧开销；非 loop 动画播完即卸载，不再占渲染资源
function LottieAnim({ src, loop, active, size }: { src: string; loop: boolean; active: boolean; size: number }) {
  const [done, setDone] = useState(false);
  if (!active || done) return null;
  return (
    <Lottie
      src={src}
      autoplay
      loop={loop}
      rendererSettings={{ progressiveLoad: true }}
      subscriptions={loop ? undefined : { complete: () => setDone(true) }}
      style={{ width: size, height: size }}
    />
  );
}

// ============ 页面外壳：插画背景（bg）作为同容器第一层，与内容一起滑入滑出 ============
// bg 用非 motion 的普通 div：不参与 stagger、不延迟，页面出现第一时间就位；
// 内容子元素仍走 fadeUp stagger 浮入。整页只有这一个滑动容器，翻页感知为「一页纸」。
// 有 bg 的页面自包含且不透明：背景层自带 #1a1a2e 底色铺满整页（含图片未加载/加载失败时），
// 翻页时底下的全局渐变完全不可见。
const DEFAULT_BG_OVERLAY = "linear-gradient(180deg, rgba(26,26,46,0.2) 0%, rgba(26,26,46,0.22) 45%, rgba(26,26,46,0.6) 100%)";

function PageShell({
  children,
  center = true,
  bg,
  bgOverlay,
}: {
  children: React.ReactNode;
  center?: boolean;
  bg?: string;
  bgOverlay?: string;
}) {
  return (
    <motion.div
      className={`absolute inset-0 flex flex-col px-8 py-12 ${center ? "items-center justify-center text-center" : ""}`}
      variants={stagger}
      initial="hidden"
      animate="show"
      exit="hidden"
    >
      {bg && (
        // zIndex:-1 压在 PageShell 静态内容之下；自身不透明（底色+插画），盖住全局渐变底
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: -1, background: "#1a1a2e" }} aria-hidden>
          <ReportImage src={bg} className="h-full w-full" />
          <div
            className="absolute inset-0"
            style={{ background: bgOverlay ?? DEFAULT_BG_OVERLAY }}
          />
        </div>
      )}
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

// ============ 封面大标题：/report/cover-title.png 存在则用书法字（透明底 PNG），否则用文字标题 ============
function CoverTitle({ name }: { name: string }) {
  const [imgOk, setImgOk] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgOk(true);
    img.src = "/report/cover-title.png";
    return () => {
      img.onload = null;
    };
  }, []);
  if (imgOk) {
    return (
      <>
        <motion.img
          variants={fadeUp}
          src="/report/cover-title.png"
          alt="盛夏战报"
          className="mt-6 w-full max-w-[320px]"
          style={{}}
        />
        <motion.div variants={fadeUp} className="mt-5 font-semibold text-white" style={{ fontSize: "clamp(22px, 6vw, 30px)", letterSpacing: "0.1em" }}>
          {name}
        </motion.div>
      </>
    );
  }
  return (
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
      {name}
    </motion.h1>
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
    <motion.div
      variants={fadeUp}
      className="mt-6 w-full overflow-hidden rounded-2xl border border-white/10"
      style={{ height: "46vh" }}
      // 地图自身要拖动缩放，阻止冒泡触发整页翻页拖拽
      onPointerDown={(e) => e.stopPropagation()}
    >
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
  const wheelLock = useRef(false);
  const audioRef = useRef<AmbientAudio | null>(null);
  const [audioStarted, setAudioStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  // 陀螺仪视差：光斑层按 gamma/beta 小幅度平移（iOS 权限在音乐按钮点击里申请）
  useEffect(() => {
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const onOrient = (e: DeviceOrientationEvent) => {
      const nx = Math.round(clamp1((e.gamma ?? 0) / 45) * 15);
      const ny = Math.round(clamp1(((e.beta ?? 45) - 45) / 45) * 15);
      setTilt((prev) => (prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny }));
    };
    window.addEventListener("deviceorientation", onOrient);
    return () => window.removeEventListener("deviceorientation", onOrient);
  }, []);

  // 卸载时关闭 AudioContext
  useEffect(
    () => () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    },
    []
  );

  // 音乐按钮：首次点击启动 BGM（必须用户手势），之后切换静音；顺带申请陀螺仪权限
  const onMusicClick = useCallback(() => {
    const doe = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } })
      .DeviceOrientationEvent;
    if (doe && typeof doe.requestPermission === "function") {
      doe.requestPermission().catch(() => {});
    }
    if (!audioStarted) {
      audioRef.current = new AmbientAudio();
      audioRef.current.start();
      setAudioStarted(true);
      return;
    }
    const m = !muted;
    audioRef.current?.setMuted(m);
    setMuted(m);
  }, [audioStarted, muted]);

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

  // 预载本报告会用到的插画：进入页面即拉取，保证各页背景与内容同时出现
  useEffect(() => {
    if (!report) return;
    ["cover", "visits", "customer", "distance", "busiest", "earliest", "finale"].forEach((name) => {
      const img = new Image();
      img.src = `/report/${name}.webp`;
    });
  }, [report]);

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
    // kind 来自 token：personal 只保留个人分镜，team 只保留团队分镜，null/undefined（存量链接）全显示
    const kind = report.kind ?? null;
    const showPersonal = kind !== "team";
    const showTeam = kind !== "personal";
    const hasTeam = !!(report.team && report.team.top_members.length > 0);
    const fmtPeriod = (s: string) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}.${d.getDate()}`;
    };
    const fmtDate = (s: string) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    };

    // 空数据（按 kind 口径：个人版看个人数据，团队版看团队榜）：只有一页
    const emptyPersonal = showPersonal && p.visit_count === 0;
    const emptyTeam = showTeam && !hasTeam;
    if ((kind === "team" && emptyTeam) || (kind === "personal" && emptyPersonal) || (kind === null && emptyPersonal && emptyTeam)) {
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

    // 0. 开场悬念页：两行字逐行淡入，~4.7s 后自动进入封面；点击/上滑可跳过
    list.push({
      key: "intro",
      node: () => (
        <div
          className="absolute inset-0 cursor-pointer"
          onClick={() => {
            setDirection(1);
            setPage(1);
          }}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center px-10 text-center" style={{ background: "#0d0d17" }}>
            {/* 与封面同款背景，压暗到 ~25% 亮度：intro→封面是同一张图由暗到亮的连续过程 */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
              <ReportImage src="/report/cover.webp" breathe={false} className="h-full w-full" style={{ opacity: 0.9 }} />
              <div className="absolute inset-0" style={{ background: "rgba(13,13,23,0.75)" }} />
            </div>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.9, ease: "easeOut" }}
              className="relative text-white/85"
              style={{ fontSize: "clamp(19px, 5.4vw, 26px)", lineHeight: 1.9, letterSpacing: "0.08em", textShadow: "0 2px 14px rgba(0,0,0,0.85)" }}
            >
              2026 年的夏天，就要过去了。
            </motion.p>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.2, duration: 0.9, ease: "easeOut" }}
              className="relative mt-5 text-white/85"
              style={{ fontSize: "clamp(19px, 5.4vw, 26px)", lineHeight: 1.9, letterSpacing: "0.08em", textShadow: "0 2px 14px rgba(0,0,0,0.85)" }}
            >
              但有些数字，值得被记住。
            </motion.p>
          </div>
        </div>
      ),
    });

    // 1. 封面（cover.webp 整页背景 + 底部渐变融入；书法字图存在则替换文字标题；底部静态站姿 Runner）
    list.push({
      key: "cover",
      node: () => (
        <PageShell
          bg="/report/cover.webp"
          bgOverlay="linear-gradient(180deg, rgba(26,26,46,0.45) 0%, rgba(26,26,46,0.35) 45%, rgba(26,26,46,0.85) 78%, #1a1a2e 100%)"
        >
          <motion.div variants={fadeUp} className="text-white/50 tracking-[0.4em]" style={{ fontSize: "clamp(12px, 3.4vw, 15px)" }}>
              2026 · 盛夏战报
            </motion.div>
            <CoverTitle name={report.user.user_name} />
            {kind === "team" ? (
              <>
                <motion.div variants={fadeUp} className="mt-5 font-semibold text-white" style={{ fontSize: "clamp(20px, 5.6vw, 28px)", letterSpacing: "0.06em" }}>
                  {report.user.department}
                </motion.div>
                <motion.div variants={fadeUp} className="mt-5 rounded-full border border-[#ff9a5a]/50 px-4 py-1 text-[#ffb37e]" style={{ fontSize: "clamp(12px, 3.2vw, 14px)", background: "rgba(26,26,46,0.35)" }}>
                  团队战报
                </motion.div>
              </>
            ) : (
              <Sub>{report.user.department}</Sub>
            )}
            <motion.div variants={fadeUp} className="mt-10 rounded-full border border-white/20 px-6 py-2 text-white/70" style={{ fontSize: "clamp(13px, 3.6vw, 16px)", background: "rgba(26,26,46,0.35)" }}>
              {fmtPeriod(report.period.start)} — {fmtPeriod(report.period.end)}
            </motion.div>
            <motion.div variants={fadeUp} className="mt-12">
              <RunnerSvg size={72} />
            </motion.div>
        </PageShell>
      ),
    });

    // 个人分镜（个人 0 拜访但有团队榜时，只展示封面 + 团队 + 结尾；kind='team' 时整段跳过）
    if (showPersonal && p.visit_count > 0) {
    // 2. 拜访数（visits.webp 全屏背景，文字垂直居中）
    list.push({
      key: "visits",
      node: (a) => (
        <PageShell bg="/report/visits.webp">
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

    // 4. 客户（customer.webp 全屏背景，文字垂直居中）
    list.push({
      key: "customers",
      node: (a) => (
        <PageShell bg="/report/customer.webp">
          <motion.div variants={fadeUp}>
            <BigNumber value={p.customer_count} active={a} />
          </motion.div>
          <Sub>家客户，记住了你的名字</Sub>
          {p.top_customers.length > 0 && (
            <div className="mt-6 w-full max-w-[320px] space-y-2.5">
              {p.top_customers.slice(0, 5).map((c, i) => (
                <motion.div
                  key={c.name + i}
                  variants={fadeUp}
                  className="flex items-center justify-between rounded-xl border border-white/10 px-4 py-2.5"
                  style={{ background: "rgba(13,13,23,0.45)" }}
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

    // 4b. 最常拜访客户（单客户页，文案不变）
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
              {top.count >= 3 ? (
                <>这家客户，你去了 <span className="text-[#ff9a5a] font-semibold">{top.count}</span> 次，比回家还勤</>
              ) : top.count === 2 ? (
                "这家客户，你专程去了 2 次"
              ) : (
                "你们的故事才刚刚开始"
              )}
            </Sub>
          </PageShell>
        ),
      });
    }

    // 5. 客户矩阵墙（等距 3D 斜排彩色方块，替代原"最常拜访客户"单文案页）
    if (p.customer_tiles && p.customer_tiles.length > 0) {
      list.push({
        key: "customer-matrix",
        node: (a) => (
          <PageShell center={false}>
            {/* 整体向上靠：减少顶部留白 */}
            <div className="flex h-full w-full flex-col items-center justify-start pt-[9vh] text-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                你的客户版图
              </motion.h2>
              <CustomerMatrix tiles={p.customer_tiles!} active={a} />
              <Sub>{p.customer_count} 家客户，各有各的故事</Sub>
            </div>
          </PageShell>
        ),
      });
    }

    // 6. 里程（distance.webp 全屏背景，Runner 从左侧跑入横穿过屏）
    const roundTrips = p.distance_km / 2200;
    list.push({
      key: "distance",
      node: (a) => (
        <>
          {a && (
            <motion.div
              className="pointer-events-none absolute bottom-[12vh] left-0 z-10"
              initial={{ x: -90, opacity: 0 }}
              animate={{ x: 500, opacity: [0, 1, 1, 0] }}
              transition={{ duration: 2.8, delay: 0.5, ease: "linear", times: [0, 0.08, 0.9, 1] }}
              aria-hidden
            >
              <RunnerSvg size={56} running />
            </motion.div>
          )}
          <PageShell bg="/report/distance.webp">
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
        </>
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

    // 9. 拜访节奏波形（逐周，替代原月度柱状）
    if (p.weekly && p.weekly.length > 1) {
      const peakIdx = p.weekly.reduce((mi, w, i, arr) => (w.visit_count > arr[mi].visit_count ? i : mi), 0);
      const peak = p.weekly[peakIdx];
      const peakDate = new Date(peak.week_start);
      const peakText = isNaN(peakDate.getTime())
        ? null
        : `${peakDate.getMonth() + 1} 月第 ${Math.ceil(peakDate.getDate() / 7)} 周是你的高峰（${peak.visit_count} 次）`;
      list.push({
        key: "rhythm",
        node: (a) => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                你的拜访节奏
              </motion.h2>
              <motion.div variants={fadeUp} className="mt-6 w-full">
                <WeeklyWave weekly={p.weekly!} active={a} />
              </motion.div>
              {peakText && <Sub>{peakText}</Sub>}
            </div>
          </PageShell>
        ),
      });
    }

    // 10. 外勤日历点阵（逐日，含最长连续天数）
    if (p.daily && p.daily.length > 0) {
      const streak = longestStreak(p.daily);
      list.push({
        key: "calendar",
        node: (a) => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(20px, 5.6vw, 28px)", lineHeight: 1.5 }}>
                这个夏天，你有 <span className="text-[#ff9a5a]">{p.active_days}</span> 天在外奔波
              </motion.h2>
              <motion.div variants={fadeUp} className="mt-6 w-full">
                <CalendarDots daily={p.daily!} active={a} />
              </motion.div>
              {streak > 1 && <Sub>最长连续 {streak} 天，脚步没有停</Sub>}
            </div>
          </PageShell>
        ),
      });
    }

    // 11. 一周作战风格（emoji 谱，替代原星期柱状）
    if (p.weekday && p.weekday.counts.length === 7 && p.weekday.top_count > 0) {
      const wdNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      list.push({
        key: "weekday",
        node: (a) => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                你最爱在<span style={{ background: ORANGE_GRADIENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{wdNames[p.weekday.top_weekday - 1] ?? ""}</span>打仗
              </motion.h2>
              <WeekdayEmoji counts={p.weekday.counts} active={a} />
            </div>
          </PageShell>
        ),
      });
    }

    // 11. 最忙的一天（busiest.webp 全屏背景）
    if (p.busiest_day) {
      list.push({
        key: "busiest",
        node: () => (
          <PageShell bg="/report/busiest.webp">
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

    // 12. 最早出发·窗户画框（earliest.webp 全屏背景压暗，earliest_days 前 5 天，兜底 earliest_visit 单窗）
    const earliestDays = p.earliest_days && p.earliest_days.length > 0 ? p.earliest_days : p.earliest_visit ? [p.earliest_visit] : [];
    if (earliestDays.length > 0) {
      list.push({
        key: "earliest",
        node: (a) => (
          <PageShell center={false} bg="/report/earliest.webp">
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(22px, 6vw, 30px)", lineHeight: 1.6 }}>
                这些天，城市还没醒
                <br />
                你就出发了
              </motion.h2>
              <EarliestWindows days={earliestDays} active={a} />
            </div>
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
        node: (a) => (
          <PageShell center={false}>
            {/* 垂直居中并整体上移 ~6vh */}
            <div className="flex h-full w-full flex-col items-center justify-center pb-[6vh] text-center">
            <motion.div variants={fadeUp} aria-hidden style={{ width: 120, height: 120 }}>
              <LottieAnim src="/lottie/trophy.json" loop active={a} size={120} />
            </motion.div>
            <motion.div variants={fadeUp} className="mt-2 text-white/60 tracking-[0.3em]" style={{ fontSize: "clamp(13px, 3.6vw, 16px)" }}>
              这个夏天，{report.user.user_name} 的称号是
            </motion.div>
            <motion.div
              variants={fadeUp}
              className="mt-4 font-bold"
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
            </div>
          </PageShell>
        ),
      });
    }

    }

    // 15. 团队：总览+奖项一页，排行榜单独一页（kind='personal' 时整段跳过）
    if (showTeam && report.team && report.team.top_members.length > 0) {
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

    // 15b. 成员图鉴（member_highlights 为空/undefined 时整页跳过）
    if (showTeam && report.team?.member_highlights && report.team.member_highlights.length > 0) {
      const mh = report.team.member_highlights;
      list.push({
        key: "member-highlights",
        node: () => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                成员图鉴
              </motion.h2>
              <Sub>这个夏天，各有各的精彩</Sub>
              <div className="mt-5 w-full max-w-[340px] space-y-2 overflow-hidden">
                {mh.slice(0, 8).map((m, i) => {
                  const fact =
                    m.top_customer_count >= 3 && m.top_customer_name
                      ? `最爱去 ${m.top_customer_name}，去了 ${m.top_customer_count} 次`
                      : m.longest_day_km >= 100
                        ? `一天跑过 ${Math.round(m.longest_day_km)} 公里`
                        : `拜访了 ${m.visit_count} 次`;
                  return (
                    <motion.div
                      key={m.user_name + i}
                      variants={fadeUp}
                      className="flex items-center gap-2.5 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5"
                    >
                      <span className="w-14 shrink-0 truncate text-left text-white/90 font-medium" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                        {m.user_name}
                      </span>
                      {m.title_name && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 font-medium"
                          style={{ fontSize: 11, background: "rgba(255,154,90,0.18)", color: "#ffb37e", border: "1px solid rgba(255,154,90,0.4)" }}
                        >
                          {m.title_name}
                        </span>
                      )}
                      <span className="flex-1 truncate text-right text-white/55" style={{ fontSize: "clamp(12px, 3.4vw, 14px)" }}>
                        {fact}
                      </span>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </PageShell>
        ),
      });
    }

    // 15c. 团队视角分镜（manager/admin 且有 team 时；字段 undefined/空则逐页跳过，staff 不出现）
    if (showTeam && report.team) {
      const t = report.team;

      // 高频搭档榜：单人单客户 >10 次的组合
      if (t.frequent_pairs && t.frequent_pairs.length > 0) {
        list.push({
          key: "team-pairs",
          node: () => (
            <PageShell center={false} bg="/report/customer.webp">
              <div className="flex h-full w-full flex-col items-center justify-center">
                <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                  最铁的组合
                </motion.h2>
                <Sub>这些搭档，一个夏天见了十几次</Sub>
                <div className="mt-5 w-full max-w-[340px] space-y-2 overflow-hidden">
                  {t.frequent_pairs!.slice(0, 8).map((fp, i) => (
                    <motion.div
                      key={fp.user_name + fp.customer_name + i}
                      variants={fadeUp}
                      className="flex items-center gap-2.5 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5"
                    >
                      <span className="flex-1 truncate text-left text-white/90" style={{ fontSize: "clamp(13px, 3.6vw, 15px)" }}>
                        {fp.user_name} <span className="text-white/40">×</span> {fp.customer_name}
                      </span>
                      <span
                        className="shrink-0 font-bold tabular-nums"
                        style={{
                          fontSize: "clamp(16px, 4.5vw, 20px)",
                          background: ORANGE_GRADIENT,
                          WebkitBackgroundClip: "text",
                          backgroundClip: "text",
                          color: "transparent",
                        }}
                      >
                        {fp.count} 次
                      </span>
                    </motion.div>
                  ))}
                </div>
              </div>
            </PageShell>
          ),
        });
      }

      // 团队日历点阵
      if (t.daily && t.daily.length > 0) {
        const teamActiveDays = t.daily.filter((d) => d.visit_count > 0).length;
        const hottest = t.daily.reduce((m, d) => (d.visit_count > m.visit_count ? d : m), t.daily[0]);
        list.push({
          key: "team-calendar",
          node: (a) => (
            <PageShell center={false} bg="/report/cover.webp">
              <div className="flex h-full w-full flex-col items-center justify-center text-center">
                <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(20px, 5.6vw, 28px)", lineHeight: 1.5 }}>
                  这个夏天，团队 <span className="text-[#ff9a5a]">{teamActiveDays}</span> 天有人在路上
                </motion.h2>
                <motion.div variants={fadeUp} className="mt-6 w-full">
                  <CalendarDots daily={t.daily!} active={a} />
                </motion.div>
                {hottest.visit_count > 0 && (
                  <Sub>
                    最热的一天是 {fmtDate(hottest.date)}，全队 {hottest.visit_count} 次拜访
                  </Sub>
                )}
              </div>
            </PageShell>
          ),
        });
      }

      // 团队拜访波形
      if (t.weekly && t.weekly.length > 1) {
        const peakIdx = t.weekly.reduce((mi, w, i, arr) => (w.visit_count > arr[mi].visit_count ? i : mi), 0);
        const peak = t.weekly[peakIdx];
        const peakDate = new Date(peak.week_start);
        const peakText = isNaN(peakDate.getTime())
          ? null
          : `${peakDate.getMonth() + 1} 月第 ${Math.ceil(peakDate.getDate() / 7)} 周，全队一起冲到了 ${peak.visit_count} 次`;
        list.push({
          key: "team-rhythm",
          node: (a) => (
            <PageShell center={false} bg="/report/distance.webp">
              <div className="flex h-full w-full flex-col items-center justify-center text-center">
                <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                  团队的拜访节奏
                </motion.h2>
                <motion.div variants={fadeUp} className="mt-6 w-full">
                  <WeeklyWave weekly={t.weekly!} active={a} />
                </motion.div>
                {peakText && <Sub>{peakText}</Sub>}
              </div>
            </PageShell>
          ),
        });
      }

      // 团队星期谱
      if (t.weekday && t.weekday.counts.length === 7 && t.weekday.top_count > 0) {
        const wdNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
        list.push({
          key: "team-weekday",
          node: (a) => (
            <PageShell center={false} bg="/report/busiest.webp">
              <div className="flex h-full w-full flex-col items-center justify-center text-center">
                <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                  团队最爱在<span style={{ background: ORANGE_GRADIENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{wdNames[t.weekday!.top_weekday - 1] ?? ""}</span>打仗
                </motion.h2>
                <WeekdayEmoji counts={t.weekday!.counts} active={a} />
              </div>
            </PageShell>
          ),
        });
      }

      // 全公司最早出发（带人名的窗户画框）
      if (t.earliest_days && t.earliest_days.length > 0) {
        list.push({
          key: "team-earliest",
          node: (a) => (
            <PageShell center={false} bg="/report/earliest.webp">
              <div className="flex h-full w-full flex-col items-center justify-center text-center">
                <motion.h2 variants={fadeUp} className="font-bold text-white" style={{ fontSize: "clamp(22px, 6vw, 30px)", lineHeight: 1.6 }}>
                  这些天，总有人
                  <br />
                  比城市先醒
                </motion.h2>
                <EarliestWindows days={t.earliest_days!} active={a} />
              </div>
            </PageShell>
          ),
        });
      }
    }

    // 15d. 战报的回响（仅 admin，open_stats 为 undefined 时整页跳过）
    if (showTeam && report.open_stats !== undefined) {
      const fmtViewed = (s: string | null) => {
        if (!s) return "—";
        const d = new Date(s);
        return isNaN(d.getTime())
          ? s
          : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      const rows = [...report.open_stats].sort((a, b) => b.views - a.views).slice(0, 10);
      list.push({
        key: "open-stats",
        node: () => (
          <PageShell center={false}>
            <div className="flex h-full w-full flex-col items-center justify-center">
              <motion.h2 variants={fadeUp} className="font-bold text-white text-center" style={{ fontSize: "clamp(24px, 6.5vw, 34px)" }}>
                战报的回响
              </motion.h2>
              <Sub>谁已经看过了</Sub>
              {rows.length === 0 ? (
                <motion.div variants={fadeUp} className="mt-10 text-white/50" style={{ fontSize: "clamp(14px, 3.8vw, 16px)", lineHeight: 1.9 }}>
                  还没有人打开，
                  <br />
                  快去推送吧
                </motion.div>
              ) : (
                <div className="mt-5 w-full max-w-[340px] space-y-2 overflow-hidden">
                  {rows.map((r, i) => (
                    <motion.div
                      key={r.user_id + i}
                      variants={fadeUp}
                      className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5"
                    >
                      <span className="flex-1 truncate text-left text-white/90" style={{ fontSize: "clamp(14px, 3.8vw, 16px)" }}>
                        {r.user_name}
                      </span>
                      <span className="shrink-0 tabular-nums text-[#ff9a5a] text-sm">{r.views} 次</span>
                      <span className="shrink-0 tabular-nums text-white/40 text-xs">{fmtViewed(r.last_viewed)}</span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </PageShell>
        ),
      });
    }

    // 16. 结尾 + 分享卡片（finale.webp 全屏背景）
    list.push({
      key: "finale",
      node: (a) => (
        <PageShell bg="/report/finale.webp">
          {/* 进入时播放一轮烟花 */}
          {a && (
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center" aria-hidden>
              <LottieAnim src="/lottie/fireworks.json" loop={false} active={a} size={280} />
            </div>
          )}
          <motion.div variants={fadeUp} className="flex items-baseline gap-2">
            <BigNumber value={p.visit_count > 0 && kind !== "team" ? p.active_days : (report.team?.total_visits ?? 0)} active={a} />
            <span className="text-white/70" style={{ fontSize: "clamp(18px, 5vw, 26px)" }}>{p.visit_count > 0 && kind !== "team" ? "天" : "次拜访"}</span>
          </motion.div>
          <Sub>
            {p.visit_count > 0 && kind !== "team" ? (
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

  // ============ 滚轮翻页（触摸翻页走 slide 容器的 drag="y" 拖拽跟随） ============
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (wheelLock.current || Math.abs(e.deltaY) < 24) return;
      wheelLock.current = true;
      setTimeout(() => (wheelLock.current = false), 700);
      goTo(e.deltaY > 0 ? page + 1 : page - 1);
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
    };
  }, [page, goTo]);

  // ============ 开场页自动进入封面 / 翻页音效 ============
  const currentKey = slides[page]?.key;
  useEffect(() => {
    if (currentKey !== "intro") return;
    const t = window.setTimeout(() => {
      setDirection(1);
      setPage(1);
    }, 4700);
    return () => window.clearTimeout(t);
  }, [currentKey]);

  useEffect(() => {
    if (page > 0) audioRef.current?.playWhoosh();
  }, [page]);

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
  const kind = report.kind ?? null;
  const sharePeriod = `${fmtPeriodS(report.period.start)} — ${fmtPeriodS(report.period.end)}`;

  function fmtPeriodS(s: string) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : `${d.getMonth() + 1}.${d.getDate()}`;
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 55%, #1f1a33 100%)" }}>
      {/* 漂移光斑：3 层纵深（远层慢而淡），叠加陀螺仪视差。
          用 radial-gradient 软圆代替 filter: blur，动画只动 transform，移动端 GPU 友好 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0" style={{ transform: `translate(${tilt.x * 0.4}px, ${tilt.y * 0.4}px)` }}>
          <div className="absolute left-[8%] top-[12%] h-56 w-56 rounded-full opacity-15" style={{ background: "radial-gradient(circle, rgba(74,111,165,1) 0%, rgba(74,111,165,0) 70%)", willChange: "transform", animation: "sr-drift2 34s ease-in-out infinite alternate" }} />
          <div className="absolute bottom-[8%] right-[4%] h-64 w-64 rounded-full opacity-[0.13]" style={{ background: "radial-gradient(circle, rgba(122,92,255,1) 0%, rgba(122,92,255,0) 70%)", willChange: "transform", animation: "sr-drift1 38s ease-in-out infinite alternate-reverse" }} />
        </div>
        <div className="absolute inset-0" style={{ transform: `translate(${tilt.x * 0.7}px, ${tilt.y * 0.7}px)` }}>
          <div className="absolute -right-28 top-1/3 h-96 w-96 rounded-full opacity-25" style={{ background: "radial-gradient(circle, rgba(74,111,165,1) 0%, rgba(74,111,165,0) 70%)", willChange: "transform", animation: "sr-drift2 22s ease-in-out infinite alternate" }} />
          <div className="absolute bottom-[-80px] left-1/4 h-72 w-72 rounded-full opacity-20" style={{ background: "radial-gradient(circle, rgba(255,209,148,1) 0%, rgba(255,209,148,0) 70%)", willChange: "transform", animation: "sr-drift1 26s ease-in-out infinite alternate-reverse" }} />
        </div>
        <div className="absolute inset-0" style={{ transform: `translate(${tilt.x}px, ${tilt.y}px)` }}>
          <div className="absolute -left-24 -top-24 h-80 w-80 rounded-full opacity-30" style={{ background: "radial-gradient(circle, rgba(255,126,63,1) 0%, rgba(255,126,63,0) 70%)", willChange: "transform", animation: "sr-drift1 18s ease-in-out infinite alternate" }} />
          <div className="absolute right-[8%] bottom-[28%] h-60 w-60 rounded-full opacity-20" style={{ background: "radial-gradient(circle, rgba(255,154,90,1) 0%, rgba(255,154,90,0) 70%)", willChange: "transform", animation: "sr-drift2 16s ease-in-out infinite alternate-reverse" }} />
        </div>
      </div>
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
            initial={{ y: direction > 0 ? "100%" : "-100%", opacity: 0, scale: 1.04 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: direction > 0 ? "-60%" : "60%", opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
            // 拖拽跟随：页面实时跟手（0.6 阻尼橡皮筋），松手超阈值或快速滑动才翻页，否则回弹
            drag={total > 1 ? "y" : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.6}
            dragDirectionLock
            onDragEnd={(_, info) => {
              if (info.offset.y < -60 || info.velocity.y < -400) goTo(page + 1);
              else if (info.offset.y > 60 || info.velocity.y > 400) goTo(page - 1);
            }}
          >
            {slide.node(true)}
          </motion.div>
        </AnimatePresence>

        {/* 页码指示器（开场页不显示） */}
        {total > 1 && slide.key !== "intro" && (
          <div className="absolute bottom-5 right-2 z-10 flex flex-col items-center gap-0.5 opacity-80">
            {slides.map((s, i) => (
              <button
                key={s.key}
                aria-label={`第 ${i + 1} 页`}
                onClick={() => goTo(i)}
                className="cursor-pointer rounded-full border-none transition-all"
                style={{
                  width: 2,
                  height: i === page ? 10 : 2,
                  background: i === page ? "#ff9a5a" : "rgba(255,255,255,0.18)",
                }}
              />
            ))}
          </div>
        )}

        {/* 封面上滑提示 */}
        {slide.key === "cover" && total > 1 && (
          <div className="absolute bottom-6 left-0 right-0 z-10 flex flex-col items-center gap-1 text-white/60 pointer-events-none">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ animation: "sr-bounce 1.6s ease-in-out infinite" }}>
              <path d="M6 14l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-xs tracking-widest">上滑开启</span>
          </div>
        )}

        {/* 封面页音乐开关（用户手势触发，规避自动播放限制） */}
        {slide.key === "cover" && (
          <button
            onClick={onMusicClick}
            className="absolute bottom-6 right-10 z-20 flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-white/70 backdrop-blur-sm transition hover:bg-white/10"
            style={{ fontSize: "clamp(12px, 3.2vw, 14px)" }}
          >
            <span>{audioStarted && !muted ? "🔊" : "🔇"}</span>
            <span>{audioStarted ? (muted ? "开启音乐" : "音乐中") : "开启音乐"}</span>
          </button>
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
          {(() => {
            const isTeamCard = !(p.visit_count > 0 && kind !== "team" || !report.team);
            const items = !isTeamCard
              ? [
                  { label: "拜访次数", value: p.visit_count, unit: "次" },
                  { label: "客户", value: p.customer_count, unit: "家" },
                  { label: "里程", value: Math.round(p.distance_km), unit: "km" },
                ]
              : [
                  { label: "团队人数", value: report.team!.member_count, unit: "人" },
                  { label: "团队拜访", value: report.team!.total_visits, unit: "次" },
                  { label: "团队里程", value: Math.round(report.team!.total_distance_km), unit: "km" },
                ];
            return (
              <div
                style={
                  isTeamCard
                    ? { marginTop: p.title ? 24 : 48, width: "100%", display: "flex", flexDirection: "column", gap: 14 }
                    : { marginTop: p.title ? 24 : 48, width: "100%", display: "flex", justifyContent: "space-around" }
                }
              >
                {items.map((it) =>
                  isTeamCard ? (
                    <div key={it.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 12px" }}>
                      <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 14 }}>{it.label}</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: "#ff9a5a" }}>
                        {it.value.toLocaleString()}
                        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginLeft: 4 }}>{it.unit}</span>
                      </div>
                    </div>
                  ) : (
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
                  )
                )}
              </div>
            );
          })()}
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
