import { dates, season } from './common.mjs'
import { parseArgs } from 'node:util'
import { prepareNextFixtures } from './next-season.mjs'
import { runSegment } from './segment.mjs'
import { collectNextSchedule, comparePinnedManifest } from './collect-next.mjs'
import { collect } from './collect.mjs'
import { audit } from './audit.mjs'
import { replay } from './replay.mjs'
import { lifecycle } from './lifecycle.mjs'
import { setClock } from './clock.mjs'
import { probeDelayedTipoff } from './delayed-tipoff.mjs'
import { collectTwoSources } from './collect-two.mjs'
import { prepareTwoInputs } from './prepare-two.mjs'
import { collectRosterHistory } from './collect-rosters.mjs'

const { values } = parseArgs({ options: {
  'collect-two-sources': { type: 'boolean' },
  'prepare-two': { type: 'boolean' },
  'collect-rosters': { type: 'boolean' },
  'probe-delayed-tipoff': { type: 'boolean' },
  'prepare-next': { type: 'boolean' }, segment: { type: 'string' }, 'after-restore-sql': { type: 'string' }, 'late-season': { type: 'boolean' }, replay: { type: 'boolean' }, lifecycle: { type: 'boolean' }, collect: { type: 'boolean' }, help: { type: 'boolean' },
  'compare-pinned': { type: 'string' }, audit: { type: 'boolean' }, 'collect-next': { type: 'boolean' },
  clock: { type: 'boolean' }, install: { type: 'boolean' }, at: { type: 'string' }, rate: { type: 'string' }, state: { type: 'string' },
  fixtures: { type: 'string' }, evidence: { type: 'string' },
  days: { type: 'string' }, start: { type: 'string' }, games: { type: 'string' },
  'retry-missing': { type: 'boolean' },
} })
for (const key of ['days', 'games']) if (values[key] != null && (!/^\d+$/.test(values[key]) || Number(values[key]) < 1)) throw new Error(`Invalid --${key}`)
if (Number(values.days ?? 1) > dates(season.start,season.end).length || Number(values.games ?? 1) > 1300) throw new Error('Requested range exceeds this season')
if ([values['collect-rosters'],values['prepare-two'], values['collect-two-sources'], values['probe-delayed-tipoff'], values['compare-pinned'], values.collect, values.audit, values.clock, values.replay, values.lifecycle, values.segment, values['collect-next'], values['prepare-next']].filter(Boolean).length > 1) throw new Error('Choose one operation')
if (values['after-restore-sql'] && !values.segment) throw new Error('--after-restore-sql requires --segment')
if (values.replay && (values.games || values.fixtures || values.evidence)) throw new Error('Replay uses the complete lane fixture store; use --start and --days to select dates')
if (values.lifecycle && values.days) throw new Error('--days applies to collection or replay, not lifecycle probes')
if (values.help) {
  console.log(`npm run e2e:season-sim -- --compare-pinned /absolute/manifest.jsonl\nnpm run e2e:season-sim -- --collect|--audit [--days 2] [--games 20] [--fixtures PATH] [--evidence PATH] [--retry-missing]\nnpm run e2e:season-sim -- --clock --install --at ${season.start}T12:00:00Z [--rate 0]\nnpm run e2e:season-sim -- --collect-next|--prepare-next\nnpm run e2e:season-sim -- --segment NAME [--after-restore-sql /absolute/mutant.sql]\nnpm run e2e:season-sim -- --replay [--late-season] [--start ${season.start}] [--days 2]\nnpm run e2e:season-sim -- --lifecycle [--start ${dates(season.start,season.end)[7]}]\nAll writes stay in the lane or its declared new artifact folder.`)
} else if (values['collect-rosters']) {
  console.log(JSON.stringify(await collectRosterHistory()))
} else if (values['prepare-two']) {
  console.log(JSON.stringify(await prepareTwoInputs()))
} else if (values['collect-two-sources']) {
  console.log(JSON.stringify(await collectTwoSources()))
} else if (values['probe-delayed-tipoff']) {
  console.log(JSON.stringify(await probeDelayedTipoff()))
} else if (values['compare-pinned']) {
  console.log(JSON.stringify(await comparePinnedManifest(values['compare-pinned'])))
} else if (values['prepare-next']) {
  console.log(JSON.stringify(await prepareNextFixtures()))
} else if (values.segment) {
  await runSegment(values.segment, values)
} else if (values['collect-next']) {
  console.log(JSON.stringify(await collectNextSchedule()))
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
