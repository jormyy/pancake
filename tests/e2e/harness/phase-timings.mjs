export const createSeasonPhaseTimings = (clock, startedAt) => {
  const durations = new Map()
  let previous = startedAt
  return {
    mark(name) {
      const endedAt = clock()
      durations.set(name, (durations.get(name) ?? 0) + endedAt - previous)
      previous = endedAt
    },
    finish(endedAt) {
      return Object.fromEntries([...durations, ['unattributed', endedAt - previous]])
    },
  }
}

export const formatPhaseTimings = (durations) => `Phase times (ms): ${Object.entries(durations)
  .map(([name, duration]) => `${name}=${Math.round(duration)}`).join(', ')}`
