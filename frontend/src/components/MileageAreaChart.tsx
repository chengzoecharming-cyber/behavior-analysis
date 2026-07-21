import { VChart } from "@visactor/react-vchart";
import type { ICommonChartSpec } from "@visactor/vchart";
import { useMemo, useCallback } from "react";
import type { WeeklyTrendItem } from "../api";

interface MileageAreaChartProps {
  data: WeeklyTrendItem[];
  height?: number | string;
}

export default function MileageAreaChart({
  data,
  height = "100%",
}: MileageAreaChartProps) {
  const spec = useMemo<ICommonChartSpec>(() => {
    const values = data.map((d) => ({
      week: d.week,
      reportedKm: d.reportedKm,
      estimatedKm: d.estimatedKm,
    }));

    return {
      type: "common",
      data: [{ id: "mileage", values }],
      series: [
        {
          type: "area",
          id: "reported_km",
          dataId: "mileage",
          xField: "week",
          yField: "reportedKm",
          name: "填报里程",
          area: {
            style: {
              fill: "rgba(82, 196, 26, 0.15)",
            },
          },
          line: {
            style: {
              stroke: "#52c41a",
              lineWidth: 2,
              curveType: "monotone",
            },
          },
          point: {
            style: {
              size: 4,
              fill: "#52c41a",
            },
            state: {
              dimension_hover: { size: 6 },
            },
          },
          tooltip: {
            dimension: {
              title: { value: (datum: any) => datum?.week ?? "" },
              content: [
                { key: "填报里程", value: (datum: any) => `${datum?.reportedKm ?? 0} km` },
              ],
            },
          },
        },
        {
          type: "area",
          id: "estimated_km",
          dataId: "mileage",
          xField: "week",
          yField: "estimatedKm",
          name: "估算里程",
          area: {
            style: {
              fill: "rgba(250, 173, 20, 0.15)",
            },
          },
          line: {
            style: {
              stroke: "#faad14",
              lineWidth: 2,
              curveType: "monotone",
            },
          },
          point: {
            style: {
              size: 4,
              fill: "#faad14",
            },
            state: {
              dimension_hover: { size: 6 },
            },
          },
          tooltip: {
            dimension: {
              title: { value: (datum: any) => datum?.week ?? "" },
              content: [
                { key: "估算里程", value: (datum: any) => `${datum?.estimatedKm ?? 0} km` },
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
          title: { text: "里程 (km)" },
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
