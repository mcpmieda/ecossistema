const gradeFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const formatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const analyticsNumberV6 = (value: number | null) =>
  value === null ? '—' : formatter.format(value);
export const analyticsPercentV6 = (value: number | null) =>
  value === null ? '—' : `${formatter.format(value)}%`;
export const analyticsDeltaV6 = (value: number | null) => {
  if (value === null) {
    return '—';
  }
  if (value !== 0 && Math.abs(value) < 0.05) {
    return `${value > 0 ? '+' : '−'}<0,1 p.p.`;
  }
  return `${value > 0 ? '+' : ''}${formatter.format(value)} p.p.`;
};
export const analyticsGradeV6 = (value: number | null) =>
  value === null ? '—' : gradeFormatter.format(value / 1000);
export const analyticsPeriodV6 = (period: 1 | 2 | 3 | 'annual') =>
  period === 'annual' ? 'Ano completo' : `${period}º trimestre`;
