import { parseArgs } from 'node:util'
import { collect } from './collect.mjs'
import { audit } from './audit.mjs'
import { replay } from './replay.mjs'
import { lifecycle } from './lifecycle.mjs'
import { setClock } from './clock.mjs'

const { values } = parseArgs({ options: {
  replay: { type: 'boolean' }, lifecycle: { type: 'boolean' }, collect: { type: 'boolean' }, help: { type: 'boolean' },
  audit: { type: 'boolean' },
  clock: { type: 'boolean' }, install: { type: 'boolean' }, at: { type: 'string' }, rate: { type: 'string' }, state: { type: 'string' },
  fixtures: { type: 'string' }, evidence: { type: 'string' },
  days: { type: 'string' }, start: { type: 'string' }, games: { type: 'string' },
  'retry-missing': { type: 'boolean' },
} })
for (const key of ['days', 'games']) if (values[key] != null && (!/^\d+$/.test(values[key]) || Number(values[key]) < 1)) throw new Error(`Invalid --${key}`)
if (Number(values.days ?? 1) > 174 || Number(values.games ?? 1) > 1300) throw new Error('Requested range exceeds this season')
if ([values.collect, values.audit, values.clock, values.replay, values.lifecycle].filter(Boolean).length > 1) throw new Error('Choose one operation')
if (values.replay && (values.games || values.fixtures || values.evidence)) throw new Error('Replay uses the complete lane fixture store; use --start and --days to select dates')
if (values.lifecycle && values.days) throw new Error('--days applies to collection or replay, not lifecycle probes')
if (values.help) {
  console.log('npm run e2e:season-sim -- --collect|--audit [--days 2] [--games 20] [--fixtures PATH] [--evidence PATH] [--retry-missing]\nnpm run e2e:season-sim -- --clock --install --at 2025-10-21T12:00:00Z [--rate 0]\nnpm run e2e:season-sim -- --replay [--start 2025-10-21] [--days 2]\nnpm run e2e:season-sim -- --lifecycle [--start 2025-10-28]\nAll operations run only under the mini lane folder.')
} else if (values.lifecycle) {
  await lifecycle(values.start)
} else if (values.replay) {
  await replay(values)
} else if (values.audit) {
  await audit({ ...values, games: values.games ? Number(values.games) : undefined })
} else if (values.clock) {
  await setClock(values)
} else if (values.collect) {
  await collect({ ...values, days: values.days ? Number(values.days) : undefined, games: values.games ? Number(values.games) : undefined, retryMissing: values['retry-missing'] })
} else {
  throw new Error('Choose --collect, --audit, --clock, or --replay.')
}
