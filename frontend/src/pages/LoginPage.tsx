import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner, Button, Card, Input, Typography } from "@douyinfe/semi-ui";
import { getDingtalkAuthorizeUrl, login } from "../api";

const { Title, Text } = Typography;

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [dingtalkLoading, setDingtalkLoading] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = username.trim().length > 0 && password.trim().length > 0 && !loading;

  // 钉钉扫码登录：取授权页 URL 后整页跳转钉钉
  const handleDingtalkLogin = async () => {
    setDingtalkLoading(true);
    setError("");
    try {
      const { url } = await getDingtalkAuthorizeUrl();
      window.location.href = url;
    } catch (err: any) {
      setError(err.response?.data?.error || "获取钉钉登录地址失败");
      setDingtalkLoading(false);
    }
  };

  // 应急密码登录（管理员通道，后端未启用时会返回错误提示）
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const { token } = await login(username.trim(), password);
      localStorage.setItem("auth_token", token);
      localStorage.removeItem("user_id");
      navigate("/", { replace: true });
      window.location.reload();
    } catch (err: any) {
      setError(err.response?.data?.error || "登录失败，请检查用户名和密码");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-dark flex h-screen w-full items-center justify-center bg-[#F6F8FC]">
      <Card
        shadows="hover"
        style={{ width: 400, maxWidth: "calc(100% - 2rem)", padding: 8 }}
      >
        <div className="text-center">
          <Title heading={4} style={{ margin: 0 }}>
            销售外勤行为分析系统
          </Title>
          <Text type="tertiary" style={{ display: "block", marginTop: 8 }}>
            请登录
          </Text>
        </div>

        <Button
          theme="solid"
          type="primary"
          size="large"
          block
          loading={dingtalkLoading}
          onClick={handleDingtalkLogin}
          style={{ marginTop: 32 }}
        >
          钉钉扫码登录
        </Button>

        {error && (
          <Banner
            fullMode={false}
            type="danger"
            closeIcon={null}
            description={error}
            style={{ marginTop: 16 }}
          />
        )}

        <div className="mt-6 text-center">
          <Text
            type="tertiary"
            size="small"
            style={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setShowPasswordLogin((v) => !v)}
          >
            {showPasswordLogin ? "收起管理员登录" : "管理员登录"}
          </Text>
        </div>

        {showPasswordLogin && (
          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
            <Input
              id="username"
              placeholder="请输入用户名"
              value={username}
              onChange={(v) => setUsername(v)}
            />
            <Input
              id="password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(v) => setPassword(v)}
            />
            <Button
              theme="solid"
              type="primary"
              htmlType="submit"
              block
              loading={loading}
              disabled={!canSubmit}
              style={{ marginTop: 8 }}
            >
              登录
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
