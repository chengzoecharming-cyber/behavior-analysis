import { DailyOverview, UserOverviewResult } from "./userOverviewService";

export interface ReportInput {
  userId: string;
  userName: string;
  start: string;
  end: string;
  overview: UserOverviewResult;
  estimatedFuelCost: number;
  visitFrequency: number;
  mapImage: string; // base64 dataURL 或空字符串
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderConsoleReportHtml(input: ReportInput): string {
  const {
    userName,
    start,
    end,
    overview,
    estimatedFuelCost,
    visitFrequency,
    mapImage,
  } = input;

  const totals = overview.totals;
  const daily = overview.daily.map((d) => ({
    ...d,
    estimated_distance_km: Math.round(d.estimated_distance_km),
  }));

  const dataJson = JSON.stringify(daily)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  const mapSection = mapImage
    ? `<div class="section">
         <div class="section-title">拜访热度地图</div>
         <img class="map-image" src="${mapImage}" alt="拜访热度地图" />
       </div>`
    : `<div class="section">
         <div class="section-title">拜访热度地图</div>
         <div class="placeholder">地图快照生成失败，请在系统中查看。</div>
       </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(userName)} ${start} ~ ${end} 外勤行为报告</title>
  <script src="https://unpkg.com/@visactor/vchart/build/index.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: #f5f7fa;
      color: #1f2329;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
      background-color: #fff;
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 22px;
      font-weight: 700;
    }
    .subtitle {
      color: #72808a;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    @media (max-width: 640px) {
      .cards { grid-template-columns: 1fr; }
    }
    .card {
      background-color: #fff;
      border: 1px solid #ebedf0;
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .card-label {
      font-size: 13px;
      color: #72808a;
      font-weight: 500;
    }
    .card-value {
      font-size: 26px;
      font-weight: 700;
      color: #0f1419;
    }
    .card-unit {
      font-size: 13px;
      color: #999;
      margin-left: 4px;
      font-weight: 400;
    }
    .section {
      margin-top: 24px;
      background-color: #fff;
      border: 1px solid #ebedf0;
      border-radius: 12px;
      padding: 20px;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    #chart {
      width: 100%;
      height: 400px;
    }
    .map-image {
      width: 100%;
      border-radius: 8px;
      display: block;
    }
    .placeholder {
      height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #999;
      background-color: #f7f8fa;
      border-radius: 8px;
      font-size: 14px;
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      color: #bbb;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(userName)} 外勤行为报告</h1>
    <div class="subtitle">${start} ~ ${end} · 用于油费消费合理性核对</div>

    <div class="cards">
      <div class="card">
        <span class="card-label">填报 / 估算里程</span>
        <span class="card-value">
          ${totals.reported_distance_km}
          <span style="color:#999;font-size:16px;margin:0 4px;">/</span>
          ${Math.round(totals.estimated_distance_km)}
          <span class="card-unit">km</span>
        </span>
      </div>
      <div class="card">
        <span class="card-label">预估油费</span>
        <span class="card-value">
          ${estimatedFuelCost.toFixed(2)}
          <span class="card-unit">元</span>
        </span>
      </div>
      <div class="card">
        <span class="card-label">拜访频率</span>
        <span class="card-value">
          ${visitFrequency.toFixed(2)}
          <span class="card-unit">次/天</span>
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">每日趋势（鼠标悬停查看数值）</div>
      <div id="chart"></div>
    </div>

    ${mapSection}

    <div class="footer">由 销售外勤行为分析系统 自动生成</div>
  </div>

  <script>
    (function () {
      var daily = ${dataJson};

      var visitData = daily.map(function (d) { return { date: d.date, value: d.visit_count }; });
      var reportedData = daily.map(function (d) { return { date: d.date, value: d.reported_distance_km }; });
      var estimatedData = daily.map(function (d) { return { date: d.date, value: d.estimated_distance_km }; });

      var spec = {
        type: "common",
        data: [
          { id: "visit_data", values: visitData },
          { id: "reported_data", values: reportedData },
          { id: "estimated_data", values: estimatedData },
        ],
        series: [
          {
            type: "bar",
            id: "visit_count",
            dataId: "visit_data",
            xField: "date",
            yField: "value",
            name: "拜访数",
            bar: { style: { fill: "#1890ff" } },
            tooltip: {
              dimension: {
                title: { value: function (datum) { return datum?.date ?? ""; } },
                content: [{ key: "拜访数", value: function (datum) { return String(datum?.value ?? ""); } }],
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
            line: { style: { curveType: "monotone", lineWidth: 2, stroke: "#52c41a" } },
            point: { style: { size: 0, fill: "#52c41a" }, state: { dimension_hover: { size: 6 } } },
            tooltip: {
              dimension: {
                title: { value: function (datum) { return datum?.date ?? ""; } },
                content: [{ key: "填报里程", value: function (datum) { return String(datum?.value ?? ""); } }],
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
            line: { style: { curveType: "monotone", lineWidth: 2, stroke: "#faad14" } },
            point: { style: { size: 0, fill: "#faad14" }, state: { dimension_hover: { size: 6 } } },
            tooltip: {
              dimension: {
                title: { value: function (datum) { return datum?.date ?? ""; } },
                content: [{ key: "估算里程", value: function (datum) { return String(datum?.value ?? ""); } }],
              },
            },
          },
        ],
        axes: [
          {
            orient: "bottom",
            label: {
              formatMethod: function (value) {
                var v = Array.isArray(value) ? value[0] : value;
                if (!v) return "";
                var m = v.match(/\\d{4}-(\\d{2})-(\\d{2})/);
                return m ? m[1] + "-" + m[2] : v;
              },
            },
          },
          { orient: "left", seriesId: ["visit_count"] },
          { orient: "right", seriesId: ["reported_distance", "estimated_distance"] },
        ],
        dataZoom: [
          {
            orient: "bottom",
            filterMode: "filter",
            start: 0,
            end: 1,
            roam: true,
            minSpan: 0.1,
            height: 12,
            style: { handleSize: 20 },
          },
        ],
        legends: { visible: true, orient: "top" },
        tooltip: { visible: true, mark: { visible: false } },
        crosshair: {
          xField: { visible: true, line: { style: { lineDash: [0] } } },
        },
      };

      var ChartCtor = window.VChart;
      if (ChartCtor && ChartCtor.default) {
        ChartCtor = ChartCtor.default;
      }
      if (!ChartCtor) {
        document.getElementById("chart").innerHTML =
          '<div class="placeholder">图表库加载失败，请联网后重新打开。</div>';
        return;
      }

      try {
        var chart = new ChartCtor(spec, { dom: "chart" });
        chart.renderSync();
      } catch (e) {
        console.error(e);
        document.getElementById("chart").innerHTML =
          '<div class="placeholder">图表渲染失败，请在系统中查看。</div>';
      }
    })();
  </script>
</body>
</html>`;
}
