/**
 * 里程读数校验与统计口径的通用配置。
 * 通过环境变量 `MILEAGE_VALIDATION_MAX_KM` 配置单次/累计里程的合理上限（单位：km）。
 */
export const MAX_MILEAGE_KM = (() => {
  const raw = process.env.MILEAGE_VALIDATION_MAX_KM;
  if (!raw) return 5000;
  const n = parseFloat(raw);
  return isNaN(n) || n <= 0 ? 5000 : n;
})();
