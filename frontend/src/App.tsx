import { lazy, Suspense, useEffect, useState } from "react";
import {
  Routes,
  Route,
  useLocation,
  Navigate,
  useNavigate,
} from "react-router-dom";
// 页面级懒加载：按路由拆分 chunk，首屏只下载当前页面所需代码
const DecisionPage = lazy(() => import("./pages/DecisionPage"));
const ConsolePage = lazy(() => import("./pages/ConsolePage"));
const RulesConfigPage = lazy(() => import("./pages/RulesConfigPage"));
const DataSyncPage = lazy(() => import("./pages/DataSyncPage"));
const FeedbackPage = lazy(() => import("./pages/FeedbackPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const LoginCallbackPage = lazy(() => import("./pages/LoginCallbackPage"));
const SpecialReportPage = lazy(() => import("./pages/SpecialReportPage"));
const DataSyncCenterPage = lazy(() => import("./pages/DataSyncCenterPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const CustomerAnalysisPage = lazy(() => import("./pages/CustomerAnalysisPage"));
const CustomersPage = lazy(() => import("./pages/CustomersPage"));
const CustomerDetailPage = lazy(() => import("./pages/CustomerDetailPage"));
import { fetchCurrentUser, logoutApi, AuthUser } from "./api";
import AppShell from "./components/layout/AppShell";

// 懒加载页面切换时的占位
const pageFallback = (
  <div className="flex h-64 w-full items-center justify-center">
    <div className="text-sm text-[#72808a]">页面加载中...</div>
  </div>
);

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    loadCurrentUser();
  }, []);

  const loadCurrentUser = async () => {
    // 有 session token 或过渡期 user_id 才尝试拉取当前用户
    const hasLogin =
      localStorage.getItem("auth_token") || localStorage.getItem("user_id");
    if (!hasLogin) {
      setChecking(false);
      setCurrentUser(null);
      return;
    }
    try {
      const user = await fetchCurrentUser();
      setCurrentUser(user);
    } catch (err: any) {
      console.warn("Fetch current user failed:", err);
      localStorage.removeItem("auth_token");
      localStorage.removeItem("user_id");
      setCurrentUser(null);
    } finally {
      setChecking(false);
    }
  };

  const logout = async () => {
    try {
      await logoutApi();
    } catch {
      // 忽略，本地登录态照常清理
    }
    localStorage.removeItem("auth_token");
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
    // 未登录时只放行登录页和钉钉扫码回调页
    return (
      <Suspense fallback={pageFallback}>
        <Routes>
          <Route path="/login/callback" element={<LoginCallbackPage />} />
          {/* 盛夏战报 H5：免登录白名单，按 token 访问 */}
          <Route path="/report/:token" element={<SpecialReportPage />} />
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </Suspense>
    );
  }

  // 盛夏战报 H5：全屏独立页面，已登录访问也不渲染 App Shell
  if (location.pathname.startsWith("/report/")) {
    return (
      <Suspense fallback={pageFallback}>
        <Routes>
          <Route path="/report/:token" element={<SpecialReportPage />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <AppShell currentUser={currentUser} onLogout={logout}>
      <Suspense fallback={pageFallback}>
        <Routes>
          <Route path="/" element={<DecisionPage />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/console" element={<ConsolePage />} />
          <Route path="/map" element={<Navigate to="/" replace />} />
          <Route path="/upload" element={<Navigate to="/sync" replace />} />
          {/* 管理功能页面：非 admin 直访时跳回首页（导航入口已隐藏，这里是第二道守卫） */}
          <Route path="/sync" element={currentUser.role === "admin" ? <DataSyncPage /> : <Navigate to="/" replace />} />
          <Route path="/sync-center" element={currentUser.role === "admin" ? <DataSyncCenterPage /> : <Navigate to="/" replace />} />
          {/* 旧入口统一跳转到数据同步中心 */}
          <Route path="/sync-health" element={<Navigate to="/sync-center" replace />} />
          <Route path="/sync-logs" element={<Navigate to="/sync-center" replace />} />
          <Route path="/data-lineage" element={<Navigate to="/sync-center" replace />} />
          <Route path="/rules" element={currentUser.role === "admin" ? <RulesConfigPage /> : <Navigate to="/" replace />} />
          {/* 客户分析：所有登录角色可见，行级数据收敛由后端处理 */}
          <Route path="/customer-analysis" element={<CustomerAnalysisPage />} />
          {/* 客户库：第一版仅 admin（含联系人等敏感信息），非 admin 直访跳回首页 */}
          <Route path="/customers" element={currentUser.role === "admin" ? <CustomersPage /> : <Navigate to="/" replace />} />
          <Route path="/customers/:id" element={currentUser.role === "admin" ? <CustomerDetailPage /> : <Navigate to="/" replace />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export default App;
