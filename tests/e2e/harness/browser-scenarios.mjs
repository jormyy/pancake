import { BROWSER_SCENARIOS } from '../browser-scenario-registry.mjs'

export async function runBrowserScenarios({ args, season, shouldRun, scenarioContext = {} }) {
  /** @type {Record<string, unknown>} */
  const results = Object.fromEntries(
    BROWSER_SCENARIOS.map((scenario) => [scenario.resultKey, null]),
  )

  for (const scenario of BROWSER_SCENARIOS) {
    if (args[scenario.flag] && shouldRun(args, season)) {
      results[scenario.resultKey] = await scenario.run({ ...scenarioContext, args, season })
    }
  }

  return results
}
