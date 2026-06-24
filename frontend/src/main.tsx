import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider as SemiConfigProvider } from "@douyinfe/semi-ui";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

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
