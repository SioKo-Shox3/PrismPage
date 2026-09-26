const mebibyte = 1024 * 1024
const gibibyte = 1024 * mebibyte

// バイト数を「734 MB」「2 GB」の形にする(1024 進)。
export function formatBytes(bytes: number) {
  if (bytes >= gibibyte) {
    const value = bytes / gibibyte
    return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`
  }
  if (bytes >= mebibyte) return `${Math.round(bytes / mebibyte)} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return '0 MB'
}
