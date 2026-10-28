import { execFileSync } from 'node:child_process'
import { readFileSync,readdirSync } from 'node:fs'
import { functionDefinitionsInSource } from '../scripts/check-db-function-sources.mjs'
import { databaseTarget } from '../scripts/mutation/waivers/targets.mjs'

const target = databaseTarget()
const sql = value => execFileSync('psql', [target.href, '-Xq', '-v', 'ON_ERROR_STOP=1', '-c', value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const baseline=functionDefinitionsInSource(readdirSync('supabase/migrations')
  .filter(file => file.endsWith('.sql') && file<'20261115000000').sort()
  .map(file => readFileSync(`supabase/migrations/${file}`,'utf8')).join('\n'))
const original=file => {
  const key=file.replace('supabase/sql/functions/by-name/','').replace('/','.').replace(/\.sql$/,'')
  const source=baseline.get(key)
  if (!source) throw new Error(`Missing baseline definition: ${key}`)
  return source
}
const cases = [
  ['public/save_live_game_stats_atomic.sql', 'same live snapshot writes no rows or revisions'],
  ['public/save_live_scoreboard_atomic.sql', 'same live snapshot writes no rows or revisions'],
  ['private/refresh_standings.sql', 'new publication with identical screen content writes no cached rows'],
  ['private/refresh_matchup_totals.sql', 'new publication with identical screen content writes no cached rows'],
  ['private/refresh_player_averages.sql', 'new publication with identical screen content writes no cached rows'],
  ['private/refresh_trade_values.sql', 'new publication with identical screen content writes no cached rows'],
  ['private/league_version_enqueue.sql', 'repeated version topic and source write no pending row'],
  ['private/emit_league_change.sql', 'same transaction coalesces an already covered score scope'],
  ['private/retain_cron_job_run_details.sql', 'cron success and failure expire after 24 hours'],
  ['private/work_enqueue.sql', 'completed enqueue replay writes no row or sequence'],
  ['private/enqueue_scheduled_work.sql', 'idle scheduling creates no work, events, or invocations'],
  ['public/dispatch_work.sql', 'Idle dispatcher attempts a claim'],
]
for (const [name, expected] of cases) {
  const file = `supabase/sql/functions/by-name/${name}`
  const current = readFileSync(file, 'utf8')
  try {
    sql(original(file))
    let failure = ''
    try {
      execFileSync('psql', [target.href, '-Xq', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/io-write-reductions.sql'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      failure = error.stderr?.toString() ?? ''
    }
    if (!failure.includes(expected)) throw new Error(`${name} does not fail its protected check: ${failure.slice(-1400)}`)
    console.log(`PASS: original ${name} fails its protected check`)
  } finally {
    sql(current)
  }
}

const contentFiles = cases.slice(2,6).map(([name]) => `supabase/sql/functions/by-name/${name}`)
const contentSources = contentFiles.map(file => readFileSync(file,'utf8'))
try {
  for (const file of contentFiles) sql(original(file))
  let failure=''
  try {
    execFileSync('psql',[target.href,'-Xq','-v','ON_ERROR_STOP=1','-f','tests/db/io-write-reductions.sql'],{ encoding:'utf8',stdio:['ignore','pipe','pipe'] })
  } catch (error) {
    failure=error.stderr?.toString() ?? ''
  }
  if (!failure.includes('IO unchanged cache rows=5')) throw new Error(`Original cache write count differs: ${failure.slice(-1400)}`)
  console.log('PASS: original unchanged cache refresh writes 5 rows; reduced refresh writes 0')
} finally {
  for (const source of contentSources) sql(source)
}
