import { useEffect, useMemo, useRef } from "react";
import dayjs from "dayjs";
import { AvailableDate } from "../api";

interface DateAxisProps {
  availableDateInfos: AvailableDate[];
  /** 钉钉已同步覆盖的日期（全局），用于把轴延伸到「已同步但无数据」的日期 */
  syncedDates?: string[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  emptyText?: string;
}

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

export default function DateAxis({
  availableDateInfos,
  syncedDates = [],
  selectedDate,
  onSelectDate,
  emptyText = "暂无数据",
}: DateAxisProps) {
  // 日历视图：生成连续日期轴（从最早有数据日期，到最晚有数据/已同步日期），无数据置灰
  const calendarDates = useMemo(() => {
    if (availableDateInfos.length === 0) return [];
    const sorted = [...availableDateInfos].sort((a, b) => a.date.localeCompare(b.date));
    const min = dayjs.tz(sorted[0].date);
    // 上界取「最晚已同步日期」与「最晚有数据日期」的较大者：
    // 已同步但无数据的日期（如全员未提交审批的周末）也要展示为置灰，避免被误认为未同步
    let max = dayjs.tz(sorted[sorted.length - 1].date);
    for (const d of syncedDates) {
      const dt = dayjs.tz(d);
      if (dt.isAfter(max)) max = dt;
    }
    const infoMap = new Map(availableDateInfos.map((i) => [i.date, i]));
    const dates: AvailableDate[] = [];
    for (let d = min; d.isBefore(max) || d.isSame(max); d = d.add(1, "day")) {
      const dateStr = d.format("YYYY-MM-DD");
      const info = infoMap.get(dateStr);
      dates.push(info ?? { date: dateStr, has_anomaly: false });
    }
    return dates;
  }, [availableDateInfos, syncedDates]);

  const dateAxisRef = useRef<HTMLDivElement>(null);
  const syncedSet = useMemo(() => new Set(syncedDates), [syncedDates]);

  const scrollDateAxis = (direction: "left" | "right") => {
    if (!dateAxisRef.current) return;
    const scrollAmount = 200;
    dateAxisRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const handleToday = () => {
    if (availableDateInfos.length === 0) return;
    const today = dayjs.tz().format("YYYY-MM-DD");
    // 优先选今天；今天无数据则选最近的有数据日期
    const target =
      availableDateInfos.find((i) => i.date === today)?.date ||
      availableDateInfos.reduce((prev, curr) =>
        Math.abs(dayjs.tz(curr.date).diff(today, "day")) <
        Math.abs(dayjs.tz(prev.date).diff(today, "day"))
          ? curr
          : prev
      ).date;
    onSelectDate(target);
  };

  const selectDate = (dateStr: string) => {
    if (!availableDateInfos.some((i) => i.date === dateStr)) return;
    onSelectDate(dateStr);
  };

  // 选中日期变化时，自动滚动日期轴让该日期居中可见
  useEffect(() => {
    if (!selectedDate || !dateAxisRef.current) return;
    const timer = setTimeout(() => {
      const activeBtn = dateAxisRef.current?.querySelector(
        `[data-date="${selectedDate}"]`
      ) as HTMLElement | null;
      if (activeBtn) {
        activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [selectedDate]);

  if (calendarDates.length === 0) {
    return <div style={{ color: "#999" }}>{emptyText}</div>;
  }

  // 结构：左滚动箭头、今天、右滚动箭头在日期序列前面，随后是日期块（跳月按钮已移除）
  const navBtnStyle: React.CSSProperties = {
    backgroundColor: "#fff",
    border: "1px solid #F0F1F3",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
    flexShrink: 0,
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="date-axis-nav" onClick={() => scrollDateAxis("left")} style={navBtnStyle}>
        &lt;
      </button>
      <button className="date-axis-nav" onClick={handleToday} style={{ ...navBtnStyle, padding: "4px 12px" }}>
        今天
      </button>
      <button className="date-axis-nav" onClick={() => scrollDateAxis("right")} style={navBtnStyle}>
        &gt;
      </button>
      <div
        ref={dateAxisRef}
        style={{
          display: "flex",
          gap: 6,
          overflowX: "auto",
          flex: 1,
          padding: "4px 0",
        }}
      >
        {calendarDates.map((info) => {
          const d = dayjs.tz(info.date);
          const hasData = availableDateInfos.some((i) => i.date === info.date);
          const isActive = selectedDate === info.date;
          // 无数据日区分两种置灰含义：已同步（源端确实没数据）vs 未同步
          const noDataTitle = syncedSet.has(info.date)
            ? "已同步，无拜访数据"
            : "未同步";
          return (
            <button
              key={info.date}
              className={`date-axis-day${isActive ? " active" : ""}`}
              data-date={info.date}
              onClick={() => selectDate(info.date)}
              disabled={!hasData}
              title={hasData ? undefined : noDataTitle}
              style={{
                flexShrink: 0,
                width: 56,
                padding: "6px 0",
                borderRadius: 8,
                border: "none",
                backgroundColor: isActive ? "#4B24E3" : hasData ? "#fff" : "#F7F8FA",
                color: isActive ? "#fff" : hasData ? "#0f1419" : "#bbb",
                cursor: hasData ? "pointer" : "not-allowed",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                fontSize: 12,
                position: "relative",
              }}
            >
              <span style={{ fontWeight: 400, color: isActive ? "rgba(255,255,255,0.85)" : "var(--text-tertiary)" }}>{weekdayLabels[d.day()]}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{d.format("MM-DD")}</span>
              {info.has_anomaly && (
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "#F54C5C",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
