import { initVChartSemiTheme } from "@visactor/vchart-semi-theme";

// 初始化 Semi DV 图表主题，自动适配 Semi Design 亮/暗模式。
// 放在独立模块并在各图表组件中按需引入（副作用 import），
// 避免在 main.tsx 中静态引入导致 2MB+ 的 vchart 进入首屏关键路径。
initVChartSemiTheme();
