import { DailyOverview, UserOverviewResult } from "./userOverviewService";

export interface HeatMapPoint {
  lat: number;
  lng: number;
  count: number;
}

export interface ReportInput {
  userId: string;
  userName: string;
  start: string;
  end: string;
  overview: UserOverviewResult;
  estimatedFuelCost: number;
  visitFrequency: number;
  amapKey: string; // 前端高德 JS API Key
  points: HeatMapPoint[]; // 热力图坐标点
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
    amapKey,
    points,
  } = input;

  const totals = overview.totals;
  const daily = overview.daily.map((d) => ({
    ...d,
    estimated_distance_km: Math.round(d.estimated_distance_km),
  }));

  const dataJson = JSON.stringify(daily)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  const pointsJson = JSON.stringify(points)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  const mapSection = `<div class="section">
    <div class="section-title">拜访热度地图</div>
    <div id="amap-report" style="width:100%;height:400px;border-radius:8px;background:#e5e5e5;"></div>
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

      // 初始化高德地图热力图（打开报告时实时渲染，避免 html2canvas 无法捕获 WebGL 底图）
      (function initReportMap() {
        var key = "${escapeHtml(amapKey)}";
        var mapPoints = ${pointsJson};

        var container = document.getElementById("amap-report");
        if (!key || !mapPoints.length) {
          if (container) {
            container.innerHTML =
              '<div class="placeholder">暂无地图数据或 Key 未配置，请在系统中查看。</div>';
          }
          return;
        }

        if (typeof AMap === "undefined" || !AMap.Map) {
          var script = document.createElement("script");
          script.src =
            "https://webapi.amap.com/maps?v=2.0&key=" +
            encodeURIComponent(key) +
            "&plugin=AMap.HeatMap,AMap.ToolBar,AMap.Scale";
          script.async = true;
          script.defer = true;
          script.onload = initReportMap;
          script.onerror = function () {
            if (container) {
              container.innerHTML =
                '<div class="placeholder">地图加载失败，请检查网络或 Key 配置。</div>';
            }
          };
          document.head.appendChild(script);
          return;
        }

        try {
          var map = new AMap.Map("amap-report", {
            zoom: 5,
            center: [116.397428, 39.90923],
          });
          map.addControl(new AMap.ToolBar());
          map.addControl(new AMap.Scale());

          map.plugin(["AMap.HeatMap"], function () {
            var heatmap = new AMap.HeatMap(map, {
              radius: 25,
              opacity: [0, 0.8],
              gradient: {
                0.5: "blue",
                0.65: "rgb(117,211,248)",
                0.7: "rgb(0, 255, 0)",
                0.9: "#ffea00",
                1.0: "red",
              },
            });

            var data = mapPoints.map(function (p) {
              return { lng: p.lng, lat: p.lat, count: p.count };
            });
            var max =
              Math.max.apply(
                null,
                mapPoints.map(function (p) {
                  return p.count;
                })
              ) || 1;
            heatmap.setDataSet({ data: data, max: max });

            if (mapPoints.length === 1) {
              map.setCenter([mapPoints[0].lng, mapPoints[0].lat]);
              map.setZoom(13);
            } else {
              var lats = mapPoints.map(function (p) {
                return p.lat;
              });
              var lngs = mapPoints.map(function (p) {
                return p.lng;
              });
              var minLat = Math.min.apply(null, lats);
              var maxLat = Math.max.apply(null, lats);
              var minLng = Math.min.apply(null, lngs);
              var maxLng = Math.max.apply(null, lngs);
              var latPad = Math.max((maxLat - minLat) * 0.2, 0.005);
              var lngPad = Math.max((maxLng - minLng) * 0.2, 0.005);
              var bounds = new AMap.Bounds(
                [minLng - lngPad, minLat - latPad],
                [maxLng + lngPad, maxLat + latPad]
              );
              map.setBounds(bounds);
            }
          });
        } catch (e) {
          console.error(e);
          if (container) {
            container.innerHTML =
              '<div class="placeholder">地图渲染失败，请在系统中查看。</div>';
          }
        }
      })();
    })();
  </script>
</body>
</html>`;
}
