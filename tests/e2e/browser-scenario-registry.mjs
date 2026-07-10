import { runBrowserAuthScenario } from './browser-auth.mjs'
import { runBrowserGameplayScenario } from './browser-gameplay.mjs'
import { runBrowserLeagueLifecycleScenario } from './browser-league-lifecycle.mjs'
import {
  runBrowserLineupAutoSetScenario,
  runBrowserLineupLockedScenario,
  runBrowserLineupScenario,
} from './browser-lineup-gameplay.mjs'
import { runBrowserPerfSmoke } from './browser-perf-smoke.mjs'
import { runBrowserPlayoffChampionScenario } from './browser-playoff-gameplay.mjs'
import { runBrowserRookieDraftAutoPickScenario } from './browser-rookie-draft-gameplay.mjs'
import { runBrowserSmoke } from './browser-smoke.mjs'
import {
  runBrowserWaiverDropScenario,
  runBrowserWaiverIrBlockScenario,
  runBrowserWaiverScenario,
} from './browser-waiver-gameplay.mjs'
import { TRADE_SCENARIOS } from './trade-scenario-registry.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './browser-scenario-manifest.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bindBrowserScenarioRunners } from './browser-scenario-contract.mjs'

/** @param {unknown} error */
const errorText = (error) => error instanceof Error ? error.message : error == null ? null : String(error)
const REGISTRY_ARTIFACT_ROOT = path.join(process.cwd(), 'tests/artifacts/registry')

export const writeRegisteredScenarioReport = async (scenario, context, { outcome, primaryError, cleanupError }) => {
  const result = outcome.ok ? outcome.value : null
  const resultPassed = result != null && typeof result === 'object' && Reflect.get(result, 'status') === 'PASS'
  const contractError = outcome.ok && !resultPassed
    ? `Scenario returned ${result && typeof result === 'object' && 'status' in result ? String(result.status) : 'no status'} instead of PASS`
    : null
  const report = {
    status: primaryError || cleanupError || contractError ? 'FAIL' : 'PASS',
    scenario: scenario.id,
    evidenceId: scenario.evidenceId,
    evidence: scenario.evidence,
    season: context.season,
    error: errorText(primaryError) ?? contractError,
    cleanupError: errorText(cleanupError),
    result,
  }
  const registryRoot = context.registryArtifactRoot ?? REGISTRY_ARTIFACT_ROOT
  await mkdir(registryRoot, { recursive: true })
  const registryPath = path.join(registryRoot, `${scenario.id}-season-${context.season}.json`)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(registryPath, serialized)
  if (!result?.artifactDir) return
  await mkdir(result.artifactDir, { recursive: true })
  await writeFile(
    path.join(result.artifactDir, 'registry-summary.json'),
    serialized,
  )
}

const standardRunners = {
  smoke: ({ args, season }) => runBrowserSmoke({ season, fullSweep: args.browserFullSweep }),
  auth: ({ season }) => runBrowserAuthScenario({ season }),
  performance: ({ season, resourceOwner = undefined }) => runBrowserPerfSmoke({ season, resourceOwner }),
  auction: ({ season }) => runBrowserGameplayScenario({ season }),
  lineup: ({ season }) => runBrowserLineupScenario({ season }),
  'lineup-auto-set': ({ season }) => runBrowserLineupAutoSetScenario({ season }),
  'lineup-locked': ({ season }) => runBrowserLineupLockedScenario({ season }),
  playoffs: ({ season }) => runBrowserPlayoffChampionScenario({ season }),
  'rookie-draft': ({ season }) => runBrowserRookieDraftAutoPickScenario({ season }),
  waiver: ({ season }) => runBrowserWaiverScenario({ season }),
  'waiver-drop': ({ season }) => runBrowserWaiverDropScenario({ season }),
  'waiver-ir-block': ({ season }) => runBrowserWaiverIrBlockScenario({ season }),
  'league-lifecycle': ({ season }) => runBrowserLeagueLifecycleScenario({ season }),
}
const tradeRunners = Object.fromEntries(TRADE_SCENARIOS.map((scenario) => [
  `trade-${scenario.id}`,
  ({ season }) => scenario.run({ season }),
]))
const runners = new Map(Object.entries({ ...standardRunners, ...tradeRunners }))

export const BROWSER_SCENARIOS = bindBrowserScenarioRunners(BROWSER_SCENARIO_MANIFEST, runners)
  .map((scenario) => ({
    ...scenario,
    run: async (context) => {
      const result = await runWithScenarioResourceOwner(
        `browser ${scenario.id}`,
        (resourceOwner) => scenario.run({ ...context, resourceOwner }),
        { onComplete: (completion) => writeRegisteredScenarioReport(scenario, context, completion) },
      )
      if (!result || typeof result !== 'object' || Reflect.get(result, 'status') !== 'PASS') {
        throw new Error(`Browser scenario ${scenario.id} did not return PASS`)
      }
      return result
    },
  }))

export const browserScenarioById = (id) => {
  const scenario = BROWSER_SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Unknown browser scenario: ${id}`)
  return scenario
}
