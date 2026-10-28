<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from 'vuetify';
import { Chart as VueChart } from 'vue-chartjs';
import { Chart, registerables, type ChartData, type ChartOptions } from 'chart.js';
Chart.register(...registerables);
Chart.defaults.font.family = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const props = withDefaults(defineProps<{ type?: 'line' | 'bar' | 'doughnut'; data: ChartData; options?: ChartOptions; height?: number; label: string }>(), { type: 'line', height: 240 });
const theme = useTheme();
function mergeOptions(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = result[key];
    result[key] = value && current && typeof value === 'object' && typeof current === 'object' && !Array.isArray(value) && !Array.isArray(current)
      ? mergeOptions(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return result;
}
const options = computed<ChartOptions>(() => {
  const colors = theme.current.value.colors;
  const foreground = String(colors['on-surface']).replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3');
  const ticks = { color: foreground + 'A6', maxTicksLimit: 6, font: { size: 11 } };
  return mergeOptions({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 6, boxHeight: 6, padding: 12, color: foreground + 'B3', font: { size: 12 } } },
      tooltip: { padding: 8, backgroundColor: colors.surface, titleColor: foreground, bodyColor: foreground + 'D9', borderColor: foreground + '33', borderWidth: 1, titleFont: { size: 12 }, bodyFont: { size: 12 } },
    },
    ...(props.type === 'doughnut' ? { cutout: '76%' } : { scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { ...ticks, maxTicksLimit: 8 } },
      y: { beginAtZero: true, grid: { color: foreground + '14' }, border: { display: false }, ticks },
    } }),
  }, (props.options ?? {}) as Record<string, unknown>) as ChartOptions;
});
</script>
<template><div class="metric-chart" :style="{ height: height + 'px' }"><VueChart :key="type" :type="type" :data="data" :options="options" role="img" :aria-label="label" /></div></template>
<style scoped>.metric-chart { position: relative; width: 100%; min-width: 0; }</style>
