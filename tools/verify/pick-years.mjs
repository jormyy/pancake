import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireLocal } from './run.mjs'
import { preparePickYearFixture } from './pick-year-fixture.mjs'
import { localFixtureEnv } from './local-fetch.mjs'

const [dirArg, action, argument] = process.argv.slice(2)
assert.ok(dirArg && action, 'Pass the owned evidence directory and a pick-year action')
const dir = path.resolve(dirArg)
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.repo, repo)
assert.equal(run.dir, dir)
assert.ok(run.readyAt && !run.cleanedAt)
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const database = requireLocal(env.SUPABASE_DB_URL, 'postgresql:')
assert.equal(Number(database.port), run.ports.db)
database.searchParams.set('sslmode', 'disable')
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const migration = path.join(repo, 'supabase/migrations/20261214010900_draft_pick_calendar_years.sql')
const save = (name, value) => writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + '\n')
const execute = (command, args, input) => spawnSync(command, args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const query = sql => {
  const result = execute('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql)
  assert.equal(result.status, 0, result.stderr || 'Owned local SQL failed')
  return result.stdout.trim()
}
const json = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'))
const receiptExists = () => query("SELECT to_regclass('private.draft_pick_calendar_repairs') IS NOT NULL") === 't'
const state = () => {
  const observed = JSON.parse(query(`SELECT jsonb_build_object(
    'picks',(SELECT jsonb_agg(jsonb_build_object('id',pick.id,'season_year',pick.season_year,'round',pick.round,
      'original_owner_id',pick.original_owner_id,'current_owner_id',pick.current_owner_id,'is_used',pick.is_used,
      'other_columns_sha256',encode(sha256(convert_to((to_jsonb(pick)-'season_year')::text,'UTF8')),'hex')) ORDER BY pick.id)
      FROM public.draft_picks pick WHERE pick.league_id='${league}'),
    'trades',(SELECT jsonb_agg(jsonb_build_object('id',id,'status',status) ORDER BY id) FROM public.trades WHERE league_id='${league}'),
    'items',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM public.trade_items item JOIN public.trades trade ON trade.id=item.trade_id WHERE trade.league_id='${league}'),
    'blocks',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM public.trade_block_items item WHERE item.league_id='${league}'),
    'quotes',(SELECT jsonb_agg(jsonb_build_object('id',id,'inputs',inputs,'analysis',analysis,'terms',terms) ORDER BY id)
      FROM public.trade_estimate_quotes WHERE league_id='${league}'),
    'history',(SELECT jsonb_agg(jsonb_build_object('trade_id',history.trade_id,'formula_version',history.formula_version,'snapshot',history.snapshot) ORDER BY history.trade_id,history.formula_version)
      FROM public.trade_estimate_history history JOIN public.trades trade ON trade.id=history.trade_id WHERE trade.league_id='${league}'),
    'cache',(SELECT jsonb_agg(jsonb_build_object('trade_id',trade_id,'revaluation',revaluation,'valid_until',valid_until) ORDER BY trade_id)
      FROM public.trade_value_cache WHERE league_id='${league}'),
    'sentinel_sha256',(SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(pick) ORDER BY pick.id),'[]'::jsonb)::text,'UTF8')),'hex')
      FROM public.draft_picks pick WHERE pick.league_id<>'${league}'))`))
  observed.receipt = receiptExists() ? JSON.parse(query(`SELECT COALESCE(jsonb_agg(to_jsonb(receipt)),'[]'::jsonb) FROM private.draft_pick_calendar_repairs receipt WHERE league_id='${league}'`)) : []
  return observed
}
const copies = observed => {
  const result = []
  const add = (key, inputs) => {
    for (const [index, pick] of (inputs?.picks ?? []).entries()) result.push({ key: `${key}:${index}`, id: pick.id, year: pick.seasonYear })
  }
  for (const quote of observed.quotes ?? []) add(`quote:${quote.id}`, quote.inputs)
  for (const history of observed.history ?? []) {
    const key = `history:${history.trade_id}:${history.formula_version}`
    add(key, history.snapshot.inputs)
    add(key + ':quote', history.snapshot.quote?.inputs)
  }
  return result
}
const shiftedReferences = (document, delta) => {
  const result = structuredClone(document)
  for (const inputs of [result.inputs, result.quote?.inputs]) {
    for (const pick of inputs?.picks ?? []) pick.seasonYear += delta
  }
  return result
}
const reconcile = (before, after, delta) => {
  assert.equal(before.picks.length, 150)
  assert.equal(after.picks.length, 150)
  assert.deepEqual(after.picks, before.picks.map(pick => ({ ...pick, season_year: pick.season_year + delta })))
  for (const key of ['trades', 'items', 'blocks', 'sentinel_sha256']) assert.deepEqual(after[key], before[key], key)
  assert.deepEqual(copies(after), copies(before).map(copy => ({ ...copy, year: copy.year + delta })))
  assert.deepEqual(after.quotes, before.quotes?.map(quote => ({ ...quote, inputs: shiftedReferences({ inputs: quote.inputs }, delta).inputs })) ?? null)
  assert.deepEqual(after.history, before.history?.map(history => ({ ...history, snapshot: shiftedReferences(history.snapshot, delta) })) ?? null)
  assert.equal(after.picks.filter(pick => pick.original_owner_id !== pick.current_owner_id).length, 7)
}

if (action === 'prepare') {
  assert.ok(argument, 'Provide the filtered before-snapshot; never use a production backup')
  const snapshot = JSON.parse(await readFile(path.resolve(argument), 'utf8'))
  const seed = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
  const fixture = preparePickYearFixture(snapshot, seed, query)
  await save('pick-year-fixture.json', { ...fixture, picks: snapshot.picks })
  await save('pick-years-before.json', state())
  console.log('Prepared 150 wrong-year picks with synthetic local users and frozen references')
} else if (action === 'observe') {
  await save(`pick-years-${argument ?? 'observed'}.json`, state())
  console.log('Saved filtered local pick-year state')
} else if (action === 'apply') {
  const before = await json('pick-years-before.json')
  const source = await readFile(migration, 'utf8')
  const registered = query("SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261214010900')") === 't'
  const absent = execute('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], `BEGIN; DELETE FROM public.leagues WHERE id='${league}';\n${source}`)
  await writeFile(path.join(dir, 'pick-years-target-refused.log'), (absent.stdout ?? '') + (absent.stderr ?? ''))
  assert.notEqual(absent.status, 0)
  assert.match((absent.stdout ?? '') + (absent.stderr ?? ''), /target missing from populated database/)
  assert.deepEqual(state(), before)
  const drift = before.picks.find(pick => pick.original_owner_id === pick.current_owner_id && !(before.blocks ?? []).some(block => block.pick_id === pick.id))
  query(`UPDATE public.draft_picks SET season_year=season_year+100 WHERE id='${drift.id}' AND league_id='${league}'`)
  try {
    const refused = execute('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], source)
    await writeFile(path.join(dir, 'pick-years-refused.log'), (refused.stdout ?? '') + (refused.stderr ?? ''))
    assert.notEqual(refused.status, 0)
    assert.match((refused.stdout ?? '') + (refused.stderr ?? ''), /before-state mismatch/)
    assert.equal(state().picks.find(pick => pick.id === drift.id).season_year, drift.season_year + 100)
  } finally {
    query(`UPDATE public.draft_picks SET season_year=season_year-100 WHERE id='${drift.id}' AND league_id='${league}'`)
  }
  assert.deepEqual(state().picks, before.picks)
  const applied = registered
    ? execute('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], source)
    : execute('supabase', ['migration', 'up', '--db-url', database.href], undefined)
  await writeFile(path.join(dir, 'pick-years-apply.log'), (applied.stdout ?? '') + (applied.stderr ?? ''))
  assert.equal(applied.status, 0, 'Migration application failed; inspect the owned log')
  const after = state()
  reconcile(before, after, -1)
  assert.equal(after.receipt.length, 1)
  assert.equal(after.receipt[0].reference_changes.length, copies(before).length)
  await save('pick-years-after.json', after)
  query(await readFile(migration, 'utf8'))
  const repeated = state()
  assert.deepEqual(repeated, after)
  await save('pick-years-repeat.json', repeated)
  await save('pick-years-migration-receipt.json', { mode: registered ? 'fresh-install repair replay' : 'ordered upgrade', missingTargetRefused: true, driftRefused: true, picksShifted: 150, tradedOwnersPreserved: 7,
    numericReferencesShifted: copies(before).length, allOtherPickColumnsPreserved: true, otherLeagueUnchanged: true, repeatUnchanged: true })
  console.log('PASS drift refusal, 150 exact shifts, reference reconciliation, seven traded owners and repeat no-op')
} else if (action === 'rollback') {
  assert.ok(argument, 'Provide the reviewed external rollback SQL')
  query(await readFile(path.resolve(argument), 'utf8'))
  const before = await json('pick-years-before.json')
  const restored = state()
  reconcile(before, restored, 0)
  assert.equal(restored.receipt.length, 0)
  await save('pick-years-rollback.json', restored)
  query(await readFile(migration, 'utf8'))
  reconcile(before, state(), -1)
  await save('pick-years-restored-candidate.json', state())
  console.log('PASS rollback restored all pick and frozen-reference state; candidate reapplied')
} else if (action === 'check') {
  const recipes = ['dynasty-pick-calendar-years', 'future-pick-settings', 'pick-window', 'rollover-year-gap', 'pick-draft-year',
    'picks-lifecycle', 'linear-draft-order', 'taxi-acquisition-policy', 'server-retired-picks', 'server-stopped-rookie-overflow',
    'trade-value-readers', 'future-pick-cleanup', 'forever-two-seasons', 'notif-draft-transitions', 'three-season-simulation', 'dynasty-rules']
  const receipts = []
  for (const name of recipes) {
    const original = await readFile(path.join(repo, `tests/db/${name}.sql`), 'utf8')
    const sql = original.replaceAll('http://127.0.0.1:60421', requireLocal(env.E2E_SUPABASE_URL).origin)
      .replace(/^\\ir (.+)$/gm, (_, include) => `\\i '${path.resolve(repo, 'tests/db', include)}'`)
    await writeFile(path.join(dir, `pick-years-recipe-${name}.sql`), sql)
    const result = execute('env', [`SUPABASE_DB_URL=${database.href}`, `PANCAKE_TEST_DB_PORT=${database.port}`,
      'psql', database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql)
    await writeFile(path.join(dir, `pick-years-recipe-${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
    assert.equal(result.status, 0, `Recipe ${name} failed; inspect its owned log`)
    receipts.push({ recipe: name, exit: 0, ownedExecutionCopyAdjusted: original !== sql })
    console.log(`PASS ${name}`)
  }
  const deno = execute('deno', ['test', '--no-lock', '--allow-read', 'supabase/functions/_shared/tradeEstimate.test.ts'])
  await writeFile(path.join(dir, 'pick-years-edge.log'), (deno.stdout ?? '') + (deno.stderr ?? ''))
  assert.equal(deno.status, 0, 'Frozen pick valuation tests failed; inspect the owned log')
  await save('pick-years-check-receipt.json', { recipes: receipts, edgeTests: 'passed' })
} else if (action === 'harness') {
  requireLocal(env.E2E_API_BASE_URL)
  const configured = localFixtureEnv({ ...env, PANCAKE_PICK_WINDOW_DB_TESTS: '1', VITEST_MAX_WORKERS: '1' })
  const result = execute('env', [...Object.entries(configured).map(([key, value]) => `${key}=${value}`),
    process.execPath, path.join(repo, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/e2e/pick-window-harness.test.ts'])
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  await writeFile(path.join(dir, 'pick-years-harness.log'), output)
  assert.equal(result.status, 0, 'Live future-pick harness failed; inspect the owned log')
  assert.match(output.replace(/\x1b\[[0-9;]*m/g, ''), /1 passed/)
  console.log('PASS live future-pick generation, chain, invariant and lifecycle harness')
} else if (action === 'catalog') {
  for (const [file, name] of [['db-security-catalog.sql', 'pick-years-security-catalog.json'], ['release-schema-history.sql', 'pick-years-schema-history.json']]) {
    await save(name, JSON.parse(query(await readFile(path.join(repo, 'tests/e2e', file), 'utf8'))))
  }
  console.log('Saved read-only schema and migration catalogs')
} else if (action === 'attest') {
  const result = execute('env', [`SUPABASE_DB_URL=${database.href}`, `PANCAKE_TEST_DB_PORT=${database.port}`,
    'node', 'scripts/regenerate-release-history-attestations.mjs'])
  await writeFile(path.join(dir, 'pick-years-attest.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.status, 0, 'Local attestation refresh failed; inspect the owned log')
  console.log('Regenerated required release attestations from the owned local database')
} else if (action === 'drive') {
  assert.ok(['before', 'after'].includes(argument))
  if (argument === 'after') {
    const head = execute('git', ['rev-parse', 'HEAD']).stdout.trim()
    assert.equal(run.sha, head, 'Rebuild the current head before final UI proof')
    for (const file of ['lib/trades.ts', 'supabase/functions/_shared/tradeEstimate.ts']) {
      assert.equal(await readFile(path.join(run.work, file), 'utf8'), await readFile(path.join(repo, file), 'utf8'), `Refresh ${file} before proof`)
    }
  }
  const fixture = await json('pick-year-fixture.json')
  const { port } = await json('webkit-port.json')
  const command = async (command, ...values) => {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ command, values }) }).then(response => response.json())
    assert.ok(!response.error, response.error)
    return response.result
  }
  const click = (role, name) => command('click', JSON.stringify({ role, name }))
  const wait = async check => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const text = await command('snapshot')
      if (check(text)) return text
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Expected visible pick-year state did not arrive')
  }
  const delta = argument === 'after' ? -1 : 0
  const receipts = []
  for (const [width, height] of [[390, 844], [375, 812], [1440, 1000]]) {
    await command('viewport', String(width), String(height))
    await command('login', '0')
    await click('button', 'Switch league')
    await click('button', 'Switch to Draft year verification')
    await wait(text => text.includes('Draft year verification'))
    await click('link', 'League')
    await click('tab', 'Picks')
    await wait(text => text.includes('150 total'))
    await click('tab', 'Show all draft picks, 150 picks')
    let text = await wait(text => text.includes('All draft picks, 150 picks'))
    const years = [...text.matchAll(/listitem "(\d{4}) Round/g)].map(match => Number(match[1]))
    assert.equal(Math.min(...years), 2028 + delta)
    assert.equal(Math.max(...years), 2032 + delta)
    await command('capture', `pick-years-${argument}-${width}-all`)
    await click('tab', 'Show traded draft picks, 7 picks')
    text = await wait(text => text.includes('Traded draft picks, 7 picks'))
    for (const pick of fixture.picks.filter(pick => pick.original_owner_id !== pick.current_owner_id)) {
      const owner = pick.current_owner_id === fixture.memberId ? 'You' : fixture.ownerNames[pick.current_owner_id]
      assert.ok(text.includes(`${pick.season_year + delta} Round ${pick.round}, from ${fixture.ownerNames[pick.original_owner_id]}, owner ${owner}, traded pick`))
    }
    const observed = await command('observe')
    assert.equal(observed.overflow, false)
    assert.equal(observed.inputMode, width < 960 ? 'touch' : 'mouse')
    await command('capture', `pick-years-${argument}-${width}-traded`)
    receipts.push({ width, height, earliestYear: 2028 + delta, latestYear: 2032 + delta, tradedOwners: 7 })
    console.log(`PASS ${argument} ${width}: complete year window and seven traded owners`)
  }
  await save(`pick-years-ui-${argument}-receipt.json`, { engine: 'WebKit', head: run.sha, receipts })
} else {
  throw new Error('Use prepare, observe, apply, rollback, check, harness, catalog, attest or drive')
}
