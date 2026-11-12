// A size for people to read. What is not a size above 0 (a negative number, NaN, not a number at all) reads as
// `0 B`; less than a byte is counted in bytes and more than 1024 TB in TB. (Each of those used to give `NaN
// undefined` or a number with the unit `undefined`.)
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  if (bytes === Infinity) return `∞ ${units.at(-1)}`
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))))

  const value = bytes / Math.pow(k, i)
  const dp = i <= 1 ? 0 : 1 // bytes no dp
  return `${value.toFixed(dp)} ${units[i]}`
}
