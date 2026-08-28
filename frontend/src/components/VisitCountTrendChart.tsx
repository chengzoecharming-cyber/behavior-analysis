import "./vchartSetup";
import { VChart } from "@visactor/react-vchart";
import type { ICommonChartSpec } from "@visactor/vchart";
import { useMemo, useCallback } from "react";
import type { WeeklyTrendItem } from "../api";

interface VisitCountTrendChartProps {
  data: WeeklyTrendItem[];
  height?: number | string;
}

export default function VisitCountTrendChart({
  data,
  height = "100%",
}: VisitCountTrendChartProps) {
  const spec = useMemo<ICommonChartSpec>(() => {
    const values = data.map((d) => ({
      week: d.week,
      avgVisitsPerEmployee: d.avgVisitsPerEmployee,
    }));

    return {
      type: "common",
      data: [{ id: "visits", values }],
      series: [
        {
          type: "line",
          id: "avg_visits",
          dataId: "visits",
          xField: "week",
          yField: "avgVisitsPerEmployee",
          name: "人均拜访次数",
          line: {
            style: {
              stroke: "#1890ff",
              lineWidth: 3,
              curveType: "monotone",
            },
          },
          point: {
            style: {
              size: 5,
              fill: "#1890ff",
            },
            state: {
              dimension_hover: { size: 7 },
            },
          },
          tooltip: {
            dimension: {
              title: { value: (datum: any) => datum?.week ?? "" },
              content: [
                { key: "人均拜访次数", value: (datum: any) => String(datum?.avgVisitsPerEmployee ?? "") },
              ],
            },
          },
        },
      ],
      axes: [
        {
          orient: "bottom",
        },
        {
          orient: "left",
          seriesId: ["avg_visits"],
          title: { text: "人均拜访次数" },
        },
      ],
      legends: {
        visible: true,
        orient: "bottom",
      },
      tooltip: {
        visible: true,
      },
    };
  }, [data]);

  const handleDimensionClick = useCallback(
    (e: any) => {
      const datum = e?.datum;
      const week = Array.isArray(datum) ? datum[0]?.week : datum?.week;
      const item = data.find((d) => d.week === week);
      if (item) {
        const params = new URLSearchParams();
        params.set("scope", "company");
        params.set("node", "__ALL__");
        params.set("start", item.weekStart);
        params.set("end", item.weekEnd);
        window.open(`/console?${params.toString()}`, "_blank");
      }
    },
    [data]
  );

  return (
    <div style={{ height, width: "100%" }}>
      <VChart
        spec={spec}
        style={{ width: "100%", height: "100%" }}
        options={{ autoFit: true }}
        onDimensionClick={handleDimensionClick}
      />
    </div>
  );
}
