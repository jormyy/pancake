// Returns the ending year of the current NBA season.
// e.g. October 2025 → 2026, March 2026 → 2026, September 2026 → 2026
export function currentSeasonYear(): number {
  const now = new Date()
  const month = now.getMonth() // 0-indexed, 9 = October
  const year = now.getFullYear()
  return month >= 9 ? year + 1 : year
}
