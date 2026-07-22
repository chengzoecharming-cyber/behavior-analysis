import { VChart } from "@visactor/react-vchart";
import type { ICommonChartSpec } from "@visactor/vchart";
import { useMemo } from "react";
import type { WeeklyTrendItem } from "../api";

interface CompanyTrendChartProps {
  data: WeeklyTrendItem[];
  height?: number | string;
}

const BASELINE_VALUE = 10;

export default function CompanyTrendChart({
  data,
  height = "100%",
}: CompanyTrendChartProps) {
  const spec = useMemo<ICommonChartSpec>(() => {
    const values = data.map((d) => ({
      week: d.week,
      avgVisitsPerEmployee: d.avgVisitsPerEmployee,
      reportedKm: d.reportedKm,
      estimatedKm: d.estimatedKm,
      baseline: BASELINE_VALUE,
    }));

    return {
      type: "common",
      data: [{ id: "trend", values }],
      series: [
        {
          type: "bar",
          id: "avg_visits",
          dataId: "trend",
          xField: "week",
          yField: "avgVisitsPerEmployee",
          name: "周人均拜访次数",
          bar: {
            style: {
              fill: "#1890ff",
            },
          },
          tooltip: {
            dimension: {
              title: { value: (datum: any) => datum?.week ?? "" },
              content: [
                { key: "周人均拜访次数", value: (datum: any) => String(datum?.avgVisitsPerEmployee ?? "") },
              ],
            },
          },
        },
        {
          type: "line",
          id: "baseline",
          dataId: "trend",
          xField: "week",
          yField: "baseline",
          name: "目标周人均拜访次数 (10次/周)",
          line: {
            style: {
              stroke: "#f5222d",
              lineWidth: 2,
              lineDash: [4, 4],
            },
          },
          point: {
            visible: false,
          },
          tooltip: {
            dimension: {
              title: { value: (datum: any) => datum?.week ?? "" },
              content: [
                {
                  key: "目标人均拜访量",
                  value: () => `${BASELINE_VALUE}次/人/周`,
                },
              ],
            },
          },
        },
        {
          type: "line",
          id: "reported_km",
          dataId: "trend",
          xField: "week",
          yField: "reportedKm",
          name: "填报里程",
          line: {
            style: {
              stroke: "#52c41a",
              lineWidth: 2,
              curveType: "monotone",
            },
          },
          point: {
            style: { size: 0, fill: "#52c41a" },
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
          type: "line",
          id: "estimated_km",
          dataId: "trend",
          xField: "week",
          yField: "estimatedKm",
          name: "估算里程",
          line: {
            style: {
              stroke: "#faad14",
              lineWidth: 2,
              curveType: "monotone",
            },
          },
          point: {
            style: { size: 0, fill: "#faad14" },
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
          seriesId: ["avg_visits", "baseline"],
          title: { text: "人均拜访次数" },
        },
        {
          orient: "right",
          seriesId: ["reported_km", "estimated_km"],
          title: { text: "里程 (km)" },
        },
      ],
      legends: {
        visible: true,
        orient: "top",
      },
      tooltip: {
        visible: true,
      },
    };
  }, [data]);

  return (
    <div style={{ height, width: "100%" }}>
      <VChart spec={spec} style={{ width: "100%", height: "100%" }} options={{ autoFit: true }} />
    </div>
  );
}
