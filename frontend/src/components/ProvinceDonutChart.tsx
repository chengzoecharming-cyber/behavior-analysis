import { VChart } from "@visactor/react-vchart";
import type { IPieChartSpec } from "@visactor/vchart";

interface ProvinceDonutChartProps {
  data: { name: string; count: number }[];
  height?: number | string;
}

export default function ProvinceDonutChart({
  data,
  height = "100%",
}: ProvinceDonutChartProps) {
  const spec: IPieChartSpec = {
    type: "pie",
    data: [
      {
        id: "province",
        values: data,
      },
    ],
    categoryField: "name",
    valueField: "count",
    innerRadius: 0.45,
    outerRadius: 0.6,
    label: {
      visible: true,
      style: {
        fontSize: 12,
      },
    },
    legends: {
      visible: true,
      orient: "right",
      item: {
        label: {
          style: {
            fontSize: 12,
          },
        },
      },
    },
    tooltip: {
      visible: true,
      mark: {
        title: {
          value: (datum: any) => datum?.name ?? "",
        },
        content: [
          {
            key: "拜访次数",
            value: (datum: any) => String(datum?.count ?? 0),
          },
        ],
      },
    },
  };

  return (
    <div style={{ height, width: "100%" }}>
      <VChart spec={spec} style={{ width: "100%", height: "100%" }} options={{ autoFit: true }} />
    </div>
  );
}
