/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  // 禁用 Preflight，避免覆盖 Ant Design / Semi UI 的样式重置
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};
