import { DailyOverview, UserOverviewResult } from "./userOverviewService";
import { Visit, Stop, Route, Anomaly } from "../types";

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

export interface ScopeRankingItem {
  key: string;
  name: string;
  level: "department" | "sub_department" | "person";
  visitCount: number;
  employeeCount?: number;
  reportedKm: number;
  estimatedKm: number;
  hasChildren?: boolean;
  children?: ScopeRankingItem[];
}

export interface PersonSingleDayReportInput {
  userName: string;
  userId: string;
  date: string;
  visits: Visit[];
  stops: Stop[];
  routes: Route[];
  anomalies: Anomaly[];
  mileage: {
    totalKm: number;
    reportedDistanceKm: number;
    segmentCount: number;
    estimatedFuelCost: number;
  };
  amapKey: string;
}

export interface ScopeReportInput {
  scope: "company" | "department" | "sub_department";
  scopeName: string;
  start: string;
  end: string;
  stats: {
    totalVisits: number;
    totalReportedKm: number;
    totalEstimatedKm: number;
  };
  trend: {
    date: string;
    visitCount: number;
    reportedKm: number;
    estimatedKm: number;
  }[];
  ranking: ScopeRankingItem[];
  estimatedFuelCost: number;
  visitFrequency: number;
  amapKey: string;
  points: HeatMapPoint[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildCommonStyles(): string {
  return `<style>
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
    .ranking-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    .ranking-table th,
    .ranking-table td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid #ebedf0;
    }
    .ranking-table th {
      color: #72808a;
      font-weight: 500;
      background-color: #f7f8fa;
    }
    .ranking-table tr:last-child td {
      border-bottom: none;
    }
    .ranking-tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      background-color: #f0f0f0;
      color: #333;
      font-size: 12px;
    }
    .ranking-row-header {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .expand-btn {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 1px solid #d9d9d9;
      border-radius: 4px;
      background-color: #fff;
      color: #666;
      font-size: 12px;
      line-height: 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .expand-btn:hover {
      background-color: #f5f5f5;
      color: #333;
    }
    .expand-placeholder {
      width: 18px;
      height: 18px;
      display: inline-block;
    }
    .ranking-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>`;
}

function buildChartScript(
  daily: { date: string; visit_count: number; reported_distance_km: number; estimated_distance_km: number }[],
  chartDomId = "chart"
): string {
  const dataJson = JSON.stringify(daily)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  return `(function () {
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
        document.getElementById("${chartDomId}").innerHTML =
          '<div class="placeholder">图表库加载失败，请联网后重新打开。</div>';
        return;
      }

      try {
        var chart = new ChartCtor(spec, { dom: "${chartDomId}" });
        chart.renderSync();
      } catch (e) {
        console.error(e);
        document.getElementById("${chartDomId}").innerHTML =
          '<div class="placeholder">图表渲染失败，请在系统中查看。</div>';
      }
    })();`;
}

function buildMapScript(amapKey: string, points: HeatMapPoint[], mapDomId = "amap-report"): string {
  const pointsJson = JSON.stringify(points)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  return `(function initReportMap() {
        var key = "${escapeHtml(amapKey)}";
        var mapPoints = ${pointsJson};

        var container = document.getElementById("${mapDomId}");
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
          var map = new AMap.Map("${mapDomId}", {
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
      })();`;
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
    date: d.date,
    visit_count: d.visit_count,
    reported_distance_km: d.reported_distance_km,
    estimated_distance_km: Math.round(d.estimated_distance_km),
  }));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(userName)} ${start} ~ ${end} 外勤行为报告</title>
  <script src="https://unpkg.com/@visactor/vchart/build/index.min.js"></script>
  ${buildCommonStyles()}
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

    <div class="section">
      <div class="section-title">拜访热度地图</div>
      <div id="amap-report" style="width:100%;height:400px;border-radius:8px;background:#e5e5e5;"></div>
    </div>

    <div class="footer">由 销售外勤行为分析系统 自动生成</div>
  </div>

  <script>
    ${buildChartScript(daily, "chart")}
    ${buildMapScript(amapKey, points, "amap-report")}
  </script>
</body>
</html>`;
}

export function renderPersonSingleDayHtml(input: PersonSingleDayReportInput): string {
  const { userName, date, visits, stops, routes, anomalies, mileage, amapKey } = input;

  const hasMileageInvalid = anomalies.some((a) => a.type === "mileage_reading_invalid");

  const mileageValue =
    mileage.reportedDistanceKm === 0 && mileage.totalKm === 0
      ? '<span style="color:#999;font-size:16px;">公共交通/无驾车</span>'
      : `<span style="color:${hasMileageInvalid ? "#fa8c16" : mileage.reportedDistanceKm ? "#0f1419" : "#999"}">${mileage.reportedDistanceKm || "未填报"}</span><span style="font-size:14px;color:#999;margin:0 4px;">vs</span><span>${Math.round(mileage.totalKm)}</span>`;

  const fuelValue =
    mileage.estimatedFuelCost === 0 && mileage.totalKm === 0
      ? '<span style="color:#999;">-</span>'
      : mileage.estimatedFuelCost.toFixed(2);

  // 按 approval_id 分组
  const allGroup: { key: string; label: string; color: string; visits: Visit[]; routes: Route[] } = {
    key: "__ALL__",
    label: "全天总览",
    color: "#1890ff",
    visits,
    routes,
  };

  const byApproval = new Map<string, Visit[]>();
  for (const v of visits) {
    const key = v.approval_id || "__NO_APPROVAL__";
    if (!byApproval.has(key)) byApproval.set(key, []);
    byApproval.get(key)!.push(v);
  }

  const routeColors = ["#1677ff", "#9e1068", "#135200", "#531dab", "#006d75", "#262626", "#08979c", "#780650"];
  const groups = [allGroup];
  let colorIdx = 0;
  for (const [key, groupVisits] of byApproval) {
    if (key === "__NO_APPROVAL__") continue;
    const groupVisitIds = new Set(groupVisits.map((v) => v.id));
    const groupRoutes = routes.filter(
      (r) => groupVisitIds.has(r.from_visit_id) && groupVisitIds.has(r.to_visit_id)
    );
    groups.push({
      key,
      label: `审批 ${key.slice(-8)}`,
      color: routeColors[colorIdx % routeColors.length],
      visits: groupVisits,
      routes: groupRoutes,
    });
    colorIdx++;
  }

  // 构建时间线 HTML（全天总览）
  const sortedVisits = [...visits].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const routeMap = new Map<string, number>();
  for (const r of routes) {
    routeMap.set(`${r.from_visit_id},${r.to_visit_id}`, r.distance_km);
  }

  const markColors = {
    start: "#52c41a",
    waypoint: "#1890ff",
    end: "#ff4d4f",
    publicTransport: "#722ed1",
  };

  function isPublicTransport(visit: Visit): boolean {
    return (visit.trip_type || "").includes("公共交通");
  }

  function formatAddress(value?: string | null): string {
    return value && value.trim() ? value.trim() : "未知地址";
  }

  function buildAnomalyTag(anomaly: Anomaly): string | null {
    if (
      anomaly.type === "mileage_deviation" ||
      anomaly.type === "route_detour" ||
      anomaly.type === "mileage_reading_invalid"
    ) {
      return "里程异常";
    }
    if (anomaly.type === "invalid_trip_type") return "异常出行";
    if (anomaly.type === "missing_special_reason") return "缺原因";
    return null;
  }

  function getVisitTags(visit: Visit): string[] {
    const tags: string[] = [];
    const added = new Set<string>();
    for (const a of anomalies) {
      const relatesToVisit = a.related_visit_ids.includes(visit.id);
      const relatesByApproval =
        a.type === "mileage_reading_invalid" &&
        visit.approval_id &&
        a.metadata?.approval_id === visit.approval_id;
      if (!relatesToVisit && !relatesByApproval) continue;
      const label = buildAnomalyTag(a);
      if (!label || added.has(label)) continue;
      added.add(label);
      tags.push(label);
    }
    return tags;
  }

  function formatHHmm(timestamp: Date | string): string {
    const d = new Date(timestamp);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  const timelineItems = sortedVisits.map((visit, idx) => {
    const isStart = idx === 0;
    const isEnd = idx === sortedVisits.length - 1;
    const isPublic = isPublicTransport(visit);
    let sequenceLabel: string;
    let markColor: string;
    if (isPublic) {
      sequenceLabel = "公";
      markColor = markColors.publicTransport;
    } else if (isStart) {
      sequenceLabel = "起";
      markColor = markColors.start;
    } else if (isEnd) {
      sequenceLabel = "终";
      markColor = markColors.end;
    } else {
      sequenceLabel = `途${idx}`;
      markColor = markColors.waypoint;
    }

    const nextDistance =
      !isEnd
        ? routeMap.get(`${visit.id},${sortedVisits[idx + 1].id}`)
        : undefined;
    const tags = getVisitTags(visit);
    const address = formatAddress(visit.address || visit.location_name);

    return `
      <div class="timeline-item">
        <div class="timeline-dot" style="background-color:${markColor};">${sequenceLabel}</div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-address" title="${escapeHtml(address)}">${escapeHtml(address)}</span>
            <span class="timeline-time">${formatHHmm(visit.timestamp)}</span>
          </div>
          ${visit.customer_name ? `<div class="timeline-customer">客户：${escapeHtml(visit.customer_name)}</div>` : ""}
          ${tags.length > 0 ? `<div class="timeline-tags">${tags.map((t) => `<span class="timeline-tag">${t}</span>`).join("")}</div>` : ""}
          ${nextDistance != null ? `<div class="timeline-distance">${nextDistance.toFixed(1)} km</div>` : ""}
        </div>
      </div>
    `;
  });

  const timelineHtml =
    timelineItems.length > 0
      ? timelineItems.join("")
      : '<div style="color:#999;font-size:14px;">暂无轨迹数据</div>';

  // 异常事件 HTML
  const anomalySeverityText = { high: "高", medium: "中", low: "低" };
  const anomalySeverityColor = { high: "#f5222d", medium: "#fa8c16", low: "#52c41a" };
  const anomalyTypeTitles: Record<string, string> = {
    duplicate_location: "重复签到",
    long_stop: "停留过长",
    invalid_trip_type: "异常出行方式",
    missing_special_reason: "特殊签到缺原因",
    mileage_reading_invalid: "里程读数异常",
  };

  function renderAnomalyRow(a: Anomaly): string {
    const m = a.metadata || {};
    let title: string;
    let description: string;

    if (m.from_location && m.to_location && a.type === "mileage_deviation") {
      title = `${m.from_location} → ${m.to_location}`;
      description = `填报 ${m.reported_distance_km ?? "-"}km vs 高德 ${m.gaode_distance_km != null ? Math.round(m.gaode_distance_km) : "-"}km · 偏差 ${m.deviation_rate != null ? `${(m.deviation_rate * 100).toFixed(1)}%` : "-"}`;
    } else if (a.type === "long_idle" && a.start_time && a.end_time) {
      const start = new Date(a.start_time);
      const end = new Date(a.end_time);
      const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
      title = `${minutes}min无移动记录`;
      description = `${formatHHmm(a.start_time)} - ${formatHHmm(a.end_time)}`;
    } else if (a.type === "low_visit_count") {
      const match = a.description.match(/过去\s*5\s*个工作日累计签到\s*(\d+)\s*次/);
      const count = match ? match[1] : "?";
      title = "签到次数不足";
      description = `过去 5 个工作日累计签到 ${count} 次`;
    } else {
      title = anomalyTypeTitles[a.type] || "异常";
      description = a.description;
    }

    return `
      <div class="anomaly-row">
        <span class="anomaly-severity" style="background-color:${anomalySeverityColor[a.severity]};">${anomalySeverityText[a.severity]}</span>
        <div class="anomaly-body">
          <div class="anomaly-title">${escapeHtml(title)}</div>
          <div class="anomaly-desc">${escapeHtml(description)}</div>
        </div>
      </div>
    `;
  }

  const anomalySection =
    anomalies.length > 0
      ? `<div style="display:flex;flex-direction:column;gap:12px;">${anomalies.map(renderAnomalyRow).join("")}</div>`
      : '<div style="color:#999;font-size:14px;">暂无异常</div>';

  // 地图数据 JSON
  const mapData = {
    key: amapKey,
    groups: groups.map((g) => ({
      key: g.key,
      label: g.label,
      color: g.color,
      visits: g.visits
        .filter((v) => v.lat != null && v.lng != null && (v.lat !== 0 || v.lng !== 0))
        .map((v) => ({
          id: v.id,
          lat: v.lat,
          lng: v.lng,
          timestamp: typeof v.timestamp === "string" ? v.timestamp : v.timestamp.toISOString(),
          title: v.special_sign_reason ? v.location_name || v.special_sign_reason : v.visit_note || v.location_name,
          tripType: v.trip_type || "",
        })),
      routes: g.routes.map((r) => ({
        polyline: r.polyline,
        color: g.color,
      })),
    })),
    stops: stops.map((s) => ({
      lat: s.lat,
      lng: s.lng,
      duration: s.duration_minutes,
    })),
  };

  const mapDataJson = JSON.stringify(mapData)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(userName)} ${date} 外勤行为报告</title>
  ${buildCommonStyles()}
  <style>
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 20px;
      position: relative;
      padding-left: 20px;
    }
    .timeline::before {
      content: "";
      position: absolute;
      left: 33px;
      top: 14px;
      bottom: 14px;
      width: 2px;
      background-color: #ebedf0;
    }
    .timeline-item {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      position: relative;
    }
    .timeline-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      border: 2px solid #fff;
      flex-shrink: 0;
      z-index: 1;
    }
    .timeline-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 2px;
    }
    .timeline-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }
    .timeline-address {
      font-size: 14px;
      font-weight: 600;
      color: #0f1419;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .timeline-time {
      font-size: 14px;
      color: #0f1419;
      font-weight: 500;
      flex-shrink: 0;
    }
    .timeline-customer {
      font-size: 13px;
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .timeline-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .timeline-tag {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 4px;
      background-color: #fff7e6;
      color: #fa8c16;
      font-size: 12px;
      font-weight: 500;
    }
    .timeline-distance {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 4px;
      background-color: #f5f5f5;
      border: 1px solid #d9d9d9;
      color: #333;
      font-size: 12px;
      width: fit-content;
    }
    .anomaly-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .anomaly-severity {
      flex-shrink: 0;
      width: 28px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 4px;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
    }
    .anomaly-body {
      flex: 1;
      min-width: 0;
    }
    .anomaly-title {
      font-size: 14px;
      font-weight: 600;
      color: #0f1419;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .anomaly-desc {
      font-size: 13px;
      color: #666;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(userName)} 外勤行为报告</h1>
    <div class="subtitle">${date} · 单日轨迹明细</div>

    <div class="cards" style="grid-template-columns: repeat(4, 1fr);">
      <div class="card">
        <span class="card-label">拜访点数</span>
        <span class="card-value">${visits.length}</span>
      </div>
      <div class="card">
        <span class="card-label">总里程 vs 估算里程</span>
        <span class="card-value" style="font-size: 22px;">${mileageValue}</span>
      </div>
      <div class="card">
        <span class="card-label">Segment 数</span>
        <span class="card-value">${mileage.segmentCount}</span>
      </div>
      <div class="card">
        <span class="card-label">估算油费 (元)</span>
        <span class="card-value">${fuelValue}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">轨迹地图</div>
      <div id="trajectory-map" style="width:100%;height:500px;border-radius:8px;background:#e5e5e5;"></div>
    </div>

    <div class="section">
      <div class="section-title">轨迹内容</div>
      <div class="timeline">
        ${timelineHtml}
      </div>
    </div>

    <div class="section">
      <div class="section-title">异常事件 ${anomalies.length > 0 ? `<span style="font-size:13px;color:#F54C5C;margin-left:8px;">${anomalies.length}</span>` : ""}</div>
      ${anomalySection}
    </div>

    <div class="footer">由 销售外勤行为分析系统 自动生成</div>
  </div>

  <script>
    (function renderTrajectoryMap() {
      var mapData = ${mapDataJson};
      var container = document.getElementById("trajectory-map");
      if (!mapData.key || !mapData.groups.length) {
        if (container) container.innerHTML = '<div class="placeholder">暂无地图数据或 Key 未配置，请在系统中查看。</div>';
        return;
      }

      function loadMap() {
        if (typeof AMap === "undefined" || !AMap.Map) {
          var script = document.createElement("script");
          script.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(mapData.key) + "&plugin=AMap.ToolBar,AMap.Scale";
          script.async = true;
          script.defer = true;
          script.onload = renderTrajectoryMap;
          script.onerror = function () {
            if (container) container.innerHTML = '<div class="placeholder">地图加载失败，请检查网络或 Key 配置。</div>';
          };
          document.head.appendChild(script);
          return;
        }

        try {
          var map = new AMap.Map("trajectory-map", { zoom: 12, center: [116.397428, 39.90923] });
          map.addControl(new AMap.ToolBar());
          map.addControl(new AMap.Scale());

          var allMarkers = [];
          var allVisits = [];

          mapData.groups.forEach(function (g) {
            var sortedVisits = g.visits.slice().sort(function (a, b) {
              return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            });
            var path = [];

            g.routes.forEach(function (r) {
              r.polyline.split(";").forEach(function (pt) {
                var parts = pt.split(",");
                if (parts.length === 2) {
                  path.push([parseFloat(parts[0]), parseFloat(parts[1])]);
                }
              });
            });

            if (path.length > 0) {
              var grayLine = new AMap.Polyline({ path: path, strokeColor: "#d9d9d9", strokeWeight: 4, strokeOpacity: 0.8 });
              grayLine.setMap(map);
              var colorLine = new AMap.Polyline({ path: path, strokeColor: g.color, strokeWeight: 5, strokeOpacity: 0.9, showDir: true });
              colorLine.setMap(map);
            }

            sortedVisits.forEach(function (v, idx) {
              var isStart = idx === 0;
              var isEnd = idx === sortedVisits.length - 1;
              var isPublic = (v.tripType || "").includes("公共交通");
              var label = isPublic ? "公" : isStart ? "起" : isEnd ? "终" : "途" + idx;
              var bgColor = isPublic ? "#722ed1" : isStart ? "#52c41a" : isEnd ? "#ff4d4f" : "#1890ff";
              var opacity = !isPublic && (isStart || isEnd) ? 0.85 : 1;
              var zIndex = isPublic ? 130 : isEnd ? 120 : isStart ? 110 : 90;

              var marker = new AMap.Marker({
                position: [v.lng, v.lat],
                title: v.title,
                content: '<div style="position:relative;width:28px;height:28px;border-radius:50%;background:' + bgColor + ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);opacity:' + opacity + '">' + label + '</div>',
                offset: new AMap.Pixel(-14, -14),
                zIndex: zIndex,
              });
              marker.setMap(map);
              allMarkers.push(marker);
              allVisits.push(v);
            });
          });

          mapData.stops.forEach(function (s) {
            var circle = new AMap.CircleMarker({
              center: [s.lng, s.lat],
              radius: 14,
              fillColor: "#ff4d4f",
              strokeColor: "#ff4d4f",
              fillOpacity: 0.6,
              zIndex: 80,
            });
            circle.setMap(map);
            var label = new AMap.Text({
              text: s.duration + "分",
              position: [s.lng, s.lat],
              style: { backgroundColor: "#ff4d4f", color: "#fff", padding: "1px 4px", borderRadius: "4px", fontSize: "10px" },
              offset: new AMap.Pixel(0, -22),
              zIndex: 81,
            });
            label.setMap(map);
            allMarkers.push(circle, label);
          });

          if (allVisits.length > 0) {
            map.setFitView();
          }
        } catch (e) {
          console.error(e);
          if (container) container.innerHTML = '<div class="placeholder">地图渲染失败，请在系统中查看。</div>';
        }
      }

      loadMap();
    })();
  </script>
</body>
</html>`;
}

export function renderScopeConsoleReportHtml(input: ScopeReportInput): string {
  const {
    scope,
    scopeName,
    start,
    end,
    stats,
    trend,
    ranking,
    estimatedFuelCost,
    visitFrequency,
    amapKey,
    points,
  } = input;

  const isSingleDay = start === end;

  const daily = trend.map((d) => ({
    date: d.date,
    visit_count: d.visitCount,
    reported_distance_km: d.reportedKm,
    estimated_distance_km: Math.round(d.estimatedKm),
  }));

  const rankingTitle =
    scope === "company"
      ? "部门排行榜"
      : scope === "department"
      ? "子部门排行榜"
      : "人员排行榜";

  function flattenRanking(
    items: ScopeRankingItem[],
    parentKey = "",
    depth = 0
  ): Array<ScopeRankingItem & { parentKey: string; depth: number; order: number }> {
    const result: Array<ScopeRankingItem & { parentKey: string; depth: number; order: number }> = [];
    items.forEach((item, index) => {
      result.push({ ...item, parentKey, depth, order: index + 1 });
      if (item.children && item.children.length > 0) {
        result.push(...flattenRanking(item.children, item.key, depth + 1));
      }
    });
    return result;
  }

  const flatRanking = flattenRanking(ranking);

  const rankingRows = flatRanking
    .map((r) => {
      const hasChildren = (r.children && r.children.length > 0) || r.hasChildren;
      const expandButton = hasChildren
        ? `<button class="expand-btn" data-key="${escapeHtml(r.key)}" aria-label="展开">+</button>`
        : `<span class="expand-placeholder"></span>`;
      const indent = r.depth * 24;
      const displayStyle = r.depth === 0 ? "" : ' style="display:none;"';
      return `<tr data-key="${escapeHtml(r.key)}" data-parent="${escapeHtml(r.parentKey)}" data-depth="${r.depth}"${displayStyle}>
        <td style="padding-left:${16 + indent}px;">
          <span class="ranking-row-header">
            ${expandButton}
            <span class="ranking-tag">${r.order}</span>
            <span class="ranking-name">${escapeHtml(r.name)}</span>
          </span>
        </td>
        <td>${r.visitCount}</td>
        <td>${Math.round(r.reportedKm)} / ${Math.round(r.estimatedKm)} km</td>
      </tr>`;
    })
    .join("");

  const rankingSection = `<div class="section">
    <div class="section-title">${rankingTitle}</div>
    <table class="ranking-table" id="ranking-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>拜访次数</th>
          <th>填报 / 估算里程</th>
        </tr>
      </thead>
      <tbody>
        ${rankingRows || '<tr><td colspan="3" style="text-align:center;color:#999;padding:24px;">暂无排行数据</td></tr>'}
      </tbody>
    </table>
  </div>`;

  const trendSection = isSingleDay
    ? ""
    : `<div class="section">
      <div class="section-title">每日趋势（鼠标悬停查看数值）</div>
      <div id="chart"></div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(scopeName)} ${start} ~ ${end} 外勤行为报告</title>
  <script src="https://unpkg.com/@visactor/vchart/build/index.min.js"></script>
  ${buildCommonStyles()}
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(scopeName)} 外勤行为报告</h1>
    <div class="subtitle">${start} ~ ${end} · 用于油费消费合理性核对</div>

    <div class="cards">
      <div class="card">
        <span class="card-label">填报 / 估算里程</span>
        <span class="card-value">
          ${Math.round(stats.totalReportedKm)}
          <span style="color:#999;font-size:16px;margin:0 4px;">/</span>
          ${Math.round(stats.totalEstimatedKm)}
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

    ${trendSection}

    <div class="section">
      <div class="section-title">拜访热度地图</div>
      <div id="amap-report" style="width:100%;height:400px;border-radius:8px;background:#e5e5e5;"></div>
    </div>

    ${rankingSection}

    <div class="footer">由 销售外勤行为分析系统 自动生成</div>
  </div>

  <script>
    ${isSingleDay ? "" : buildChartScript(daily, "chart")}
    ${buildMapScript(amapKey, points, "amap-report")}

    // 排行榜展开/折叠
    (function initRankingExpand() {
      var table = document.getElementById("ranking-table");
      if (!table) return;
      table.addEventListener("click", function (e) {
        var target = e.target;
        if (!target || !target.classList.contains("expand-btn")) return;
        var key = target.getAttribute("data-key");
        if (!key) return;
        var rows = table.querySelectorAll("tbody tr[data-parent='" + key + "']");
        var expanded = target.getAttribute("data-expanded") === "true";
        rows.forEach(function (row) {
          row.style.display = expanded ? "none" : "";
        });
        target.setAttribute("data-expanded", expanded ? "false" : "true");
        target.textContent = expanded ? "+" : "−";
        e.stopPropagation();
      });
    })();
  </script>
</body>
</html>`;
}
