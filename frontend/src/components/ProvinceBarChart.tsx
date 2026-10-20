import "./vchartSetup";
import { VChart } from "@visactor/react-vchart";
import type { IBarChartSpec } from "@visactor/vchart";

interface ProvinceBarChartProps {
  /** 后端已按拜访次数降序排列，尾部为「其他」桶，前端保持传入顺序 */
  data: { name: string; count: number }[];
  height?: number | string;
}

/** 拜访省份分布：柱状图，按拜访次数降序横排，柱上标数值 */
export default function ProvinceBarChart({
  data,
  height = "100%",
}: ProvinceBarChartProps) {
  const spec: IBarChartSpec = {
    type: "bar",
    data: [
      {
        id: "province",
        values: data,
      },
    ],
    xField: "name",
    yField: "count",
    barMaxWidth: 36,
    bar: {
      style: {
        fill: "#4B24E3",
        cornerRadius: [4, 4, 0, 0],
      },
    },
    label: {
      visible: true,
      position: "outside",
      style: {
        fontSize: 12,
        fill: "#60646C",
      },
    },
    axes: [
      {
        orient: "bottom",
        label: {
          style: {
            fontSize: 12,
          },
        },
      },
      {
        orient: "left",
        label: {
          visible: false,
        },
        grid: {
          visible: false,
        },
      },
    ],
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
