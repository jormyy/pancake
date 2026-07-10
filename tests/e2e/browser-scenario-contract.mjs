/**
 * @typedef {{ id: string }} ScenarioDefinition
 * @typedef {(context: { args: Record<string, unknown>, season: number, resourceOwner?: unknown }) => Promise<unknown>} ScenarioRunner
 */

/**
 * @template {ScenarioDefinition} Scenario
 * @param {Scenario[]} scenarios
 * @param {Map<string, ScenarioRunner>} runners
 */
export const bindBrowserScenarioRunners = (scenarios, runners) => {
  const ids = new Set(scenarios.map(({ id }) => id))
  const extras = [...runners.keys()].filter((id) => !ids.has(id))
  if (extras.length > 0) throw new Error(`Browser runners have no manifest entry: ${extras.join(', ')}`)
  return scenarios.map((scenario) => {
    const run = runners.get(scenario.id)
    if (!run) throw new Error(`Browser scenario ${scenario.id} has no runner`)
    return { ...scenario, run }
  })
}
