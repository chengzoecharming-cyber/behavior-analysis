import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider as SemiConfigProvider } from "@douyinfe/semi-ui";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import "dayjs/locale/zh-cn";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// 业务时间统一按北京时间处理
// Semi Design/Ant Design 的 DatePicker 返回原生 Date，后续格式化时仍需使用 dayjs.tz
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("zh-cn");
dayjs.tz.setDefault("Asia/Shanghai");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SemiConfigProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SemiConfigProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
