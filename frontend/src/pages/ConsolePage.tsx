import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Row,
  Col,
  List,
  Tag,
  DatePicker,
  Toast,
  Cascader,
  Popover,
} from "@douyinfe/semi-ui";
import {
  IconPlayCircle,
  IconPause,
  IconRedo,
  IconChevronDown,
  IconChevronUp,
  IconChevronRight,
  IconAlertTriangle,
} from "@douyinfe/semi-icons";

import dayjs from "dayjs";
import {
  fetchAvailableDates,
  fetchVisits,
  fetchStops,
  fetchRoutes,
  fetchMileage,
  fetchAnomalies,
  fetchUserOverview,
  fetchOrgOverview,
  fetchDingTalkOrgTree,
  fetchDingTalkOrgUsers,
  exportConsoleReport,
  AvailableDate,
  UserOverviewResult,
  DailyOverview,
  OrgTreeNode,
  OrgOverviewResponse,
} from "../api";
import { User, Visit, Stop, Route, Anomaly, MileageStats } from "../types";
import MapContainer from "../components/MapContainer";
import HeatMapContainer from "../components/HeatMapContainer";
import OrgQueryPanel from "../components/OrgQueryPanel";
import TrajectoryTimeline from "../components/TrajectoryTimeline";
import { AnomalyItem } from "../components/AnomalyItem";
import DateAxis from "../components/DateAxis";
import { Suspense, lazy } from "react";

const OverviewChart = lazy(() => import("../components/OverviewChart"));

const MAX_MILEAGE_KM = parseFloat(import.meta.env.VITE_MILEAGE_MAX_KM || "5000");

const ROUTE_COLORS = [
  "#1677ff", // 亮蓝
  "#9e1068", // 玫红
  "#135200", // 暗绿
  "#531dab", // 紫色
  "#006d75", // 墨青
  "#262626", // 近黑（作为中性高对比锚点）
  "#08979c", // 青
  "#780650", // 深洋红
];

interface ApprovalGroup {
  key: string;
  label: string;
  visits: Visit[];
  routes: Route[];
  stops: Stop[];
  anomalies: Anomaly[];
  mileage: MileageStats;
}

type QueryScope = "company" | "department" | "sub_department" | "person";

interface CascaderDataItem {
  value: string;
  label: string;
  children?: CascaderDataItem[];
}

/** F10：不展示在级联选择器中的顶层部门 */
const EXCLUDED_TOP_DEPARTMENTS = new Set([
  "财务",
  "人力资源部",
  "市场营销",
  "销售渠道",
  "销售渠道2",
  "供应商",
  "渠道及销售管理部",
  "研发部",
]);

function isExcludedTopDepartment(name: string): boolean {
  for (const excluded of EXCLUDED_TOP_DEPARTMENTS) {
    if (name.startsWith(excluded)) {
      return true;
    }
  }
  return false;
}

const DIRECT_SUFFIX = "__DIRECT__";

function buildCascaderData(tree: OrgTreeNode[], users: User[]): CascaderDataItem[] {
  const root: CascaderDataItem = {
    value: "company|__ALL__",
    label: "全公司",
    children: [],
  };

  for (const dept of tree) {
    if (isExcludedTopDepartment(dept.name)) continue;
    const deptNode: CascaderDataItem = {
      value: `dept|${dept.name}`,
      label: dept.shortName,
      children: [],
    };

    if (dept.children && dept.children.length > 0) {
      // 子部门及子部门下人员
      for (const sub of dept.children) {
        const subNode: CascaderDataItem = {
          value: `sub|${dept.name}-${sub.name}`,
          label: sub.shortName,
          children: [],
        };

        const subUserIds = new Set(sub.userIds || []);
        const subUsers = users.filter((u) => subUserIds.has(u.user_id));
        for (const u of subUsers) {
          subNode.children!.push({
            value: `user|${u.user_id}`,
            label: u.user_name || u.user_id,
          });
        }

        deptNode.children!.push(subNode);
      }

      // 父部门直属人员（如总 leader、sub leader）单独放一个「直属」节点
      const directUserIds = new Set(dept.userIds || []);
      const directUsers = users.filter((u) => directUserIds.has(u.user_id));
      if (directUsers.length > 0) {
        const directNode: CascaderDataItem = {
          value: `sub|${dept.name}-${DIRECT_SUFFIX}`,
          label: "直属",
          children: [],
        };
        for (const u of directUsers) {
          directNode.children!.push({
            value: `user|${u.user_id}`,
            label: u.user_name || u.user_id,
          });
        }
        deptNode.children!.push(directNode);
      }
    } else {
      // 没有子部门的父部门，直接把用户挂下面
      const deptUserIds = new Set(dept.userIds || []);
      const deptUsers = users.filter((u) => deptUserIds.has(u.user_id));
      for (const u of deptUsers) {
        deptNode.children!.push({
          value: `user|${u.user_id}`,
          label: u.user_name || u.user_id,
        });
      }
    }

    root.children!.push(deptNode);
  }

  return [root];
}

function parseCascaderValue(value: string[]): {
  scope: QueryScope;
  node?: string;
  userId?: string;
} {
  if (value.length === 0) {
    return { scope: "company" };
  }

  const last = value[value.length - 1];
  if (last === "company|__ALL__") {
    return { scope: "company" };
  }

  const [type, id] = last.split("|");

  if (type === "user") {
    return { scope: "person", userId: id };
  }
  if (type === "sub") {
    // 「直属」虚拟节点按部门范围查询
    if (id.endsWith(`-${DIRECT_SUFFIX}`)) {
      const deptName = id.slice(0, -(DIRECT_SUFFIX.length + 1));
      return { scope: "department", node: deptName };
    }
    return { scope: "sub_department", node: id };
  }
  if (type === "dept") {
    return { scope: "department", node: id };
  }

  return { scope: "company" };
}

function getCascaderValueFromState(
  scope: QueryScope,
  node?: string,
  userId?: string,
  tree?: OrgTreeNode[]
): string[] {
  if (scope === "company") return ["company|__ALL__"];

  // 树还没加载完时，用当前 scope/node/userId 构造一个临时值，避免 cascaderValue 为空触发 onChange 回跳
  if (!tree) {
    if (scope === "person" && userId) return ["company|__ALL__", `user|${userId}`];
    if ((scope === "department" || scope === "sub_department") && node) return ["company|__ALL__", `${scope === "department" ? "dept" : "sub"}|${node}`];
    return ["company|__ALL__"];
  }

  if (scope === "person" && userId) {
    for (const dept of tree) {
      // 先检查父部门直属人员
      if ((dept.userIds || []).includes(userId)) {
        if (dept.children?.length) {
          return ["company|__ALL__", `dept|${dept.name}`, `sub|${dept.name}-${DIRECT_SUFFIX}`, `user|${userId}`];
        }
        return ["company|__ALL__", `dept|${dept.name}`, `user|${userId}`];
      }
      // 再检查子部门
      for (const sub of dept.children || []) {
        if ((sub.userIds || []).includes(userId)) {
          return ["company|__ALL__", `dept|${dept.name}`, `sub|${dept.name}-${sub.name}`, `user|${userId}`];
        }
      }
    }
  }

  if ((scope === "department" || scope === "sub_department") && node) {
    for (const dept of tree) {
      if (dept.name === node) {
        return ["company|__ALL__", `dept|${node}`];
      }
      for (const sub of dept.children || []) {
        if (`${dept.name}-${sub.name}` === node) {
          return ["company|__ALL__", `dept|${dept.name}`, `sub|${node}`];
        }
      }
    }
  }

  return [];
}

const statStyle: React.CSSProperties = {
  padding: 20,
  backgroundColor: "#fff",
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const statLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#72808a",
  fontWeight: 500,
};

const statValueStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#0f1419",
};

function fillDailyRange(
  daily: DailyOverview[],
  start: string,
  end: string
): DailyOverview[] {
  const map = new Map(daily.map((d) => [d.date, d]));
  const result: DailyOverview[] = [];
  const s = dayjs.tz(start);
  const e = dayjs.tz(end);
  for (let d = s; d.isBefore(e) || d.isSame(e); d = d.add(1, "day")) {
    const ds = d.format("YYYY-MM-DD");
    result.push(
      map.get(ds) ?? {
        date: ds,
        visit_count: 0,
        stop_minutes: 0,
        reported_distance_km: 0,
        estimated_distance_km: 0,
        anomaly_count: 0,
      }
    );
  }
  return result;
}

function ConsolePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // 组织架构与人员
  const [users, setUsers] = useState<User[]>([]);
  const [orgTree, setOrgTree] = useState<OrgTreeNode[]>([]);
  const cascaderData = useMemo<CascaderDataItem[]>(
    () => buildCascaderData(orgTree, users),
    [orgTree, users]
  );

  // 查询范围状态
  const [scope, setScope] = useState<QueryScope>("company");
  const [node, setNode] = useState<string | undefined>(undefined);
  const [userId, setUserId] = useState<string | undefined>(undefined);

  // 级联选择器当前值（由 scope/node/userId/orgTree 派生，避免 useEffect 触发的 onChange 循环）
  const cascaderValue = useMemo(
    () => getCascaderValueFromState(scope, node, userId, orgTree),
    [scope, node, userId, orgTree]
  );

  // 日期范围状态：统一使用范围，单日时 start === end
  const [dateRange, setDateRange] = useState<[string, string]>(() => {
    const yesterday = dayjs.tz().subtract(1, "day").format("YYYY-MM-DD");
    return [yesterday, yesterday];
  });

  // 个人视图状态
  const [availableDateInfos, setAvailableDateInfos] = useState<AvailableDate[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [mileage, setMileage] = useState<MileageStats | null>(null);
  const [routeProgressMap, setRouteProgressMap] = useState<Record<string, number>>({});
  const [playingRoutes, setPlayingRoutes] = useState<Set<string>>(new Set());

  // 周期总览状态
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewData, setOverviewData] = useState<UserOverviewResult | null>(null);
  const [overviewVisits, setOverviewVisits] = useState<Visit[]>([]);

  // 组织维度总览状态（用于导出和按钮可用性）
  const [orgOverviewLoading, setOrgOverviewLoading] = useState(false);
  const [orgOverviewData, setOrgOverviewData] = useState<OrgOverviewResponse | null>(null);

  const [dataLoading, setDataLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);

  // 轨迹内容与异常事件卡片的展开状态
  const [trajectoryExpanded, setTrajectoryExpanded] = useState(true);
  const [anomalyExpanded, setAnomalyExpanded] = useState(false);

  // 初始化：加载人员和组织架构
  useEffect(() => {
    let cancelled = false;
    setDataLoading(true);
    Promise.all([fetchDingTalkOrgUsers(), fetchDingTalkOrgTree()])
      .then(([userData, treeData]) => {
        if (cancelled) return;
        setUsers(userData);
        setOrgTree(treeData);
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 从 URL 初始化查询条件
  // 支持 user 参数为 user_id 或 user_name；如果是姓名，需等用户列表加载后解析为 user_id
  const urlInitializedRef = useRef(false);
  useEffect(() => {
    if (urlInitializedRef.current) return;

    const scopeFromUrl = searchParams.get("scope") as QueryScope | null;
    const nodeFromUrl = searchParams.get("node") || undefined;
    const userFromUrl = searchParams.get("user") || undefined;
    const startFromUrl = searchParams.get("start");
    const endFromUrl = searchParams.get("end");
    const dateFromUrl = searchParams.get("date");

    let initialScope: QueryScope = "company";
    let initialNode: string | undefined;
    let initialUser: string | undefined;

    if (userFromUrl) {
      initialScope = "person";
      const looksLikeUserId = /^\d+$/.test(userFromUrl);
      if (looksLikeUserId) {
        initialUser = userFromUrl;
      } else if (users.length > 0) {
        const matched = users.find((u) => u.user_name === userFromUrl);
        initialUser = matched?.user_id ?? userFromUrl;
      } else {
        // 用户列表尚未加载，等待下次 effect 执行
        return;
      }
    } else if (scopeFromUrl && ["company", "department", "sub_department", "person"].includes(scopeFromUrl)) {
      initialScope = scopeFromUrl;
      initialNode = nodeFromUrl;
    }

    urlInitializedRef.current = true;
    setScope(initialScope);
    setNode(initialNode);
    setUserId(initialUser);

    // 日期优先用 start/end，否则回退到 date
    if (startFromUrl && endFromUrl) {
      setDateRange([startFromUrl, endFromUrl]);
      if (initialScope === "person" && startFromUrl === endFromUrl) {
        setSelectedDate(startFromUrl);
      }
    } else if (dateFromUrl) {
      setDateRange([dateFromUrl, dateFromUrl]);
      setSelectedDate(dateFromUrl);
    }
  }, [searchParams, users]);

  // 当查询范围变化时，加载可用日期列表
  useEffect(() => {
    if (scope === "person") {
      if (!userId) {
        setAvailableDateInfos([]);
        return;
      }
      fetchAvailableDates({ userId }, true).then((infos) => {
        setAvailableDateInfos(infos);
      });
    } else {
      fetchAvailableDates({ scope, node }, true).then((infos) => {
        setAvailableDateInfos(infos);
      });
    }
  }, [scope, node, userId]);

  // 单日模式下，根据当前 dateRange 和可用日期列表确定选中日期
  useEffect(() => {
    if (availableDateInfos.length === 0) {
      setSelectedDate(null);
      return;
    }
    if (dateRange[0] === dateRange[1]) {
      const currentDate = dateRange[0];
      const dateExists = availableDateInfos.some((info) => info.date === currentDate);
      const targetDate = dateExists ? currentDate : availableDateInfos[0].date;
      setSelectedDate(targetDate);
    } else {
      setSelectedDate(null);
    }
  }, [dateRange, availableDateInfos]);

  // 个人单日：选中用户或日期变化时自动加载当日数据
  useEffect(() => {
    if (scope !== "person" || !userId || !selectedDate) return;
    loadDataFor(userId, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, userId, selectedDate]);

  const loadDataFor = async (targetUserId: string, targetDate: string) => {
    try {
      const dateStr = targetDate;
      const start = `${dateStr}T00:00:00`;
      const end = `${dateStr}T23:59:59`;
      const [v, s, r, m, a] = await Promise.all([
        fetchVisits(targetUserId, start, end),
        fetchStops(targetUserId, start, end),
        fetchRoutes(targetUserId, start, end),
        fetchMileage(targetUserId, start, end),
        fetchAnomalies(targetUserId, start, end),
      ]);
      setVisits(v);
      setStops(s);
      setRoutes(r);
      setMileage(m);
      setAnomalies(a);
    } catch (err) {
      console.error("Failed to load console data:", err);
    }
  };

  const loadOverview = async (targetUserId: string, start: string, end: string) => {
    setOverviewLoading(true);
    try {
      const [overview, visitsRange] = await Promise.all([
        fetchUserOverview(targetUserId, start, end),
        fetchVisits(targetUserId, `${start}T00:00:00`, `${end}T23:59:59`),
      ]);
      setOverviewData(overview);
      setOverviewVisits(visitsRange);
    } catch (err) {
      console.error("Failed to load user overview:", err);
    } finally {
      setOverviewLoading(false);
    }
  };

  const loadOrgOverview = async (
    targetScope: "company" | "department" | "sub_department",
    targetNode: string,
    start: string,
    end: string
  ) => {
    setOrgOverviewLoading(true);
    try {
      const data = await fetchOrgOverview(targetScope, targetNode, start, end);
      setOrgOverviewData(data);
    } catch (err) {
      console.error("Failed to load org overview:", err);
      setOrgOverviewData(null);
    } finally {
      setOrgOverviewLoading(false);
    }
  };

  const handleExportConsoleReport = async () => {
    setExportLoading(true);
    try {
      const amapKey = import.meta.env.VITE_AMAP_KEY || "";
      let payloadPoints = heatMapPoints;

      if (scope !== "person") {
        if (!orgOverviewData) {
          Toast.error("暂无数据可导出");
          return;
        }
        payloadPoints = orgOverviewData.heatMapPoints.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          count: p.count,
        }));
      } else if (dateRange[0] === dateRange[1]) {
        // 个人单日：后端自行查询渲染，points 传空
        payloadPoints = [];
      }

      const result = await exportConsoleReport({
        scope,
        node: scope !== "person" ? node || "__ALL__" : undefined,
        userId: scope === "person" ? userId : undefined,
        start: dateRange[0],
        end: dateRange[1],
        amapKey,
        points: payloadPoints,
      });

      if (result.success) {
        Toast.success(result.message || "已发送到钉钉群");
      } else {
        Toast.error(result.message || "发送失败");
      }
    } catch (err: any) {
      console.error("导出到钉钉失败:", err);
      Toast.error(err?.response?.data?.error || err?.message || "导出失败");
    } finally {
      setExportLoading(false);
    }
  };

  const handleCascaderChange = (value: string[]) => {
    // 数据加载完成前忽略级联选择器的 onChange，避免空值触发回跳
    if (dataLoading) return;
    // 防止 Cascader 因 value prop 变化误触发 onChange 导致状态回跳
    if (JSON.stringify(value) === JSON.stringify(cascaderValue)) return;

    const { scope: newScope, node: newNode, userId: newUserId } = parseCascaderValue(value);
    setScope(newScope);
    setNode(newNode);
    setUserId(newUserId);

    if (newScope !== "person") {
      setVisits([]);
      setStops([]);
      setRoutes([]);
      setAnomalies([]);
      setMileage(null);
      setSelectedDate(null);
    }

    const params = new URLSearchParams(searchParams);
    params.set("scope", newScope);
    if (newNode) params.set("node", newNode);
    else params.delete("node");
    if (newUserId) params.set("user", newUserId);
    else params.delete("user");
    params.set("start", dateRange[0]);
    params.set("end", dateRange[1]);
    params.delete("date");
    setSearchParams(params);
  };

  const handleDateRangeChange = (dates: Date[] | null) => {
    if (!dates || !dates[0] || !dates[1]) return;
    const start = dayjs.tz(dates[0]).format("YYYY-MM-DD");
    const end = dayjs.tz(dates[1]).format("YYYY-MM-DD");
    setDateRange([start, end]);

    const params = new URLSearchParams(searchParams);
    params.set("start", start);
    params.set("end", end);
    params.delete("date");
    setSearchParams(params);

    if (scope === "person") {
      if (start === end) {
        setSelectedDate(start);
      } else {
        setSelectedDate(null);
      }
    }
  };

  // 个人周期：范围大于1天时加载周期总览
  useEffect(() => {
    if (scope !== "person" || !userId || dateRange[0] === dateRange[1]) return;
    loadOverview(userId, dateRange[0], dateRange[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, userId, dateRange]);

  // 非个人维度：任意日期范围都加载组织总览（用于导出）
  useEffect(() => {
    if (scope === "person") {
      setOrgOverviewData(null);
      return;
    }
    const nodeName = scope === "company" ? "__ALL__" : node || "__ALL__";
    loadOrgOverview(scope, nodeName, dateRange[0], dateRange[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, node, dateRange]);

  // 按 approval_id 分组，支持按审批单切换轨迹视图
  const approvalGroups = useMemo<ApprovalGroup[]>(() => {
    const groups = new Map<string, ApprovalGroup>();
    const allKey = "__ALL__";
    const allRoutesTotalKm = routes.reduce((sum, r) => sum + r.distance_km, 0);
    groups.set(allKey, {
      key: allKey,
      label: "全天总览",
      visits,
      routes,
      stops,
      anomalies,
      mileage: mileage ?? {
        user_id: userId || "",
        totalKm: parseFloat(allRoutesTotalKm.toFixed(2)),
        reportedDistanceKm: 0,
        segmentCount: routes.length,
        estimatedFuelCost: parseFloat((allRoutesTotalKm * 0.8).toFixed(2)),
      },
    });

    const byApproval = new Map<string, Visit[]>();
    for (const v of visits) {
      const key = v.approval_id || "__NO_APPROVAL__";
      if (!byApproval.has(key)) byApproval.set(key, []);
      byApproval.get(key)!.push(v);
    }

    for (const [key, groupVisits] of byApproval) {
      const groupVisitIds = new Set(groupVisits.map((v) => v.id));
      const groupRoutes = routes.filter(
        (r) => groupVisitIds.has(r.from_visit_id) && groupVisitIds.has(r.to_visit_id)
      );
      const groupStops = stops.filter((s) =>
        s.visit_ids.some((id) => groupVisitIds.has(id))
      );
      const groupAnomalies = anomalies.filter((a) =>
        a.related_visit_ids.some((id) => groupVisitIds.has(id))
      );
      const reportedValues = groupVisits
        .map((v) => v.reported_distance_km)
        .filter((d): d is number => d != null && d > 0 && d <= MAX_MILEAGE_KM);
      const reportedDistanceKm = reportedValues.length > 0 ? Math.max(...reportedValues) : 0;
      const totalKm = groupRoutes.reduce((sum, r) => sum + r.distance_km, 0);

      groups.set(key, {
        key,
        label: key === "__NO_APPROVAL__" ? "未关联审批" : `审批 ${key.slice(-8)}`,
        visits: groupVisits,
        routes: groupRoutes,
        stops: groupStops,
        anomalies: groupAnomalies,
        mileage: {
          user_id: userId || "",
          totalKm: parseFloat(totalKm.toFixed(2)),
          reportedDistanceKm: parseFloat(reportedDistanceKm.toFixed(2)),
          segmentCount: groupRoutes.length,
          estimatedFuelCost: parseFloat((totalKm * 0.8).toFixed(2)),
        },
      });
    }

    return Array.from(groups.values());
  }, [visits, routes, stops, anomalies, mileage, userId]);

  const overviewGroup =
    approvalGroups.find((g) => g.key === "__ALL__") || approvalGroups[0];

  const routeGroups = useMemo(
    () =>
      approvalGroups
        .filter((g) => g.key !== "__ALL__")
        .map((g, idx) => ({
          ...g,
          color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
        })),
    [approvalGroups]
  );

  // 避免父组件无关 re-render 导致 MapContainer routeGroups 引用变化
  const mapRouteGroups = useMemo(
    () =>
      routeGroups.map((g) => ({
        key: g.key,
        label: g.label,
        color: g.color,
        routes: g.routes,
        visits: g.visits,
      })),
    [routeGroups]
  );

  // 数据变化时重置各轨迹播放进度
  useEffect(() => {
    setRouteProgressMap({});
    setPlayingRoutes(new Set());
  }, [visits]);

  // 周期总览：按坐标聚合拜访热度
  const heatMapPoints = useMemo(() => {
    const pointMap = new Map<string, { lat: number; lng: number; count: number }>();
    for (const v of overviewVisits) {
      if (v.lat == null || v.lng == null) continue;
      const key = `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;
      if (!pointMap.has(key)) {
        pointMap.set(key, { lat: v.lat, lng: v.lng, count: 0 });
      }
      pointMap.get(key)!.count += 1;
    }
    return Array.from(pointMap.values());
  }, [overviewVisits]);

  const routeProgressRef = useRef<Record<string, number>>({});
  routeProgressRef.current = routeProgressMap;

  useEffect(() => {
    if (playingRoutes.size === 0) return;

    let startTime: number | null = null;
    const startProgressMap = new Map<string, number>();
    for (const key of Array.from(playingRoutes)) {
      const current = routeProgressRef.current[key] ?? 1;
      startProgressMap.set(key, current >= 1 ? 0 : current);
    }

    let animationFrameId: number;

    const animate = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      let stillPlaying = false;
      const next: Record<string, number> = {};

      for (const key of Array.from(playingRoutes)) {
        const startProgress = startProgressMap.get(key) ?? 0;
        const newProgress = Math.min(1, startProgress + elapsed / 10000);
        next[key] = newProgress;
        if (newProgress < 1) stillPlaying = true;
      }

      setRouteProgressMap((prev) => ({ ...prev, ...next }));

      if (stillPlaying) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        setPlayingRoutes(new Set());
      }
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameId);
  }, [playingRoutes]);

  const handleSelectDate = (dateStr: string) => {
    if (!availableDateInfos.some((i) => i.date === dateStr)) return;
    setSelectedDate(dateStr);
    setDateRange([dateStr, dateStr]);
    const params = new URLSearchParams(searchParams);
    params.set("start", dateStr);
    params.set("end", dateStr);
    params.delete("date");
    setSearchParams(params);
  };

  const toggleRoutePlaying = (key: string) => {
    setPlayingRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if ((routeProgressMap[key] ?? 0) >= 1) {
          setRouteProgressMap((p) => ({ ...p, [key]: 0 }));
        }
      }
      return next;
    });
  };

  const resetAllRoutes = () => {
    const keys = routeGroups.map((g) => g.key);
    const reset: Record<string, number> = {};
    keys.forEach((k) => (reset[k] = 0));
    setRouteProgressMap(reset);
    setPlayingRoutes(new Set(keys));
  };

  return (
    <div>
      {/* 顶部查询区 */}
      <div style={{ paddingBottom: 12 }}>
        <Row type="flex" gutter={16} align="middle" style={{ marginBottom: 16 }}>
          <Col style={{ flex: "0 0 auto" }}>
            <Cascader
              style={{ width: 320 }}
              dropdownClassName="console-scope-cascader"
              placeholder={dataLoading ? "加载中..." : "选择查询范围"}
              value={cascaderValue}
              treeData={cascaderData}
              onChange={(value) => handleCascaderChange(value as string[])}
              changeOnSelect
              showNext="hover"
              disabled={dataLoading}
              displayRender={(selected) =>
                Array.isArray(selected) ? selected.join(" / ") : ""
              }
            />
          </Col>
          <Col style={{ flex: "0 0 auto" }}>
            <DatePicker
              type="dateRange"
              value={[dayjs.tz(dateRange[0]).toDate(), dayjs.tz(dateRange[1]).toDate()]}
              onChange={(dates) => handleDateRangeChange(dates as Date[] | null)}
              disabledDate={(current) =>
                !!current && dayjs.tz(current).isAfter(dayjs.tz(), "day")
              }
            />
          </Col>
          <Col
            style={{
              flex: "1",
              minWidth: 0,
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
            }}
          >
            {(overviewLoading || orgOverviewLoading) && (
              <span style={{ color: "#999", marginRight: 12 }}>加载中...</span>
            )}
            {(scope === "person" ? userId : true) && (
              <button
                onClick={handleExportConsoleReport}
                disabled={
                  exportLoading ||
                  (scope === "person" && dateRange[0] !== dateRange[1] && !overviewData) ||
                  (scope !== "person" && (!orgOverviewData || orgOverviewLoading))
                }
                style={{
                  padding: "8px 16px",
                  backgroundColor:
                    exportLoading ||
                    (scope === "person" && dateRange[0] !== dateRange[1] && !overviewData) ||
                    (scope !== "person" && (!orgOverviewData || orgOverviewLoading))
                      ? "#e0e0e0"
                      : "#f0f0f0",
                  color: "#333",
                  border: "none",
                  borderRadius: 9999,
                  cursor:
                    exportLoading ||
                    (scope === "person" && dateRange[0] !== dateRange[1] && !overviewData) ||
                    (scope !== "person" && (!orgOverviewData || orgOverviewLoading))
                      ? "not-allowed"
                      : "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                {exportLoading ? "发送中..." : "导出并发送到钉钉"}
              </button>
            )}
          </Col>
        </Row>

        {dateRange[0] === dateRange[1] && (
          <Row type="flex" gutter={16} align="middle">
            <Col span={24}>
              <DateAxis
                availableDateInfos={availableDateInfos}
                selectedDate={selectedDate}
                onSelectDate={handleSelectDate}
                emptyText={scope === "person" ? "该员工暂无数据" : "该范围暂无数据"}
              />
            </Col>
          </Row>
        )}
      </div>

      {scope !== "person" && (
        <OrgQueryPanel
          key={`${scope}-${node || "__ALL__"}-${dateRange[0]}-${dateRange[1]}`}
          scope={scope}
          nodeName={node || ""}
          start={dateRange[0]}
          end={dateRange[1]}
        />
      )}

      {scope === "person" && dateRange[0] === dateRange[1] && selectedDate && (
        <>
          {/* 统计卡片 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>拜访点数</span>
                <span style={statValueStyle}>{overviewGroup.visits.length}</span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                  }}
                >
                  <span style={statLabelStyle}>总里程 vs 估算里程</span>
                  {hasMileageReadingInvalid(overviewGroup.anomalies) && (
                    <Popover
                      content={
                        <MileageAnomalyPopover
                          anomalies={overviewGroup.anomalies}
                          userName={
                            users.find((u) => u.user_id === userId)?.user_name ||
                            userId ||
                            ""
                          }
                          approvalGroups={approvalGroups}
                        />
                      }
                      position="topRight"
                    >
                      <Tag color="orange" style={{ marginLeft: 8, cursor: "pointer" }}>
                        填报异常
                      </Tag>
                    </Popover>
                  )}
                </div>
                <span style={statValueStyle}>
                  {overviewGroup.mileage.reportedDistanceKm === 0 &&
                  overviewGroup.mileage.totalKm === 0 ? (
                    <span style={{ color: "#999", fontSize: 16 }}>公共交通/无驾车</span>
                  ) : (
                    <>
                      <span
                        style={{
                          color: hasMileageReadingInvalid(overviewGroup.anomalies)
                            ? "#fa8c16"
                            : overviewGroup.mileage.reportedDistanceKm
                            ? "#0f1419"
                            : "#999",
                        }}
                      >
                        {overviewGroup.mileage.reportedDistanceKm || "未填报"}
                      </span>
                      <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>vs</span>
                      <span>{Math.round(overviewGroup.mileage.totalKm)}</span>
                    </>
                  )}
                </span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>Segment 数</span>
                <span style={statValueStyle}>{overviewGroup.mileage.segmentCount}</span>
              </div>
            </Col>
            <Col span={6}>
              <div style={statStyle}>
                <span style={statLabelStyle}>估算油费 (元)</span>
                <span style={statValueStyle}>
                  {overviewGroup.mileage.estimatedFuelCost === 0 &&
                  overviewGroup.mileage.totalKm === 0 ? (
                    <span style={{ color: "#999" }}>-</span>
                  ) : (
                    overviewGroup.mileage.estimatedFuelCost
                  )}
                </span>
              </div>
            </Col>
          </Row>

          {/* Anomalies + Map */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <div
                style={{
                  padding: 20,
                  backgroundColor: "#fff",
                  borderRadius: 16,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  maxHeight: 500,
                  overflow: "hidden",
                }}
              >
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  {/* 轨迹内容 */}
                  <div style={{ marginBottom: 40 }}>
                    <div
                      onClick={() => setTrajectoryExpanded(!trajectoryExpanded)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                        marginBottom: trajectoryExpanded ? 12 : 0,
                        userSelect: "none",
                      }}
                    >
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#0f1419" }}>
                        轨迹内容
                      </span>
                      {trajectoryExpanded ? (
                        <IconChevronDown style={{ color: "#72808a" }} />
                      ) : (
                        <IconChevronRight style={{ color: "#72808a" }} />
                      )}
                    </div>
                    {trajectoryExpanded && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                        {routeGroups.length > 1 ? (
                          routeGroups.map((g) => (
                            <div key={g.key}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  marginBottom: 12,
                                }}
                              >
                                <span
                                  style={{
                                    width: 10,
                                    height: 10,
                                    borderRadius: "50%",
                                    backgroundColor: g.color,
                                  }}
                                />
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: "#0f1419",
                                  }}
                                >
                                  {g.label}
                                </span>
                              </div>
                              <TrajectoryTimeline
                                visits={g.visits}
                                routes={g.routes}
                                anomalies={g.anomalies}
                              />
                            </div>
                          ))
                        ) : (
                          <TrajectoryTimeline
                            visits={overviewGroup.visits}
                            routes={overviewGroup.routes}
                            anomalies={overviewGroup.anomalies}
                          />
                        )}
                      </div>
                    )}
                  </div>

                  {/* 异常事件 */}
                  <div>
                    <div
                      onClick={() => setAnomalyExpanded(!anomalyExpanded)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                        marginBottom: anomalyExpanded ? 12 : 0,
                        userSelect: "none",
                      }}
                    >
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#0f1419" }}>
                        异常事件
                        {overviewGroup.anomalies.length > 0 && (
                          <span style={{ fontSize: 13, color: "#F54C5C", marginLeft: 8 }}>
                            {overviewGroup.anomalies.length}
                          </span>
                        )}
                      </span>
                      {anomalyExpanded ? (
                        <IconChevronDown style={{ color: "#72808a" }} />
                      ) : (
                        <IconChevronRight style={{ color: "#72808a" }} />
                      )}
                    </div>
                    {anomalyExpanded && (
                      <>
                        {overviewGroup.anomalies.length === 0 ? (
                          <div style={{ color: "#999", fontSize: 14 }}>暂无异常</div>
                        ) : (
                          <List
                            size="small"
                            dataSource={overviewGroup.anomalies}
                            split={false}
                            renderItem={(item) => (
                            <List.Item style={{ padding: "12px 0", borderBottom: "1px solid #f0f0f0" }}>
                              <AnomalyItem item={item} />
                            </List.Item>
                          )}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </Col>
            <Col span={16}>
              <div
                style={{
                  padding: 20,
                  backgroundColor: "#fff",
                  borderRadius: 16,
                  height: "500px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 600, color: "#0f1419", marginBottom: 12 }}>
                  轨迹地图
                </div>
                <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                  <MapContainer
                    routeGroups={mapRouteGroups}
                    stops={overviewGroup.stops}
                    anomalies={overviewGroup.anomalies}
                    progressMap={routeProgressMap}
                  />
                  {routeGroups.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        left: 12,
                        zIndex: 10,
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        backgroundColor: "rgba(255, 255, 255, 0.92)",
                        padding: "6px 12px",
                        borderRadius: 20,
                        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
                      }}
                    >
                      {routeGroups.map((g) => {
                        const isPlaying = playingRoutes.has(g.key);
                        return (
                          <button
                            key={g.key}
                            onClick={() => toggleRoutePlaying(g.key)}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              fontSize: 18,
                              color: g.color,
                              display: "flex",
                              alignItems: "center",
                              padding: 0,
                            }}
                            title={`${g.label} ${isPlaying ? "暂停" : "播放"}`}
                          >
                            {isPlaying ? <IconPause /> : <IconPlayCircle />}
                          </button>
                        );
                      })}
                      <button
                        onClick={resetAllRoutes}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 16,
                          color: "#0f1419",
                          display: "flex",
                          alignItems: "center",
                          padding: 0,
                        }}
                        title="全部重放"
                      >
                        <IconRedo />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </Col>
          </Row>
        </>
      )}

      {scope === "person" && dateRange[0] !== dateRange[1] && userId && (
        <OverviewPanel
          userId={userId}
          users={users}
          range={dateRange}
          data={overviewData}
          heatMapPoints={heatMapPoints}
        />
      )}
    </div>
  );
}

interface OverviewPanelProps {
  userId: string;
  users: User[];
  range: [string, string];
  data: UserOverviewResult | null;
  heatMapPoints: { lat: number; lng: number; count: number }[];
}

function OverviewPanel({
  userId,
  users,
  range,
  data,
  heatMapPoints,
}: OverviewPanelProps) {
  const filled = useMemo(
    () => fillDailyRange(data?.daily ?? [], range[0], range[1]),
    [data, range]
  );
  // 估算里程只显示整数，填报里程保持原精度
  const chartData = useMemo(
    () =>
      filled.map((d) => ({
        ...d,
        estimated_distance_km: Math.round(d.estimated_distance_km),
      })),
    [filled]
  );
  const totals = data?.totals;

  const dayCount = useMemo(() => {
    const s = dayjs.tz(range[0]);
    const e = dayjs.tz(range[1]);
    return e.diff(s, "day") + 1;
  }, [range]);

  const visitFrequency = useMemo(() => {
    if (!totals || dayCount <= 0) return 0;
    return (totals.visit_count / dayCount).toFixed(2);
  }, [totals, dayCount]);

  const estimatedFuelCost = useMemo(() => {
    const km = totals?.estimated_distance_km ?? 0;
    return (km * 0.8).toFixed(2);
  }, [totals]);

  const userName = useMemo(
    () => users.find((u) => u.user_id === userId)?.user_name || userId,
    [users, userId]
  );

  return (
    <div>
      {!data ? (
        <div style={{ color: "#999" }}>选择时间范围加载数据</div>
      ) : (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <div style={statStyle}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                  }}
                >
                  <span style={statLabelStyle}>填报 / 估算里程</span>
                  {hasMileageReadingInvalid(data?.anomalies ?? []) && (
                    <Popover
                      content={
                        <MileageAnomalyPopover
                          anomalies={data?.anomalies ?? []}
                          userName={userName}
                        />
                      }
                      position="topRight"
                    >
                      <Tag color="orange" style={{ marginLeft: 8, cursor: "pointer" }}>
                        填报异常
                      </Tag>
                    </Popover>
                  )}
                </div>
                <span style={statValueStyle}>
                  <span
                    style={{
                      color: hasMileageReadingInvalid(data?.anomalies ?? [])
                        ? "#fa8c16"
                        : "#0f1419",
                    }}
                  >
                    {totals?.reported_distance_km ?? 0}
                  </span>
                  <span style={{ fontSize: 14, color: "#999", margin: "0 4px" }}>/</span>
                  <span>{Math.round(totals?.estimated_distance_km ?? 0)}</span>
                  <span style={{ fontSize: 12, color: "#999" }}>km</span>
                </span>
              </div>
            </Col>
            <Col span={8}>
              <div style={statStyle}>
                <span style={statLabelStyle}>预估油费</span>
                <span style={statValueStyle}>
                  {estimatedFuelCost}
                  <span style={{ fontSize: 12, color: "#999" }}>元</span>
                </span>
              </div>
            </Col>
            <Col span={8}>
              <div style={statStyle}>
                <span style={statLabelStyle}>拜访频率</span>
                <span style={statValueStyle}>
                  {visitFrequency}
                  <span style={{ fontSize: 12, color: "#999" }}>次/天</span>
                </span>
              </div>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={24}>
              <div style={{ padding: 20, backgroundColor: "#fff", borderRadius: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                  每日趋势
                </div>
                <MileageAnomalyAlert
                  anomalies={data?.anomalies ?? []}
                  userName={userName}
                />
                <Suspense fallback={<div style={{ height: 320 }}>加载图表中...</div>}>
                  <OverviewChart
                    data={chartData}
                    anomalies={data?.anomalies ?? []}
                    onDateClick={(date) => {
                      window.open(`/console?user=${userId}&date=${date}`, "_blank");
                    }}
                  />
                </Suspense>
              </div>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={24}>
              <div
                style={{
                  padding: 20,
                  backgroundColor: "#fff",
                  borderRadius: 16,
                  height: 460,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                  拜访热度（{userName}）
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <HeatMapContainer points={heatMapPoints} />
                </div>
              </div>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

function hasMileageReadingInvalid(
  anomalies: Array<{ type: string }>
): boolean {
  return anomalies.some((a) => a.type === "mileage_reading_invalid");
}

function MileageAnomalyAlert({
  anomalies,
  userName,
}: {
  anomalies: Array<{
    id: number;
    type: string;
    anomaly_date?: string;
    metadata?: Record<string, any>;
  }>;
  userName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const invalidAnomalies = anomalies.filter(
    (a) => a.type === "mileage_reading_invalid"
  );
  if (invalidAnomalies.length === 0) return null;

  // 按北京时间聚合异常日期，并去重排序
  const dateSet = new Set<string>();
  invalidAnomalies.forEach((a) => {
    if (a.anomaly_date) {
      dateSet.add(
        dayjs(a.anomaly_date).tz("Asia/Shanghai").format("YYYY-MM-DD")
      );
    }
  });
  const dates = Array.from(dateSet).sort();

  // 收起时只展示标题；展开后才展示人员+日期+描述明细
  const visibleAnomalies = expanded ? invalidAnomalies : [];

  const displayedDates = dates.slice(0, 3);
  const hasMore = dates.length > 3;
  const remaining = dates.length - 3;

  return (
    <div
      style={{
        marginBottom: 16,
        padding: 16,
        backgroundColor: "#fffbe6",
        border: "1px solid #ffe58f",
        borderRadius: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        fontSize: 14,
      }}
    >
      <IconAlertTriangle
        style={{
          width: 14,
          height: 14,
          color: "#faad14",
          flexShrink: 0,
          marginTop: 2,
        }}
      />
      <div style={{ flex: 1, textAlign: "left" }}>
        <div
          style={{
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span>异常日期：</span>
          <span>{displayedDates.join("、")}</span>
          {hasMore && (
            <Tag
              size="small"
              style={{
                backgroundColor: "#f0f0f0",
                color: "#666",
                border: "none",
                borderRadius: 4,
              }}
            >
              +{remaining}
            </Tag>
          )}
        </div>
        {visibleAnomalies.map((a, idx) => {
          const approvalId = a.metadata?.approval_id as string | undefined;
          const issues = (a.metadata?.issues as any[]) ?? [];
          const isLast = idx === visibleAnomalies.length - 1;
          return (
            <div key={a.id} style={{ marginTop: 8, marginBottom: isLast ? 0 : 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  {userName} ·{" "}
                  {a.anomaly_date
                    ? dayjs(a.anomaly_date).tz("Asia/Shanghai").format("YYYY-MM-DD")
                    : ""}
                </span>
                <Tag
                  size="small"
                  style={{
                    backgroundColor: "#f0f0f0",
                    color: "#666",
                    border: "none",
                    borderRadius: 4,
                  }}
                >
                  {approvalId ? approvalId.slice(-8) : "未知"}
                </Tag>
              </div>
              <div style={{ color: "#666" }}>
                {issues.map((issue, idx) => (
                  <div key={idx}>• {issue.description}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {invalidAnomalies.length > 1 && (
        <div
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            width: 20,
            height: 20,
            marginTop: 2,
          }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <IconChevronUp style={{ width: 20, height: 20, color: "#999" }} />
          ) : (
            <IconChevronDown
              style={{ width: 20, height: 20, color: "#1f2329" }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface MileageAnomalyPopoverProps {
  anomalies: Array<{
    id: number;
    type: string;
    description: string;
    anomaly_date?: string;
    metadata?: Record<string, any>;
  }>;
  userName: string;
  approvalGroups?: ApprovalGroup[];
}

function MileageAnomalyPopover({
  anomalies,
  userName,
  approvalGroups,
}: MileageAnomalyPopoverProps) {
  const invalidAnomalies = anomalies.filter(
    (a) => a.type === "mileage_reading_invalid"
  );
  if (invalidAnomalies.length === 0) return null;

  return (
    <div style={{ maxWidth: 360, padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
        填报异常
      </div>
      {invalidAnomalies.map((a) => {
        const approvalId = a.metadata?.approval_id as string | undefined;
        const estimatedKm =
          approvalId && approvalGroups
            ? approvalGroups.find((g) => g.key === approvalId)?.mileage.totalKm
            : undefined;

        return (
          <div key={a.id} style={{ marginBottom: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {userName} ·{" "}
                {a.anomaly_date
                  ? dayjs(a.anomaly_date).tz("Asia/Shanghai").format("YYYY-MM-DD")
                  : ""}
              </span>
              <Tag
                size="small"
                style={{
                  backgroundColor: "#f0f0f0",
                  color: "#666",
                  border: "none",
                  borderRadius: 4,
                }}
              >
                {approvalId ? approvalId.slice(-8) : "未知"}
              </Tag>
            </div>
            <div style={{ fontSize: 12, color: "#666", lineHeight: 1.6 }}>
              {(a.metadata?.issues as any[])?.map((issue, idx) => (
                <div key={idx}>• {issue.description}</div>
              ))}
            </div>
            {estimatedKm != null && estimatedKm > 0 && (
              <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
                该审批单估算里程：{Math.round(estimatedKm)} km
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ConsolePage;
