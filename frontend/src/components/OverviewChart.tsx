import { useMemo, useState, useCallback } from "react";
import { VChart } from "@visactor/react-vchart";
import type { ICommonChartSpec } from "@visactor/vchart";
import dayjs from "dayjs";

interface DailyPoint {
  date: string;
  visit_count: number;
  reported_distance_km: number;
  estimated_distance_km: number;
  anomaly_count: number;
  has_mileage_reading_invalid?: boolean;
}

interface AnomalyItem {
  id: number;
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
  anomaly_date: string;
  metadata?: Record<string, any>;
}

interface OverviewChartProps {
  data: DailyPoint[];
  anomalies?: AnomalyItem[];
  height?: number | string;
  onDateClick?: (date: string) => void;
}

const MIN_ZOOM_SPAN = 0.1;

const SERIES_META = [
  {
    key: "visit_count" as const,
    dataId: "visit_data" as const,
    name: "拜访数",
    color: "#1890ff",
    type: "bar" as const,
  },
  {
    key: "reported_distance_km" as const,
    dataId: "reported_data" as const,
    name: "填报里程",
    color: "#52c41a",
    type: "line" as const,
  },
  {
    key: "estimated_distance_km" as const,
    dataId: "estimated_data" as const,
    name: "估算里程",
    color: "#faad14",
    type: "line" as const,
  },
];

export default function OverviewChart({
  data,
  anomalies = [],
  height = 420,
  onDateClick,
}: OverviewChartProps) {
  const [zoomRange, setZoomRange] = useState({ start: 0, end: 1 });
  const [visibleSeries, setVisibleSeries] = useState<string[]>(
    SERIES_META.map((s) => s.name)
  );

  const toggleSeries = useCallback((name: string) => {
    setVisibleSeries((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }, []);

  const spec = useMemo<ICommonChartSpec>(() => {
    const baseValues = data.map((d) => ({
      date: d.date,
      visit_count: d.visit_count,
      reported_distance_km: d.reported_distance_km,
      estimated_distance_km: d.estimated_distance_km,
      has_mileage_reading_invalid: d.has_mileage_reading_invalid,
    }));

    const datasets: Array<{ id: string; values: any[] }> = SERIES_META.map(
      (cfg) => {
        const visible = visibleSeries.includes(cfg.name);
        return {
          id: cfg.dataId,
          values: visible
            ? baseValues.map((d) => ({ date: d.date, value: d[cfg.key] }))
            : [],
        };
      }
    );

    // 异常标记现在通过 x 轴 label 富文本展示，不再使用散点系列

    return {
      type: "common",
      data: datasets,
      series: [
        {
          type: "bar",
          id: "visit_count",
          dataId: "visit_data",
          xField: "date",
          yField: "value",
          name: "拜访数",
          bar: {
            style: {
              fill: "#1890ff",
            },
          },
          tooltip: {
            dimension: {
              title: {
                value: (datum: any) => datum?.date ?? "",
              },
              content: [
                {
                  key: "拜访数",
                  value: (datum: any) => String(datum?.value ?? ""),
                },
              ],
            },
          },
        },
        {
          type: "line",
          id: "reported_distance",
          dataId: "reported_data",
          xField: "date",
          yField: "value",
          name: "填报里程",
          line: {
            style: {
              curveType: "monotone",
              lineWidth: 2,
              stroke: "#52c41a",
            },
          },
          point: {
            style: {
              size: 0,
              fill: "#52c41a",
            },
            state: {
              dimension_hover: {
                size: 6,
              },
            },
          },
          tooltip: {
            dimension: {
              title: {
                value: (datum: any) => datum?.date ?? "",
              },
              content: [
                {
                  key: "填报里程",
                  value: (datum: any) => String(datum?.value ?? ""),
                },
              ],
            },
          },
        },
        {
          type: "line",
          id: "estimated_distance",
          dataId: "estimated_data",
          xField: "date",
          yField: "value",
          name: "估算里程",
          line: {
            style: {
              curveType: "monotone",
              lineWidth: 2,
              stroke: "#faad14",
            },
          },
          point: {
            style: {
              size: 0,
              fill: "#faad14",
            },
            state: {
              dimension_hover: {
                size: 6,
              },
            },
          },
          tooltip: {
            dimension: {
              title: {
                value: (datum: any) => datum?.date ?? "",
              },
              content: [
                {
                  key: "估算里程",
                  value: (datum: any) => String(datum?.value ?? ""),
                },
              ],
            },
          },
        },

      ],
      axes: [
        {
          orient: "bottom",
          label: {
            formatMethod: (value: string | string[]) => {
              const rawDate = Array.isArray(value) ? value[0] : value;
              return rawDate ? dayjs.tz(rawDate).format("MM-DD") : "";
            },
          },
        },
        {
          orient: "left",
          seriesId: ["visit_count"],
        },
        {
          orient: "right",
          seriesId: ["reported_distance", "estimated_distance"],
        },
      ],
      dataZoom: [
        {
          orient: "bottom",
          filterMode: "filter",
          start: zoomRange.start,
          end: zoomRange.end,
          roam: true,
          minSpan: MIN_ZOOM_SPAN,
          height: 12,
          style: {
            handleSize: 20,
          },
        },
      ],
      legends: {
        visible: false,
      },
      tooltip: {
        visible: true,
        mark: {
          visible: false,
        },
      },
      crosshair: {
        xField: {
          visible: true,
          line: {
            style: {
              lineDash: [0],
            },
          },
        },
      },
    };
  }, [data, zoomRange, visibleSeries, anomalies]);

  const handleDataZoomChange = useCallback((e: any) => {
    const start = e?.value?.start;
    const end = e?.value?.end;
    if (typeof start === "number" && typeof end === "number") {
      setZoomRange({ start, end });
    }
  }, []);

  const handleDimensionClick = useCallback(
    (e: any) => {
      const datum = e?.datum;
      const date = Array.isArray(datum) ? datum[0]?.date : datum?.date;
      if (typeof date === "string" && date) {
        onDateClick?.(date);
      }
    },
    [onDateClick]
  );

  return (
    <div
      style={{
        height: height ?? 420,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        <VChart
          spec={spec}
          style={{ width: "100%", height: "100%" }}
          onDataZoomChange={handleDataZoomChange}
          onDimensionClick={handleDimensionClick}
          options={{ autoFit: true }}
        />
      </div>

      {/* 自定义图例：点击切换 series 显示/隐藏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 20,
          marginTop: 12,
        }}
      >
        {SERIES_META.map((cfg) => {
          const active = visibleSeries.includes(cfg.name);
          return (
            <div
              key={cfg.name}
              onClick={() => toggleSeries(cfg.name)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                userSelect: "none",
                color: active ? "#1f2329" : "#bfbfbf",
                transition: "color 0.2s",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: cfg.type === "bar" ? 2 : "50%",
                  backgroundColor: active ? cfg.color : "#d9d9d9",
                  transition: "background-color 0.2s",
                }}
              />
              <span style={{ fontSize: 13 }}>{cfg.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
