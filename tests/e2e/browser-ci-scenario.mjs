import process from 'node:process'
import { browserScenarioById } from './browser-scenario-registry.mjs'

const scenarioId = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]

export const browserCiContext = (id) => ({
  args: { browserFullSweep: id === 'smoke' },
  season: 0,
})

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!scenarioId) throw new Error('--scenario is required')
  await browserScenarioById(scenarioId).run(browserCiContext(scenarioId))
}
