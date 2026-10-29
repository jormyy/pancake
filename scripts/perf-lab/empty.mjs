import assert from 'node:assert/strict'
import { sql } from './database.mjs'

const missing = 'PancakeEmptyFixtureNoMatch'
const text = value => ({ text: value })

const formFields = {
  'auth-sign-in': ['Email', 'Password'],
  'auth-sign-up': ['Display name', 'Username', 'Email', 'Password'],
  'create-league': ['League name', 'Your team name'],
  'join-league': ['Invite code', 'Your team name'],
  'change-password': ['Current password', 'New password', 'Confirm new password'],
  'claim-player': ['FAAB bid amount'],
  profile: ['Display name', 'Team name'],
}

export function emptyPlan(surface) {
  const fields = formFields[surface.id]
  if (fields) return {
    kind: 'empty-form',
    expected: { all: fields.map(label => ({ value: { selector: `[aria-label=${JSON.stringify(label)}]`, equals: '' } })) },
    actions: [...(surface.id === 'profile' ? [{ tap: 'Edit' }] : []), ...fields.map(fill => ({ fill, value: '' }))], tables: [],
  }

  if (surface.id === 'rookie-draft-room') return { expected: text('No matching prospects'), actions: [{ tap: 'Show prospects' }, { fill: 'Search prospects', value: missing }], tables: [] }
  if (['players', 'players.players'].includes(surface.id)) return { expected: text(`No players match "${missing}".`), actions: [{ fill: 'Search players', value: missing }], tables: [] }
  if (['players.rankings', 'dynasty-hub'].includes(surface.id)) return { expected: text(`No ranked players match "${missing}".`), actions: [{ fill: 'Search dynasty rankings', value: missing }], tables: [] }
  if (surface.id === 'players.news') return { expected: text('No dynasty news yet.'), tables: [], globalTables: ['dynasty_news'] }
  if (surface.id === 'trades.history') return { expected: text('No completed trades yet.'), tables: [] }
  if (surface.id === 'trades.block') return { expected: { all: [text('No league listings yet.'), text('No listings yet.')] }, tables: [] }
  if (surface.id === 'league-dashboard.history') return { expected: text('No transactions yet.'), tables: ['league_activity', 'roster_transactions'] }
  if (surface.id === 'players.waivers') return { expected: { all: [text('No pending claims.'), text('No recent results.')] }, tables: ['waiver_claims'] }
  if (surface.id === 'league-dashboard.picks') return { expected: text('No picks assigned to you yet.'), tables: [], movePicks: true }
  if (surface.id === 'trades.analyzer') return { expected: text('Choose a team.'), tables: [] }
  if (surface.id === 'propose-trade') return { expected: { all: [text('Choose a team.'), { selector: '[aria-label="Review trade proposal"][aria-disabled="true"]' }] }, tables: [] }
  if (['playoff-bracket', 'league-dashboard.bracket'].includes(surface.id)) return { expected: text('No playoff bracket yet'), tables: [] }
  if (surface.id === 'team-timeline') return {
    expected: { any: [text('No matching activity on this page. Load older activity to continue.'), text('No activity here yet. Team results appear here when they happen.')] },
    actions: [{ open: `/timeline?entityId=${missing}` }], tables: [],
  }
  return null
}

export async function withEmptyState(surface, fixture, variables, action, execute = sql) {
  const plan = emptyPlan(surface)
  assert.ok(plan, `Empty-state fixture is not implemented for ${surface.id}`)
  for (const id of [fixture.leagueId, variables.memberId, variables.otherMemberId]) assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)
  assert.ok(fixture.members.some(row => row.id === variables.memberId), 'Empty state must use a fixture member')
  const saved = []
  let picks
  try {
    for (const table of [...plan.tables, ...(plan.globalTables ?? [])]) {
      const global = plan.globalTables?.includes(table)
      if (global) assert.equal(table, 'dynasty_news', 'Only the news fixture can clear a global table')
      const where = global ? 'true' : `league_id='${fixture.leagueId}'${table === 'waiver_claims' ? ` AND member_id='${variables.memberId}'` : ''}`
      const rows = JSON.parse(await execute(`SELECT coalesce(jsonb_agg(t),'[]') FROM public.${table} t WHERE ${where}`))
      saved.push({ table, rows })
      await execute(`DELETE FROM public.${table} WHERE ${where}`)
      assert.equal(Number(await execute(`SELECT count(*) FROM public.${table} WHERE ${where}`)), 0, 'Empty fixture must remove all scoped rows')
    }
    if (plan.movePicks) {
      picks = JSON.parse(await execute(`SELECT coalesce(jsonb_agg(t),'[]') FROM (SELECT id,current_owner_id FROM public.draft_picks WHERE league_id='${fixture.leagueId}' AND current_owner_id='${variables.memberId}') t`))
      await execute(`UPDATE public.draft_picks SET current_owner_id='${variables.otherMemberId}' WHERE league_id='${fixture.leagueId}' AND current_owner_id='${variables.memberId}'`)
    }
    return await action({ ...plan, evidence: { tables: saved.map(row => ({ table: row.table, removed: row.rows.length })), movedPicks: picks?.length ?? 0, query: plan.actions?.[0]?.value ?? null } })
  } finally {
    if (picks?.length) await execute(`UPDATE public.draft_picks p SET current_owner_id=s.current_owner_id FROM jsonb_populate_recordset(NULL::public.draft_picks,'${JSON.stringify(picks)}'::jsonb) s WHERE p.id=s.id AND p.league_id='${fixture.leagueId}'`)
    for (const { table, rows } of saved.reverse()) if (rows.length) await execute(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_recordset(NULL::public.${table},'${JSON.stringify(rows).replaceAll("'", "''")}'::jsonb) ON CONFLICT DO NOTHING`)
  }
}
