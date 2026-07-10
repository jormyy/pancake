/** @param {unknown} error */
const errorText = (error) => error instanceof Error ? error.message : String(error)

/** @param {string} label */
export const createScenarioResourceOwner = (label) => {
  /** @type {{ name: string, dispose: () => Promise<void> }[]} */
  const resources = []
  let disposed = false
  return {
    /** @param {string} name @param {() => Promise<void>} dispose */
    register(name, dispose) {
      if (disposed) throw new Error(`${label}: cannot register ${name} after disposal`)
      resources.push({ name, dispose })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      const failures = []
      for (const resource of [...resources].reverse()) {
        try {
          await resource.dispose()
        } catch (error) {
          failures.push(new Error(`${resource.name}: ${errorText(error)}`))
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `${label}: resource cleanup failed`)
    },
  }
}

/** @param {unknown} primaryError @param {unknown} cleanupError @param {string} label */
export const throwWithCleanup = (primaryError, cleanupError, label) => {
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], `${label} and cleanup failed`)
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}
