import { browserScenarioArgs } from '../browser-scenario-manifest.mjs'
import { backendScenarioArgs } from '../backend-scenario-manifest.mjs'

export const parseArgs = () => {
  const args = new Map()
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) args.set(match[1], match[2])
  }
  const releaseGate = args.get('release-gate') === 'true' || process.env.E2E_RELEASE_GATE === '1'
  return {
    seasons: Number(args.get('seasons') ?? process.env.E2E_SEASONS ?? 10),
    keepGoing: args.get('keep-going') === 'true' || process.env.E2E_KEEP_GOING === '1',
    repeatScenariosEverySeason: args.get('repeat-scenarios-every-season') === 'true' || process.env.E2E_REPEAT_SCENARIOS_EVERY_SEASON === '1',
    fakePort: Number(args.get('fake-port') ?? process.env.FAKE_UPSTREAM_PORT ?? 4555),
    browserFullSweep: args.get('browser-full-sweep') === 'true' || process.env.E2E_BROWSER_FULL_SWEEP === '1',
    ...browserScenarioArgs(args, { releaseEnabled: releaseGate }),
    ...backendScenarioArgs(args, { releaseEnabled: releaseGate }),
    pickChain: args.get('pick-chain') === 'true' || process.env.E2E_ENABLE_PICK_CHAIN === '1',
    push: args.get('push') === 'true' || process.env.E2E_ENABLE_PUSH === '1',
    history: args.get('history') === 'true' || process.env.E2E_ENABLE_HISTORY === '1',
    realtime: args.get('realtime') === 'true' || process.env.E2E_ENABLE_REALTIME === '1',
    midlifeMigration: args.get('midlife-migration') === 'true' || process.env.E2E_ENABLE_MIDLIFE_MIGRATION === '1',
    releaseGate,
  }
}
