import process from 'node:process'
import { requestedTradeScenarioId, tradeScenarioById } from './trade-scenario-registry.mjs'

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  const scenarioId = requestedTradeScenarioId(process.argv.slice(2))
  tradeScenarioById(scenarioId).run({ season }).catch((/** @type {unknown} */ error) => {
    console.error(error)
    process.exitCode = 1
  })
}
