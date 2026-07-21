import { VChart } from "@visactor/react-vchart";
import type { IWordCloudChartSpec } from "@visactor/vchart";
import { useMemo } from "react";
import type { WordCloudEmployee } from "../api";

interface EmployeeWordCloudProps {
  data: WordCloudEmployee[];
  height?: number | string;
  onClick?: (employee: WordCloudEmployee) => void;
}

export default function EmployeeWordCloud({
  data,
  height = "100%",
  onClick,
}: EmployeeWordCloudProps) {
  const values = useMemo(
    () =>
      data.map((d) => ({
        name: d.userName,
        value: d.visitCount,
        userId: d.userId,
        department: d.department,
        anomalyCount: d.anomalyCount,
      })),
    [data]
  );

  const spec = useMemo<IWordCloudChartSpec>(() => {
    return {
      type: "wordCloud",
      data: [{ id: "words", values }],
      nameField: "name",
      valueField: "value",
      seriesField: "name",
      fontSizeRange: [14, 48],
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      tooltip: {
        visible: true,
        mark: {
          title: { value: (datum: any) => datum?.name ?? "" },
          content: [
            { key: "拜访次数", value: (datum: any) => String(datum?.value ?? 0) },
          ],
        },
      },
    };
  }, [values]);

  const handleClick = (e: any) => {
    const datum = e?.datum?.datum;
    if (!datum) return;
    const employee = data.find((d) => d.userId === datum.userId);
    if (employee) {
      onClick?.(employee);
    }
  };

  return (
    <div style={{ height, width: "100%" }}>
      <VChart
        spec={spec}
        style={{ width: "100%", height: "100%" }}
        options={{ autoFit: true }}
        onClick={handleClick}
      />
    </div>
  );
}
