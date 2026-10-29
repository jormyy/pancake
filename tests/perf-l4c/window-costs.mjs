export function edgeWindowCosts(events, costs, window, job, factor) {
  const rows = events.filter(row => row.window === window && row.job === job)
  return {
    runsPerHour: rows.filter(row => row.kind === 'run').length * factor,
    callsPerHour: rows.filter(row => row.kind !== 'run').length * factor,
    databaseMsPerHour: costs.filter(row => row.window === window && row.job === job).reduce((sum, row) => sum + row.ms, 0) * factor,
  }
}
