import { useEffect, useMemo, useRef } from "react";
import dayjs from "dayjs";
import { AvailableDate } from "../api";

interface DateAxisProps {
  availableDateInfos: AvailableDate[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  emptyText?: string;
}

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

export default function DateAxis({
  availableDateInfos,
  selectedDate,
  onSelectDate,
  emptyText = "暂无数据",
}: DateAxisProps) {
  // 日历视图：生成连续日期轴（从最早到最晚有数据日期），无数据置灰
  const calendarDates = useMemo(() => {
    if (availableDateInfos.length === 0) return [];
    const sorted = [...availableDateInfos].sort((a, b) => a.date.localeCompare(b.date));
    const min = dayjs.tz(sorted[0].date);
    const max = dayjs.tz(sorted[sorted.length - 1].date);
    const infoMap = new Map(availableDateInfos.map((i) => [i.date, i]));
    const dates: AvailableDate[] = [];
    for (let d = min; d.isBefore(max) || d.isSame(max); d = d.add(1, "day")) {
      const dateStr = d.format("YYYY-MM-DD");
      const info = infoMap.get(dateStr);
      dates.push(info ?? { date: dateStr, has_anomaly: false });
    }
    return dates;
  }, [availableDateInfos]);

  const dateAxisRef = useRef<HTMLDivElement>(null);

  const scrollDateAxis = (direction: "left" | "right") => {
    if (!dateAxisRef.current) return;
    const scrollAmount = 200;
    dateAxisRef.current.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const jumpMonth = (direction: "prev" | "next") => {
    if (!selectedDate || availableDateInfos.length === 0) return;
    const current = dayjs.tz(selectedDate);
    const targetMonth =
      direction === "prev" ? current.subtract(1, "month") : current.add(1, "month");
    const datesInMonth = availableDateInfos
      .map((i) => i.date)
      .filter((d) => {
        const dt = dayjs.tz(d);
        return dt.year() === targetMonth.year() && dt.month() === targetMonth.month();
      })
      .sort();
    if (datesInMonth.length === 0) return;
    const target =
      direction === "prev"
        ? datesInMonth[datesInMonth.length - 1]
        : datesInMonth[0];
    onSelectDate(target);
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

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={handleToday}
        style={{
          backgroundColor: "#fff",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
          padding: "4px 12px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        今天
      </button>
      <button
        onClick={() => jumpMonth("prev")}
        title="上一月"
        style={{
          backgroundColor: "#fff",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        &lt;&lt;
      </button>
      <button
        onClick={() => scrollDateAxis("left")}
        style={{
          backgroundColor: "#fff",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        &lt;
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
          return (
            <button
              key={info.date}
              data-date={info.date}
              onClick={() => selectDate(info.date)}
              disabled={!hasData}
              style={{
                flexShrink: 0,
                width: 56,
                padding: "6px 0",
                borderRadius: 8,
                border: "none",
                backgroundColor: isActive ? "#1890ff" : hasData ? "#fff" : "#f5f5f5",
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
              <span>{weekdayLabels[d.day()]}</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{d.format("MM-DD")}</span>
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
      <button
        onClick={() => scrollDateAxis("right")}
        style={{
          backgroundColor: "#fff",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        &gt;
      </button>
      <button
        onClick={() => jumpMonth("next")}
        title="下一月"
        style={{
          backgroundColor: "#fff",
          border: "1px solid #d9d9d9",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        &gt;&gt;
      </button>
    </div>
  );
}
