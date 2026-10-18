import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const api = process.env.SUPABASE_URL
const db = process.env.SUPABASE_DB_URL
const key = process.env.PANCAKE_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.E2E_SUPABASE_SECRET_KEY
assert.ok(api && db && key)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const admin = createClient(api, key, { auth: { persistSession: false, autoRefreshToken: false } })
const ids = Object.fromEntries(['user', 'league', 'season', 'member', 'goodDraft', 'badDraft', 'snakeDraft', 'goodNom', 'badNom', 'pick', 'player'].map(name => [name, String(randomUUID())]))
const suffix = randomUUID().replaceAll('-', '')
const failFunction = `owned_expiry_${suffix}`
const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
const sql = statement => {
    const result = spawnSync('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}
const get = async operation => {
    const { data, error } = await operation
    if (error) throw error
    return data
}
const started = new Date().toISOString()
let ownerCreated = false
const invoke = async (authorized = true) => {
    const response = await fetch(`${api}/functions/v1/close-expired-nominations`, {
        method: 'POST',
        headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            ...(authorized ? { 'x-internal-function-token': process.env.PANCAKE_EDGE_INTERNAL_TOKEN ?? 'pancake-local-edge-auth-probe-token' } : {}),
        },
        signal: AbortSignal.timeout(30_000),
    })
    return { status: response.status, body: await response.json() }
}
const removeFaults = () => sql(`DROP TRIGGER IF EXISTS ${failFunction} ON public.nominations; DROP TRIGGER IF EXISTS ${failFunction} ON public.snake_draft_picks; DROP FUNCTION IF EXISTS public.${failFunction}();`)
try {
    const created = await admin.auth.admin.createUser({
        email: `expiry-${suffix}@example.test`, password: `Synthetic-${randomUUID()}!`, email_confirm: true,
        user_metadata: { username: `expiry_${suffix.slice(0, 14)}`, display_name: 'Synthetic expiry owner' },
    })
    if (created.error) throw created.error
    ids.user = created.data.user.id
    ownerCreated = true
    console.log(JSON.stringify({ ownedFixture: ids }))
    sql(`
        INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(${quote(ids.league)},'Synthetic expiry outcomes',${quote(suffix)},${quote(ids.user)},'setup');
        INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(ids.member)},${quote(ids.league)},${quote(ids.user)},'commissioner','Synthetic expiry');
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(ids.season)},${quote(ids.league)},9174,true);
        INSERT INTO players(id,first_name,last_name,position) VALUES(${quote(ids.player)},'Synthetic','Expiry player','PG');
        INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,timer_expiry_behavior) VALUES
            (${quote(ids.goodDraft)},${quote(ids.league)},${quote(ids.season)},'auction','in_progress',true,'auction_no_bid'),
            (${quote(ids.badDraft)},${quote(ids.league)},${quote(ids.season)},'auction','in_progress',true,'auction_no_bid'),
            (${quote(ids.snakeDraft)},${quote(ids.league)},${quote(ids.season)},'snake','in_progress',true,'pause_draft');
        INSERT INTO nominations(id,draft_id,player_id,nominating_member_id,nomination_order,status,countdown_expires_at) VALUES
            (${quote(ids.goodNom)},${quote(ids.goodDraft)},${quote(ids.player)},${quote(ids.member)},1,'open',now()-interval '1 minute'),
            (${quote(ids.badNom)},${quote(ids.badDraft)},${quote(ids.player)},${quote(ids.member)},1,'open',now()-interval '1 minute');
        INSERT INTO snake_draft_picks(id,draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at) VALUES
            (${quote(ids.pick)},${quote(ids.snakeDraft)},1,1,1,${quote(ids.member)},now()-interval '1 minute');
        CREATE FUNCTION public.${failFunction}() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'Synthetic expiry row failure'; END $body$;
        CREATE TRIGGER ${failFunction} BEFORE UPDATE ON nominations FOR EACH ROW WHEN (OLD.id=${quote(ids.badNom)}) EXECUTE FUNCTION public.${failFunction}();
        CREATE TRIGGER ${failFunction} BEFORE UPDATE ON snake_draft_picks FOR EACH ROW WHEN (OLD.id=${quote(ids.pick)}) EXECUTE FUNCTION public.${failFunction}();
    `)
    const denied = await invoke(false)
    assert.ok([401, 403].includes(denied.status))
    const mixed = await invoke()
    console.log(JSON.stringify({ case: 'mixed real RPC outcomes', status: mixed.status, result: mixed.body }))
    assert.equal(mixed.status, 500, 'Per-row failures must not report HTTP success')
    assert.equal(mixed.body.ok, false)
    assert.ok(mixed.body.failed >= 2)
    assert.equal(sql(`SELECT status FROM nominations WHERE id=${quote(ids.goodNom)}`), 'no_bid')
    assert.equal(sql(`SELECT status FROM nominations WHERE id=${quote(ids.badNom)}`), 'open')
    assert.equal(sql(`SELECT timer_expires_at IS NOT NULL FROM snake_draft_picks WHERE id=${quote(ids.pick)}`), 't')
    const runs = await get(admin.from('sync_runs').select('id,status,error,finished_at').eq('function_name', 'close-expired-nominations').gte('started_at', started))
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'failed')
    assert.match(runs[0].error, /Synthetic expiry row failure/)
    assert.ok(runs[0].finished_at)
    const orderBefore = Number(sql(`SELECT current_nomination_order FROM drafts WHERE id=${quote(ids.badDraft)}`))
    removeFaults()
    const recovery = await Promise.all([invoke(), invoke()])
    const recovered = recovery[0]
    assert.ok(recovery.every(result => result.status === 200 && result.body.ok && result.body.failed === 0))
    assert.equal(recovered.status, 200)
    assert.equal(recovered.body.ok, true)
    assert.equal(recovered.body.failed, 0)
    assert.equal(sql(`SELECT status FROM nominations WHERE id=${quote(ids.badNom)}`), 'no_bid')
    assert.equal(sql(`SELECT status FROM drafts WHERE id=${quote(ids.snakeDraft)}`), 'paused')
    assert.equal(Number(sql(`SELECT current_nomination_order FROM drafts WHERE id=${quote(ids.badDraft)}`)), orderBefore + 1)
    assert.equal(sql(`SELECT count(*) FROM draft_audit_logs WHERE draft_id=${quote(ids.snakeDraft)} AND action='timer_expired_pause'`), '1')
    const settled = await invoke()
    assert.equal(settled.body.checked, 0)
    const finalRuns = await get(admin.from('sync_runs').select('status,error').eq('function_name', 'close-expired-nominations').gte('started_at', started).order('started_at'))
    assert.deepEqual(finalRuns.map(run => run.status), ['failed', 'success', 'success', 'success'])
    assert.ok(finalRuns.slice(1).every(run => run.error === null))
    console.log(JSON.stringify({ case: 'concurrent recovery and idempotent empty retry', statuses: finalRuns.map(run => run.status) }))
} finally {
    removeFaults()
    sql(`DELETE FROM nominations WHERE draft_id IN (${quote(ids.goodDraft)},${quote(ids.badDraft)},${quote(ids.snakeDraft)}); DELETE FROM snake_draft_picks WHERE draft_id=${quote(ids.snakeDraft)}; DELETE FROM drafts WHERE id IN (${quote(ids.goodDraft)},${quote(ids.badDraft)},${quote(ids.snakeDraft)}); DELETE FROM leagues WHERE id=${quote(ids.league)}; DELETE FROM players WHERE id=${quote(ids.player)}; DELETE FROM sync_runs WHERE function_name='close-expired-nominations' AND started_at>=${quote(started)};`)
    if (ownerCreated) {
        const { error } = await admin.auth.admin.deleteUser(ids.user)
        if (error) throw error
    }
    assert.equal(sql(`SELECT count(*) FROM leagues WHERE id=${quote(ids.league)}`), '0')
    console.log(JSON.stringify({ cleanup: 'owned fixtures and fault triggers removed' }))
}
