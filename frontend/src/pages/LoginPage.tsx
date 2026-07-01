import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api";

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = username.trim().length > 0 && password.trim().length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const user = await login(username.trim(), password);
      localStorage.setItem("user_id", user.user_id);
      navigate("/", { replace: true });
      window.location.reload();
    } catch (err: any) {
      setError(err.response?.data?.error || "登录失败，请检查用户名和密码");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#F6F8FC]">
      <div className="w-[400px] max-w-[calc(100%-2rem)] rounded-2xl bg-white p-8 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
        <h2 className="text-center text-2xl font-medium text-[#0f1419]">
          销售外勤行为决策系统
        </h2>
        <p className="mt-2 text-center text-sm text-[#72808a]">请登录</p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="username"
              className="text-sm font-medium text-[#0f1419]"
            >
              用户名
            </label>
            <input
              id="username"
              type="text"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="h-10 w-full rounded-[10px] border-0 bg-[rgb(248,249,250)] px-3 text-sm font-medium text-[#0f1419] outline-none ring-0 transition-colors placeholder:font-normal placeholder:text-[#72808a]"
            />
          </div>

          <div className="mt-4 flex flex-col gap-1.5">
            <label
              htmlFor="password"
              className="text-sm font-medium text-[#0f1419]"
            >
              密码
            </label>
            <input
              id="password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10 w-full rounded-[10px] border-0 bg-[rgb(248,249,250)] px-3 text-sm font-medium text-[#0f1419] outline-none ring-0 transition-colors placeholder:font-normal placeholder:text-[#72808a]"
            />
          </div>

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className={`mt-6 flex h-10 w-full items-center justify-center rounded-[10px] text-sm font-medium text-white transition-colors ${
              canSubmit ? "bg-[#0f1419] hover:bg-[#2c3238]" : "bg-[#EBECED]"
            }`}
          >
            {loading ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              "登录"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
