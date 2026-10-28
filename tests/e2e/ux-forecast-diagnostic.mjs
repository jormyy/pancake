import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { prepareSweepFixtures } from './layout-stability-fixtures.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { stackEnvironment, requireSweepStack } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env)
assert.equal(new URL(env.E2E_SUPABASE_URL).port, '58921')
await runWithScenarioResourceOwner('Forecast diagnosis', async resourceOwner => {
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner })
    const state = fixture.state
    const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const checked = async query => { const { data, error } = await query; assert.ifError(error); return data }
    const saved = await checked(admin.from('matchup_forecasts').select('*').eq('league_id', state.leagueId))
    assert.ok(saved.length)
    try {
        const response = await fetch(`${env.E2E_SUPABASE_URL}/functions/v1/matchup-forecast`, { method: 'POST', headers: { 'x-internal-function-token': env.PANCAKE_EDGE_INTERNAL_TOKEN, 'Content-Type': 'application/json' }, body: '{}' })
        const worker = await response.json()
        const rows = await checked(admin.from('matchup_forecasts').select('forecast').eq('league_id', state.leagueId))
        await writeFile(args.output, JSON.stringify({ status: response.status, worker, forecasts: rows.map(({ forecast }) => ({ status: forecast.status, odds: forecast.teams.map(team => team.winProbability), projectedFinal: forecast.teams.map(team => team.projectedFinal), missingInputs: forecast.missingInputs.map(input => input.split(':')[0]) })) }, null, 2))
        assert.equal(response.ok, true)
    } finally {
        await checked(admin.from('matchup_forecasts').upsert(saved))
    }

})
