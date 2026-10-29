import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableup"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:62821')
const source = await readFile('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
const document = JSON.parse(source)
const players = JSON.parse(execFileSync('docker', ['exec', 'supabase_db_pt4bafableup', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-c', 'SELECT json_agg(json_build_object(\'id\',id,\'name\',display_name)) FROM public.players;'], { encoding: 'utf8' }))
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
const rows = document.data.filter(row => row.pos !== 'PICK').map(row => {
    const matches = players.filter(player => normalize(player.name) === normalize(row.player))
    return { source_id: row.id, name: row.player, team: row.team, positions: row.posArray, rank: row.rank,
        value: row.value / 10, age: row.age, player_id: matches.length === 1 ? matches[0].id : null,
        reason: 'Local repository fixture', candidate_ids: matches.map(player => player.id) }
})
const picks = document.data.filter(row => row.pos === 'PICK').map(row => ({ year: Number(row.id.slice(0, 4)), round: row.id.includes('1st') ? 1 : 2, tier: row.id.match(/early|mid|late/)[0], value: row.value / 10 }))
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const result = await admin.rpc('publish_trade_values', { p_rows: rows, p_picks: picks, p_source_body: source, p_fetched_at: new Date().toISOString(), p_mode: 'json' })
assert.ifError(result.error)
console.log(JSON.stringify({ fixture: 'tests/fixtures/trade-values/onenumberhoops.json', result: result.data }))
