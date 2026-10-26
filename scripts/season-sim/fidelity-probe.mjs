import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startRuntime } from './runtime.mjs'
import { dispatch } from './dispatch.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { miniRoot, originUrl, writeJson, sha256 } from './common.mjs'
import { classifyOutcome } from './official-outcomes.mjs'
import { providerEvidence } from './provider-evidence.mjs'
import { sourceEvidence } from './source-manifest.mjs'

process.env.SEASON_SIM_PROFILE = path.join(miniRoot, 'official-profile.json')
process.env.SEASON_SIM_DISCRETE_CLOCK = '0'
const at = '2024-10-26T10:00:00Z'
const report = { startedAt: new Date().toISOString(), source: await sourceEvidence(), at, cases: [] }
const readProviders = providerEvidence()
const faultFile = path.join(miniRoot, 'state/fault.json')
let runtime
const run = async (name, expected, label) => {
  const rows = await dispatch(`SELECT public.invoke_edge_function('${name}')`, { allowFailure: true })
  assert.equal(rows.length, 1)
  const outcome = { ...rows[0], providerOrigin: originUrl('replay') }
  const providers = await readProviders(outcome.invocation_key)
  const classification = classifyOutcome(outcome, { providers, at: Date.parse(at) })
  report.cases.push({ label, outcome, providers, classification })
  await writeJson(path.join(miniRoot, 'evidence/fidelity-native-probe.json'), report)
  assert.equal(classification.kind, expected, JSON.stringify(report.cases.at(-1)))
  return outcome
}
try {
  await assert.rejects(readFile(faultFile), { code: 'ENOENT' })
  runtime = await startRuntime(at)
  const forceCareerLookup = async () => {
    const target = await sql(`UPDATE players SET career_games_base_attempted_at=NULL WHERE id=(SELECT id FROM players WHERE espn_id IS NOT NULL AND years_exp IS NOT NULL AND (career_regular_season_games IS NULL OR career_regular_season_games<65) AND (career_games_base IS NULL OR career_games_base_source='coverage') ORDER BY id LIMIT 1) RETURNING id`)
    assert.ok(target, 'Native player probe needs one unverified career target')
  }
  const oldProjectionRuns = await sqlJson("SELECT coalesce(json_agg(id),'[]') FROM projection_sync_runs", 'Before native projection runs')
  await forceCareerLookup()
  await run('sync-players', 'known-source-gap', 'Native player partial writes retain exact identity source gap')
  await run('sync-player-injuries', 'supported-success', 'Native historical injury handler succeeds after dated observations')
  await run('sync-rankings', 'known-source-gap', 'Native Hashtag handler reaches controlled unavailable response')
  await run('sync-sleeper-projections', 'known-source-gap', 'Native hardcoded Sleeper handler reaches exact mapped response')
  await sql("UPDATE player_projections SET fetched_at='2000-01-01T00:00:00Z' WHERE season_year=2025")
  const projections = await run('sync-projections', 'known-source-gap', 'Native FantasyPros gaps retain successful internal fallback')
  const body = JSON.parse(projections.content)
  assert.ok(body.internalFallback > 0, 'Supported internal projections must produce durable results')
  const durable = await sqlJson(`SELECT json_build_object('fallback',(SELECT count(*) FROM player_projections WHERE season_year=2025 AND fetched_at='${at}'),'sourceRuns',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,source,projection_type,source_url,status,http_status,error_message FROM projection_sync_runs WHERE NOT(id=ANY(ARRAY[${oldProjectionRuns.map(id => `'${id}'::uuid`).join(',')}]::uuid[]))) r))`, 'Native projection durable writes')
  assert.equal(durable.fallback, body.internalFallback)
  assert.equal(durable.sourceRuns.length, 4)
  assert.ok(durable.sourceRuns.every(row => row.status === 'failed' && row.http_status === 503))
  report.durable = durable
  await forceCareerLookup()
  await writeFile(faultFile, JSON.stringify({ type: 'guarded-provider' }))
  try {
    const outcome = await run('sync-players', 'unexpected', 'Native career warning cannot conceal a loopback guard failure')
    assert.equal(JSON.parse(outcome.content).failure, 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503')
    assert.ok(report.cases.at(-1).providers.some(row => row.boundaryRejected && /Only loopback/.test(row.error)))
  } finally { await rm(faultFile) }
  await sql("CREATE OR REPLACE FUNCTION season_sim.inject_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='sleeper' THEN RAISE EXCEPTION 'Injected replay worker database fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER season_sim_injected_fault BEFORE INSERT ON public.projection_sync_runs FOR EACH ROW EXECUTE FUNCTION season_sim.inject_projection_failure()")
  try {
    const outcome = await run('sync-sleeper-projections', 'unexpected', 'Native unrelated database fault is fatal')
    assert.match(outcome.sync_error, /Injected replay worker database fault/)
  } finally {
    await sql('DROP TRIGGER IF EXISTS season_sim_injected_fault ON public.projection_sync_runs; DROP FUNCTION IF EXISTS season_sim.inject_projection_failure()')
  }
  await writeFile(faultFile, JSON.stringify({ type: 'http', prefix: '/fantasypros/', status: 418 }))
  try {
    const outcome = await run('sync-projections', 'unexpected', 'Native swallowed provider errors cannot pass through HTTP200')
    assert.equal(outcome.status_code, 200)
    assert.equal(outcome.worker_status, 'success')
  } finally { await rm(faultFile) }
  const archive = path.join(miniRoot, 'rejected-fidelity-20261026T072354Z/evidence/dispatch.jsonl')
  const bytes = await readFile(archive)
  const rows = bytes.toString('utf8').trim().split('\n').map(row => JSON.parse(row))
  const failures = rows.filter(row => ['sync-rankings', 'sync-sleeper-projections'].includes(row.function_name) && row.worker_status === 'failed')
  assert.ok(failures.length >= 48)
  const durableFailures = await sqlJson(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT i.id,i.invocation_key,s.status AS sync_status,s.error AS sync_error FROM edge_invocations i JOIN sync_runs s ON s.id=i.sync_run_id WHERE i.id IN (${failures.map(row => Number(row.id)).join(',')})) r`, 'Retained routing failure outcomes')
  assert.equal(durableFailures.length, failures.length)
  assert.ok(durableFailures.every(row => /Only loopback targets are allowed/.test(row.sync_error)))
  report.archived = { file: archive, sha256: sha256(bytes), rejected: failures.map(outcome => {
    const durable = durableFailures.find(row => row.id === outcome.id)
    const classification = classifyOutcome({ ...outcome, ...durable, providerOrigin: originUrl('replay') }, { at: Date.parse(at) })
    return { outcome, durable, classification }
  }) }
  assert.ok(report.archived.rejected.every(row => row.classification.kind === 'unexpected'))
  report.passed = true
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  await runtime?.close()
  const restore = await readFile(new URL('./restore-clock.sql', import.meta.url), 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
  report.finishedAt = new Date().toISOString()
  await writeJson(path.join(miniRoot, 'evidence/fidelity-native-probe.json'), report)
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(row => ({ label: row.label, kind: row.classification.kind })), archivedRejected: report.archived?.rejected.length, error: report.error }))
}
