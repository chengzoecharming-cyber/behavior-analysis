import { useState } from "react";
import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import {
  Home,
  BarChart3,
  Upload,
  Bell,
  User,
  Menu,
  MapPin,
  Settings,
} from "lucide-react";
import DecisionPage from "./pages/DecisionPage";
import Dashboard from "./pages/Dashboard";
import UploadPage from "./pages/UploadPage";
import RulesConfigPage from "./pages/RulesConfigPage";

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { path: "/", label: "决策系统", icon: Home },
  { path: "/dashboard", label: "控制台", icon: BarChart3 },
  { path: "/upload", label: "数据上传", icon: Upload },
  { path: "/rules", label: "规则配置", icon: Settings },
];

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function App() {
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex flex-col min-h-screen" style={{ backgroundColor: "#F6F8FC" }}>
      {/* Header */}
      <header className="sticky top-0 z-20 h-16 shrink-0 border-b border-stone-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-5 px-6">
          {/* Left: Logo + Nav */}
          <div className="flex min-w-0 items-center">
            <Link
              to="/"
              className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-[#0f1419] transition hover:text-stone-600"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0f1419]">
                <MapPin className="h-4 w-4 text-white" />
              </div>
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
              <button
                className="relative flex h-8 w-8 items-center justify-center rounded-full border-none bg-transparent text-[#536471] transition-colors hover:text-[#0f1419] active:text-[#0f1419]"
                title="用户"
              >
                <User className="h-4 w-4" />
              </button>
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

      {/* Content */}
      <main className="flex-1 min-h-0" style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<DecisionPage />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/map" element={<Navigate to="/dashboard" replace />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/rules" element={<RulesConfigPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
