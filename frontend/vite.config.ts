import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 按库拆分 vendor chunk：配合路由懒加载按需下载，且库内容稳定、hash 不变可长期命中浏览器缓存
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          antd: ["antd", "@ant-design/icons"],
          semi: ["@douyinfe/semi-ui", "@douyinfe/semi-icons"],
          vchart: ["@visactor/react-vchart", "@visactor/vchart-semi-theme"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
