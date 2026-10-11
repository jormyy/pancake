export async function syncStatsThenScores(
  syncStats: () => Promise<number>,
  syncScores: () => Promise<void>,
): Promise<number> {
  const failures: unknown[] = []
  let statLines = 0
  try {
    statLines = await syncStats()
  } catch (error) {
    failures.push(error)
  }
  try {
    await syncScores()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Sync failed for some inputs; independent scoring was attempted')
  }
  return statLines
}
