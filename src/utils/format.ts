/** 字节数转可读文本 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 速度文本，如 3.2 MB/s */
export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '--'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 剩余时间文本 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '--'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${Math.ceil(seconds % 60)} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
