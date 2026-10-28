export const count = (value: number) => value.toLocaleString('zh-CN');
export const seconds = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(2)} s`;
export const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
export const resultNames: Record<string, string> = { success: '成功', slow: '响应缓慢', failover: '已切换', error: '失败', empty: '空响应', cancelled: '已取消' };
export const resultColor = (result: string) => ['error', 'offline'].includes(result) ? 'error' : ['slow', 'degraded', 'empty'].includes(result) ? 'warning' : result === 'cancelled' ? 'secondary' : result === 'failover' ? 'primary' : 'success';
export function download(name: string, value: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
