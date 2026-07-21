import { VChart } from "@visactor/react-vchart";
import type { IRadarChartSpec } from "@visactor/vchart";
import { useMemo } from "react";
import type { DepartmentRadarItem } from "../api";

interface DepartmentRadarChartProps {
  data: DepartmentRadarItem[];
  height?: number | string;
}

interface RadarPoint {
  dimension: string;
  value: number;
  rawValue: number;
  department: string;
}

export default function DepartmentRadarChart({
  data,
  height = "100%",
}: DepartmentRadarChartProps) {
  const points = useMemo<RadarPoint[]>(() => {
    const maxAvgVisits = Math.max(...data.map((d) => d.avgVisitsPerEmployee), 1);
    const maxAvgCustomers = Math.max(...data.map((d) => d.avgCustomerCoverage), 1);
    const maxAvgKm = Math.max(...data.map((d) => d.avgEstimatedKm), 1);

    const result: RadarPoint[] = [];
    for (const d of data) {
      result.push({
        dimension: "人均拜访",
        value: parseFloat((d.avgVisitsPerEmployee / maxAvgVisits).toFixed(1)),
        rawValue: d.avgVisitsPerEmployee,
        department: d.department,
      });
      result.push({
        dimension: "人均客户",
        value: parseFloat((d.avgCustomerCoverage / maxAvgCustomers).toFixed(1)),
        rawValue: d.avgCustomerCoverage,
        department: d.department,
      });
      result.push({
        dimension: "人均里程",
        value: parseFloat((d.avgEstimatedKm / maxAvgKm).toFixed(1)),
        rawValue: d.avgEstimatedKm,
        department: d.department,
      });
    }
    return result;
  }, [data]);

  const spec = useMemo<IRadarChartSpec>(() => {
    return {
      type: "radar",
      data: [{ id: "radar", values: points }],
      categoryField: "dimension",
      valueField: "value",
      seriesField: "department",
      point: {
        visible: true,
      },
      area: {
        visible: true,
      },
      axes: [
        {
          orient: "radius",
          min: 0,
          max: 1,
          label: { visible: false },
        },
        {
          orient: "angle",
          label: {
            style: {
              fontSize: 12,
            },
          },
        },
      ],
      legends: {
        visible: true,
        orient: "bottom",
      },
      tooltip: {
        visible: true,
        mark: {
          title: { value: (datum: any) => datum?.department ?? "" },
          content: [
            {
              key: (datum: any) => datum?.dimension ?? "",
              value: (datum: any) => {
                const raw = datum?.datum?.rawValue ?? datum?.rawValue ?? 0;
                return Number(raw).toFixed(1);
              },
            },
          ],
        },
        dimension: {
          title: { value: (datum: any) => datum?.[0]?.dimension ?? "" },
          content: [
            {
              key: (datum: any) => datum?.department ?? "",
              value: (datum: any) => {
                const raw = datum?.datum?.rawValue ?? datum?.rawValue ?? 0;
                return Number(raw).toFixed(1);
              },
            },
          ],
        },
      },
    };
  }, [points]);

  return (
    <div style={{ height, width: "100%" }}>
      <VChart spec={spec} style={{ width: "100%", height: "100%" }} options={{ autoFit: true }} />
    </div>
  );
}
