import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = name => readFileSync(`supabase/sql/functions/by-name/${name}.sql`, 'utf8')
const recipe = name => readFileSync(`tests/db/${name}.sql`, 'utf8').replace(/^BEGIN;\n/, '')
export const revaluationControlCases = () => [
  {
    name: 'closed trades',
    original: source('private/trade_revaluation_input_versions'),
    definition: source('private/trade_revaluation_input_versions').replace("AND trade.status IN ('pending','accepted')", ''),
    recipe: 'trade-revaluation-batch', expected: 'closed trades are excluded',
  },
  {
    name: 'stale fingerprints',
    original: source('private/refresh_trade_values'),
    definition: source('private/refresh_trade_values').replace("IF inputs->>'inputVersion' IS DISTINCT FROM value->>'inputVersion' THEN", 'IF false THEN'),
    recipe: 'trade-revaluation-scope', expected: 'an old fingerprint cannot overwrite current inputs',
  },
  {
    name: 'screen independence',
    original: source('public/view_refresh_work'),
    definition: source('public/view_refresh_work').replace("'version', c.version, 'claimToken', c.claim_token", "'version', c.version, 'claimToken', c.claim_token, 'trades', '[]'::jsonb"),
    recipe: 'trade-revaluation-scope', expected: 'screen claims contain no trade valuation work',
  },
  {
    name: 'bounded averages',
    original: source('private/refresh_player_averages'),
    definition: source('private/refresh_player_averages').replaceAll(/ AND \(full_refresh OR (?:average\.)?player_id=ANY\(affected\)\)/g, ''),
    recipe: 'refresh-player-averages', expected: 'the refresh visits only the changed player',
  },
  {
    name: 'source revisions',
    original: source('private/trade_revaluation_input_version'),
    definition: source('private/trade_revaluation_input_version').replace('LANGUAGE plpgsql','LANGUAGE sql').replace(/AS \$\$[\s\S]*?\$\$;/, () => "AS $$ SELECT 'constant'::text; $$;"),
    recipe: 'trade-revaluation-fast', expected: 'player metadata changes the version',
  },
  {
    name: 'live valuation window',
    original: source('private/begin_trade_revaluation'),
    definition: source('private/begin_trade_revaluation').replace('WHERE NOT live OR schedule.next_allowed_at<=now()', 'WHERE true'),
    recipe: 'trade-revaluation-coalesce', expected: 'a second live value waits',
  },
]
function runRevaluationControls() {
  const url = new URL(process.env.SUPABASE_DB_URL ?? '')
  if (url.hostname !== '127.0.0.1' || url.port !== (process.env.PANCAKE_TEST_DB_PORT ?? '61522')) throw new Error('Use the private revaluation database')
  for (const test of revaluationControlCases()) {
  const sql = `BEGIN;\n${test.definition}\n${recipe(test.recipe)}`
    .replace('\\ir rules-support.sql', () => readFileSync('tests/db/rules-support.sql', 'utf8'))
    .replace('\\ir perf-l4-trade-batch-fixture.sql', () => readFileSync('tests/db/perf-l4-trade-batch-fixture.sql', 'utf8'))
  const result = spawnSync('psql', [url.href, '-Xq', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8' })
  if (result.status === 0 || !result.stderr.includes(`FAIL: ${test.expected}`)) throw new Error(`${test.name}: control failed unexpectedly\n${result.stderr}`)
  console.log(`Rejected broken control: ${test.name}`)
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runRevaluationControls()
