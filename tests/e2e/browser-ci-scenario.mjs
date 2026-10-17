import process from 'node:process'
import { configureBrowserDriver } from './browser-agent.mjs'
import { browserScenarioById } from './browser-scenario-registry.mjs'

const scenarioId = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1]

export const browserCiContext = (id) => ({
  args: { browserFullSweep: id === 'smoke' },
  season: 0,
})

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!scenarioId) throw new Error('--scenario is required')
  if (process.env.E2E_WEB_TARGET_ID) {
    const driver = await import('./web-targets-agent.mjs')
    configureBrowserDriver({ run: driver.runWebTargetBrowserCommand, list: async () => driver.listWebTargetBrowserSessions() })
  }
  await browserScenarioById(scenarioId).run(browserCiContext(scenarioId))
}
