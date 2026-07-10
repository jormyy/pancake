import process from 'node:process'
import { browserScenarioById } from './browser-scenario-registry.mjs'

const scenarioId = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]
if (!scenarioId) throw new Error('--scenario is required')

await browserScenarioById(scenarioId).run({
  args: { browserFullSweep: false },
  season: 0,
})
