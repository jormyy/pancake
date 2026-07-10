/** @param {unknown} error */
const errorText = (error) => error instanceof Error ? error.message : String(error)

/** @param {string} label */
export const createScenarioResourceOwner = (label) => {
  /** @type {{ name: string, dispose: () => Promise<void>, released: boolean }[]} */
  const resources = []
  const resourceKeys = new Set()
  let disposed = false
  return {
    /** @param {string} name @param {() => Promise<void>} dispose */
    register(name, dispose) {
      if (disposed) throw new Error(`${label}: cannot register ${name} after disposal`)
      resources.push({ name, dispose, released: false })
    },
    /** @param {string} key @param {string} name @param {() => Promise<void>} dispose */
    registerOnce(key, name, dispose) {
      if (resourceKeys.has(key)) return
      resourceKeys.add(key)
      this.register(name, dispose)
    },
    /** @param {string} key */
    release(key) {
      const index = [...resourceKeys].indexOf(key)
      if (index < 0) return
      resources[index].released = true
    },
    async dispose() {
      if (disposed) return
      const failures = []
      for (const resource of [...resources].reverse()) {
        if (resource.released) continue
        try {
          await resource.dispose()
          resource.released = true
        } catch (error) {
          failures.push(new Error(`${resource.name}: ${errorText(error)}`))
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `${label}: resource cleanup failed`)
      disposed = true
    },
  }
}

/** @param {string} key @param {string} name @param {() => Promise<void>} dispose */
export const ownScenarioResource = (key, name, dispose) => {
  activeScenarioOwner.getStore()?.registerOnce(key, name, dispose)
}

/** @param {string} key */
export const releaseScenarioResource = (key) => {
  activeScenarioOwner.getStore()?.release(key)
}

/**
 * @template Result
 * @param {string} label
 * @param {() => Promise<Result>} run
 * @param {{ onComplete?: (result: { outcome: { ok: false } | { ok: true, value: Result }, primaryError: unknown, cleanupError: unknown }) => Promise<void> }} [options]
 * @returns {Promise<Result>}
 */
export const runWithScenarioResourceOwner = async (label, run, options = {}) => {
  const owner = createScenarioResourceOwner(label)
  return activeScenarioOwner.run(owner, async () => {
    /** @type {{ ok: false } | { ok: true, value: Result }} */
    let outcome = { ok: false }
    let primaryError = null
    try {
      outcome = { ok: true, value: await run() }
    } catch (error) {
      primaryError = error
    }
    let cleanupError = null
    try {
      await owner.dispose()
    } catch (error) {
      cleanupError = error
    }
    let completionError = null
    try {
      await options.onComplete?.({ outcome, primaryError, cleanupError })
    } catch (error) {
      completionError = error
    }
    if (completionError) {
      const errors = [primaryError, cleanupError, completionError].filter((error) => error != null)
      if (errors.length === 1) throw completionError
      throw new AggregateError(errors, `${label}: execution, cleanup, or canonical evidence failed`)
    }
    throwWithCleanup(primaryError, cleanupError, label)
    if (!outcome.ok) throw new Error(`${label}: scenario ended without a result`)
    return outcome.value
  })
}

/** @param {unknown} primaryError @param {unknown} cleanupError @param {string} label */
export const throwWithCleanup = (primaryError, cleanupError, label) => {
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], `${label} and cleanup failed`)
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}
import { AsyncLocalStorage } from 'node:async_hooks'

const activeScenarioOwner = new AsyncLocalStorage()
