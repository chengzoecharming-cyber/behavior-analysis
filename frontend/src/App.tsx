import { useEffect, useState } from "react";
import {
  Routes,
  Route,
  Link,
  useLocation,
  Navigate,
  useNavigate,
} from "react-router-dom";
import {
  Home,
  Upload,
  Bell,
  User,
  Menu,
  MapPin,
  Settings,
  RefreshCw,
  MessageSquareText,
  Users,
  LogOut,
} from "lucide-react";
import DecisionPage from "./pages/DecisionPage";
import ConsolePage from "./pages/ConsolePage";
import UploadPage from "./pages/UploadPage";
import RulesConfigPage from "./pages/RulesConfigPage";
import DataSyncPage from "./pages/DataSyncPage";
import FeedbackPage from "./pages/FeedbackPage";
import LoginPage from "./pages/LoginPage";
import { fetchCurrentUser, fetchAuthUsers, AuthUser } from "./api";
import { Dropdown } from "@douyinfe/semi-ui";

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { path: "/", label: "决策系统", icon: Home },
  { path: "/console", label: "控制台", icon: MapPin },
  { path: "/upload", label: "数据上传", icon: Upload },
  { path: "/sync", label: "数据同步", icon: RefreshCw },
  { path: "/rules", label: "规则配置", icon: Settings },
];

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    loadCurrentUser();
  }, []);

  const loadCurrentUser = async () => {
    const userId = localStorage.getItem("user_id");
    if (!userId) {
      setChecking(false);
      setCurrentUser(null);
      return;
    }
    try {
      const user = await fetchCurrentUser();
      setCurrentUser(user);
    } catch (err: any) {
      console.warn("Fetch current user failed:", err);
      localStorage.removeItem("user_id");
      setCurrentUser(null);
    } finally {
      setChecking(false);
    }
  };

  const openSwitcher = async () => {
    try {
      const list = await fetchAuthUsers();
      setUsers(list);
    } catch {
      setUsers([]);
    }
    setSwitcherOpen(true);
  };

  const switchUser = (userId: string) => {
    localStorage.setItem("user_id", userId);
    setSwitcherOpen(false);
    window.location.reload();
  };

  const logout = () => {
    localStorage.removeItem("user_id");
    navigate("/login", { replace: true });
    window.location.reload();
  };

  if (checking) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#F6F8FC]">
        <div className="text-sm text-[#72808a]">正在检查登录状态...</div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage />;
  }

  const roleText: Record<string, string> = {
    admin: "管理员",
    manager: "主管",
    staff: "员工",
  };

  const currentUserLabel = (() => {
    if (!currentUser) return "未登录";
    const role = roleText[currentUser.role];
    if (currentUser.role === "staff" || !role) return currentUser.user_name;
    return `${currentUser.user_name} - ${role}`;
  })();

  const itemStyle = { height: 48, lineHeight: "48px", paddingTop: 0, paddingBottom: 0 };

  return (
    <div
      className="flex flex-col min-h-screen"
      style={{ backgroundColor: "#F6F8FC" }}
    >
      {/* Header */}
      <header className="sticky top-0 z-20 h-16 shrink-0 border-b border-stone-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-5 px-6">
          {/* Left: Logo + Nav */}
          <div className="flex min-w-0 items-center">
            <Link
              to="/"
              className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-[#0f1419] transition hover:text-stone-600"
            >
              <img
                src="/logo.png"
                alt="销售外勤行为决策系统"
                className="h-8 w-8 shrink-0 rounded-lg object-contain"
              />
              <span className="text-base font-medium">销售外勤行为决策系统</span>
            </Link>

            {/* Mobile menu button */}
            <button
              type="button"
              className="ml-3 inline-flex size-8 shrink-0 items-center justify-center border-none bg-transparent text-[#536471] transition-colors hover:text-[#0f1419] active:text-[#0f1419] md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开导航菜单"
              title="导航菜单"
            >
              <Menu className="size-5" />
            </button>

            {/* Desktop Nav */}
            <nav className="ml-8 hidden h-16 min-w-0 items-center gap-7 overflow-x-auto md:flex">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      "flex h-16 shrink-0 items-center gap-2 text-sm leading-6 transition",
                      active
                        ? "font-medium text-[#0f1419]"
                        : "text-stone-500 hover:text-[#0f1419]"
                    )}
                  >
                    <Icon className="size-4" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Right: Actions */}
          <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 whitespace-nowrap">
            <div className="flex items-center gap-2">
              <button
                className="relative flex h-8 w-8 items-center justify-center rounded-full border-none bg-transparent text-[#536471] transition-colors hover:text-[#0f1419] active:text-[#0f1419]"
                title="消息通知"
              >
                <Bell className="h-4 w-4" />
              </button>

              <Dropdown
                trigger="click"
                position="bottomRight"
                render={
                  <Dropdown.Menu>
                    <Dropdown.Item
                      disabled
                      style={itemStyle}
                    >
                      <span className="text-sm font-medium text-[#0f1419]">
                        {currentUserLabel}
                      </span>
                    </Dropdown.Item>
                    <Dropdown.Divider />
                    <Dropdown.Item
                      icon={<Users className="h-4 w-4" />}
                      onClick={openSwitcher}
                      style={itemStyle}
                    >
                      切换用户
                    </Dropdown.Item>
                    <Dropdown.Item
                      icon={<MessageSquareText className="h-4 w-4" />}
                      style={itemStyle}
                    >
                      <Link to="/feedback">反馈与申诉</Link>
                    </Dropdown.Item>
                    <Dropdown.Divider />
                    <Dropdown.Item
                      icon={<LogOut className="h-4 w-4" />}
                      type="danger"
                      onClick={logout}
                      style={itemStyle}
                    >
                      退出登录
                    </Dropdown.Item>
                  </Dropdown.Menu>
                }
              >
                <button
                  className="relative flex h-8 w-8 items-center justify-center rounded-full border-none bg-transparent text-[#536471] transition-colors hover:text-[#0f1419] active:text-[#0f1419]"
                  title="用户"
                >
                  <User className="h-4 w-4" />
                </button>
              </Dropdown>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Nav Drawer */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <div
            className="absolute left-0 top-0 h-full w-64 bg-white p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2 text-lg font-semibold text-[#0f1419]">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0f1419]">
                <MapPin className="h-4 w-4 text-white" />
              </div>
              销售外勤行为决策系统
            </div>
            <nav className="flex flex-col gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileNavOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
                      active
                        ? "bg-[rgb(235,236,237)] font-medium text-[#0f1419]"
                        : "text-stone-600 hover:bg-stone-50"
                    )}
                  >
                    <Icon className="size-4" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* User Switcher Modal */}
      {switcherOpen && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24"
          onClick={() => setSwitcherOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-base font-semibold text-[#0f1419]">
              切换用户
            </h3>
            <div className="max-h-80 overflow-y-auto">
              {users.length === 0 ? (
                <div className="py-4 text-center text-sm text-stone-500">
                  暂无用户
                </div>
              ) : (
                <div className="flex flex-col">
                  {users.map((u) => (
                    <button
                      key={u.user_id}
                      type="button"
                      className={cn(
                        "flex w-full cursor-pointer items-center justify-between border-none px-3 py-2.5 text-sm transition",
                        currentUser?.user_id === u.user_id
                          ? "bg-stone-100 font-medium text-[#0f1419]"
                          : "bg-transparent text-stone-700 hover:bg-stone-50"
                      )}
                      onClick={() => switchUser(u.user_id)}
                    >
                      <span>
                        {u.user_name}{" "}
                        <span className="text-xs text-stone-500">
                          ({roleText[u.role] || u.role})
                        </span>
                      </span>
                      {currentUser?.user_id === u.user_id && (
                        <span className="text-xs text-stone-500">当前</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-100"
                onClick={() => setSwitcherOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="flex-1 min-h-0" style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<DecisionPage />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/console" element={<ConsolePage />} />
          <Route path="/map" element={<Navigate to="/" replace />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/sync" element={<DataSyncPage />} />
          <Route path="/rules" element={<RulesConfigPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
