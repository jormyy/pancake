// Edge functions cannot reliably import the workspace package during Supabase
// deployment. Keep this pure helper in sync with core/src/season/year.ts.
export function currentSeasonYear(): number {
  const now = new Date()
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
}
