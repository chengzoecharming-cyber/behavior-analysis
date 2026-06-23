import { Layout, Menu } from "antd";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import MapPage from "./pages/MapPage";
import UploadPage from "./pages/UploadPage";

const { Header, Content } = Layout;

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const items = [
    { key: "/", label: "控制台" },
    { key: "/map", label: "轨迹地图" },
    { key: "/upload", label: "数据上传" },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center" }}>
        <div style={{ color: "#fff", fontSize: 18, fontWeight: 600, marginRight: 32 }}>
          销售外勤轨迹分析
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1 }}
        />
      </Header>
      <Content style={{ padding: 16, background: "#f5f5f5" }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/upload" element={<UploadPage />} />
        </Routes>
      </Content>
    </Layout>
  );
}

export default App;
