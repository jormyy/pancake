import assert from 'node:assert/strict'
import { sql } from './database.mjs'

const quote = value => `'${String(value).replaceAll("'", "''")}'`

export async function changeForScreen(surface, fixture, variables, { execute = sql, verify = async expected => { void expected } } = {}) {
  const base = surface.id.split('.')[0]
  const teamScreens = ['other-matchup', 'matchup-home', 'propose-trade', 'team-timeline']
  if (base === 'team-roster') return changeRoster(fixture, variables, execute, verify)
  const team = teamScreens.includes(base)
  assert.ok(!['auth-sign-in', 'auth-sign-up', 'change-password', 'create-league', 'join-league', 'not-found'].includes(base), 'This static form has no server-change content adapter')
  const table = team ? 'league_members' : 'leagues'
  const field = team ? 'team_name' : 'name'
  const id = team ? variables.memberId : fixture.leagueId
  assert.match(id, /^[a-f\d-]{36}$/i)
  const previous = await execute(`SELECT ${field} FROM ${table} WHERE id=${quote(id)}`)
  await verify({ text: previous })
  const next = `${previous} refreshed`
  await execute(`UPDATE ${table} SET ${field}=${quote(next)} WHERE id=${quote(id)}`, { measured: true })
  return { expected: { text: next }, evidence: { table, field, previous, next }, undo: () => execute(`UPDATE ${table} SET ${field}=${quote(previous)} WHERE id=${quote(id)}`) }
}

async function changeRoster(fixture, variables, execute, verify) {
  for (const id of [fixture.leagueId, variables.otherMemberId]) assert.match(id, /^[a-f\d-]{36}$/i)
  const row = JSON.parse(await execute(`SELECT row_to_json(r) FROM roster_players r WHERE league_id=${quote(fixture.leagueId)} AND member_id=${quote(variables.otherMemberId)} AND NOT is_on_ir AND NOT is_on_taxi ORDER BY id LIMIT 1`))
  assert.ok(row?.id, 'Server-change fixture needs an active roster player')
  const name = await execute(`SELECT display_name FROM players WHERE id=${quote(row.player_id)} AND sportsdata_id LIKE 'ios-sim-%'`)
  assert.ok(name, 'Server-change fixtures can rename only synthetic players')
  await verify({ text: name })
  const next = `${name} refreshed`
  await execute(`UPDATE players SET display_name=${quote(next)} WHERE id=${quote(row.player_id)}`, { measured: true })
  return { expected: { text: next }, evidence: { table: 'players', field: 'display_name', playerId: row.player_id, previous: name, next },
    undo: () => execute(`UPDATE players SET display_name=${quote(name)} WHERE id=${quote(row.player_id)}`) }
}
