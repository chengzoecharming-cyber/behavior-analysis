import { useEffect, useMemo, useState, ReactNode, ComponentType } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Home,
  Bell,
  User,
  Menu,
  MapPin,
  Settings,
  RefreshCw,
  MessageSquareText,
  Users,
  Building2,
  LogOut,
  History,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Dropdown, Tooltip } from "@douyinfe/semi-ui";
import { AuthUser } from "../../api";
import { useIsMobile } from "../../hooks/useIsMobile";

type Role = "admin" | "manager" | "staff";

export interface NavItem {
  path: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 可见角色；缺省表示所有登录角色 */
  roles?: Role[];
}

/** 主导航：按产品 IA 排列 */
const MAIN_NAV_ITEMS: NavItem[] = [
  { path: "/", label: "总览", icon: Home },
  { path: "/console", label: "外勤分析", icon: MapPin },
  { path: "/customer-analysis", label: "客户分析", icon: Users },
  { path: "/customers", label: "客户库", icon: Building2, roles: ["admin"] },
];

/** 系统管理分组（低权重，导航区底部） */
const SYSTEM_NAV_ITEMS: NavItem[] = [
  { path: "/sync", label: "数据同步", icon: RefreshCw, roles: ["admin"] },
  { path: "/rules", label: "规则配置", icon: Settings, roles: ["admin"] },
];

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

function readInitialCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    // localStorage 不可用时退回默认
  }
  // 默认策略：桌面 ≥1280px 展开，768-1279px 折叠为图标栏（<768 走抽屉，不读这个值）
  return window.innerWidth < 1280;
}

function filterNav(items: NavItem[], role: Role): NavItem[] {
  return items.filter((item) => !item.roles || item.roles.includes(role));
}

interface SidebarContentProps {
  collapsed: boolean;
  mainItems: NavItem[];
  systemItems: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}

function SidebarContent({
  collapsed,
  mainItems,
  systemItems,
  pathname,
  onNavigate,
  onToggleCollapse,
}: SidebarContentProps) {
  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active =
      item.path === "/"
        ? pathname === "/"
        : pathname === item.path || pathname.startsWith(item.path + "/");
    const link = (
      <Link
        key={item.path}
        to={item.path}
        onClick={onNavigate}
        className={`sidebar-item${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        title={collapsed ? undefined : item.label}
      >
        <span className="sidebar-item-icon">
          <Icon className="size-[18px]" />
        </span>
        <span className="sidebar-item-label">{item.label}</span>
      </Link>
    );
    // 折叠态用 Tooltip 展示名称；Semi Tooltip 走 portal，不会被容器裁切
    return collapsed ? (
      <Tooltip key={item.path} content={item.label} position="right" spacing={8}>
        {link}
      </Tooltip>
    ) : (
      link
    );
  };

  return (
    <>
      {/* Brand */}
      <Link to="/" className="sidebar-brand" onClick={onNavigate}>
        <img
          src="/logo.png?v=2"
          alt="销售外勤分析系统"
          className="h-7 w-7 shrink-0 rounded-lg object-contain"
        />
        <span className="sidebar-brand-name">销售外勤分析系统</span>
      </Link>

      {/* 主导航 + 系统管理分组，导航区独立滚动 */}
      <div className="sidebar-nav">
        <nav className="sidebar-nav-group">{mainItems.map(renderItem)}</nav>
        <div className="sidebar-spacer" />
        {systemItems.length > 0 && (
          <>
            <div className="sidebar-group-title" aria-hidden={collapsed}>
              {collapsed ? "···" : "系统管理"}
            </div>
            <nav className="sidebar-nav-group">{systemItems.map(renderItem)}</nav>
          </>
        )}
      </div>

      {/* 底部收起/展开 */}
      {onToggleCollapse && (
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-item sidebar-toggle"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <span className="sidebar-item-icon">
              {collapsed ? (
                <PanelLeftOpen className="size-[18px]" />
              ) : (
                <PanelLeftClose className="size-[18px]" />
              )}
            </span>
            <span className="sidebar-item-label">收起</span>
          </button>
        </div>
      )}
    </>
  );
}

interface AppShellProps {
  currentUser: AuthUser;
  onLogout: () => void;
  children: ReactNode;
}

/**
 * 全局 App Shell：左侧可折叠 Sidebar + 右侧 Utility Header + Workspace。
 * Workspace 是唯一纵向滚动区，Sidebar 与 Header 固定。
 */
export default function AppShell({ currentUser, onLogout, children }: AppShellProps) {
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const role = (currentUser.role as Role) || "staff";
  const mainItems = useMemo(() => filterNav(MAIN_NAV_ITEMS, role), [role]);
  const systemItems = useMemo(() => filterNav(SYSTEM_NAV_ITEMS, role), [role]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 忽略持久化失败
      }
      return next;
    });
  };

  // 路由变化后关闭移动端抽屉
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape 关闭抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const roleText: Record<string, string> = {
    admin: "管理员",
    manager: "Leader",
    staff: "员工",
  };
  const currentUserLabel = (() => {
    const roleLabel = roleText[currentUser.role];
    if (currentUser.role === "staff" || !roleLabel) return currentUser.user_name;
    return `${currentUser.user_name} - ${roleLabel}`;
  })();

  const itemStyle = { height: 48, lineHeight: "48px", paddingTop: 0, paddingBottom: 0 };

  return (
    <div className="app-shell">
      {/* 桌面 Sidebar（<768px 隐藏，走抽屉） */}
      {!isMobile && (
        <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
          <SidebarContent
            collapsed={collapsed}
            mainItems={mainItems}
            systemItems={systemItems}
            pathname={location.pathname}
            onToggleCollapse={toggleCollapsed}
          />
        </aside>
      )}

      {/* 移动端 Drawer */}
      {isMobile && drawerOpen && (
        <div
          className="sidebar-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            className="sidebar sidebar-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarContent
              collapsed={false}
              mainItems={mainItems}
              systemItems={systemItems}
              pathname={location.pathname}
              onNavigate={() => setDrawerOpen(false)}
            />
            {/* 用户菜单入口：移动端在抽屉中按相同权限补充 */}
            <div className="sidebar-footer">
              {role === "admin" && (
                <Link
                  to="/sync-center"
                  className="sidebar-item"
                  onClick={() => setDrawerOpen(false)}
                >
                  <span className="sidebar-item-icon">
                    <History className="size-[18px]" />
                  </span>
                  <span className="sidebar-item-label">数据同步中心</span>
                </Link>
              )}
              {(role === "admin" || role === "manager") && (
                <Link
                  to="/users"
                  className="sidebar-item"
                  onClick={() => setDrawerOpen(false)}
                >
                  <span className="sidebar-item-icon">
                    <Users className="size-[18px]" />
                  </span>
                  <span className="sidebar-item-label">用户管理</span>
                </Link>
              )}
              <Link
                to="/feedback"
                className="sidebar-item"
                onClick={() => setDrawerOpen(false)}
              >
                <span className="sidebar-item-icon">
                  <MessageSquareText className="size-[18px]" />
                </span>
                <span className="sidebar-item-label">反馈与申诉</span>
              </Link>
              <button
                type="button"
                className="sidebar-item sidebar-logout"
                onClick={onLogout}
              >
                <span className="sidebar-item-icon">
                  <LogOut className="size-[18px]" />
                </span>
                <span className="sidebar-item-label">退出登录</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      <div className="app-main">
        <header className="utility-header">
          <div className="utility-header-left">
            {isMobile && (
              <button
                type="button"
                className="utility-icon-btn"
                onClick={() => setDrawerOpen(true)}
                aria-label="打开导航菜单"
              >
                <Menu className="size-5" />
              </button>
            )}
          </div>
          <div className="utility-header-right">
            <button
              type="button"
              className="utility-icon-btn"
              title="消息通知"
              aria-label="消息通知"
            >
              <Bell className="size-4" />
            </button>
            <Dropdown
              trigger="click"
              position="bottomRight"
              render={
                <Dropdown.Menu>
                  <Dropdown.Item disabled style={itemStyle}>
                    <span className="text-sm font-medium text-[#0f1419]">
                      {currentUserLabel}
                    </span>
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  {role === "admin" && (
                    <Dropdown.Item icon={<History className="h-4 w-4" />} style={itemStyle}>
                      <Link to="/sync-center">数据同步中心</Link>
                    </Dropdown.Item>
                  )}
                  {(role === "admin" || role === "manager") && (
                    <Dropdown.Item icon={<Users className="h-4 w-4" />} style={itemStyle}>
                      <Link to="/users">用户管理</Link>
                    </Dropdown.Item>
                  )}
                  <Dropdown.Item icon={<MessageSquareText className="h-4 w-4" />} style={itemStyle}>
                    <Link to="/feedback">反馈与申诉</Link>
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  <Dropdown.Item
                    icon={<LogOut className="h-4 w-4" />}
                    type="danger"
                    onClick={onLogout}
                    style={itemStyle}
                  >
                    退出登录
                  </Dropdown.Item>
                </Dropdown.Menu>
              }
            >
              <button type="button" className="utility-icon-btn" title="用户" aria-label="用户">
                <User className="h-4 w-4" />
              </button>
            </Dropdown>
          </div>
        </header>

        <main className="workspace">
          <div className="workspace-inner">{children}</div>
        </main>
      </div>
    </div>
  );
}
