import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api)
  return nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
async function query<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}

try {
  for (const [weekStart, before, after] of [
    ['2026-03-09', '2026-03-09T03:30:00Z', '2026-03-09T04:01:00Z'],
    ['2026-11-02', '2026-11-02T04:30:00Z', '2026-11-02T05:01:00Z'],
    ['2027-01-01', '2027-01-01T04:30:00Z', '2027-01-01T05:01:00Z'],
  ]) {
    const token = crypto.randomUUID().replaceAll('-', '')
    const league = crypto.randomUUID(), season = crypto.randomUUID()
    const members = [crypto.randomUUID(), crypto.randomUUID()]
    const players = Array.from({ length: 6 }, () => crypto.randomUUID())
    const users: string[] = []
    let year = 0
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = 9000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
        const weeks = await query(supabase.from('season_weeks').select('id').eq('season_year', candidate))
        const seasons = await query(supabase.from('league_seasons').select('id').eq('season_year', candidate))
        if (!weeks?.length && !seasons?.length) { year = candidate; break }
      }
      assert.ok(year)
      for (let side = 0; side < 2; side++) {
        const { data, error } = await supabase.auth.admin.createUser({
          email: `boundary-et-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
          user_metadata: { username: `et_${token.slice(0, 16)}_${side}`, display_name: 'Synthetic ET boundary' },
        })
        if (error) throw error
        assert.ok(data.user)
        users.push(data.user.id)
      }
      await query(supabase.from('leagues').insert({ id: league, slug: `et-${token}`, name: 'Synthetic ET boundary', commissioner_id: users[0], status: 'offseason', playoff_start_week: 1 }))
      await query(supabase.from('league_members').insert(users.map((user_id, side) => ({
        id: members[side], league_id: league, user_id, role: side ? 'manager' as const : 'commissioner' as const, team_name: `ET ${side}`,
      }))))
      await query(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
      await query(supabase.from('season_weeks').insert({ season_year: year, week_number: 1, week_start: weekStart, week_end: weekStart }))
      await query(supabase.from('draft_picks').insert(members.flatMap(member => [1, 2, 3].map(round => ({
        league_id: league, season_year: year, round, original_owner_id: member, current_owner_id: member,
      })))))
      await query(supabase.from('players').insert(players.map((id, index) => ({
        id, first_name: 'Synthetic', last_name: `ET rookie ${token} ${index}`,
        position: 'PG' as const, eligible_positions: ['PG'], nba_team: null, years_exp: 0, nba_draft_number: index + 1,
      }))))
      const early = await runSeasonBoundary(new Date(before), league)
      const draftsBefore = await query(supabase.from('drafts').select('id').eq('league_id', league))
      console.log(JSON.stringify({ case: 'manual evening ET', weekStart, reference: before, report: early, drafts: draftsBefore?.length }))
      assert.equal(early.length, 1)
      assert.equal(early[0].error, undefined)
      assert.deepEqual(early[0].actions, [])
      assert.equal(draftsBefore?.length, 0, 'UTC midnight must not start a draft during the previous ET day')
      const due = await runSeasonBoundary(new Date(after), league)
      const draftsAfter = await query(supabase.from('drafts').select('id,status').eq('league_id', league))
      assert.equal(due[0]?.error, undefined)
      assert.ok(due[0]?.actions.includes('rookie-draft-started'))
      assert.ok(draftsAfter)
      assert.equal(draftsAfter.length, 1)
      const picks = await query(supabase.from('snake_draft_picks').select('player_id').eq('draft_id', draftsAfter[0].id))
      assert.ok(picks)
      assert.equal(picks.length, 6)
      assert.ok(picks.every(pick => pick.player_id != null))
      console.log(JSON.stringify({ case: 'ET midnight reached', weekStart, reference: after, actions: due[0].actions }))
    } finally {
      const drafts = await query(supabase.from('drafts').select('id').eq('league_id', league))
      if (drafts?.length) {
        const ids = drafts.map(draft => draft.id)
        await query(supabase.from('snake_draft_picks').delete().in('draft_id', ids))
        await query(supabase.from('nominations').delete().in('draft_id', ids))
        await query(supabase.from('draft_picks').delete().eq('league_id', league))
        await query(supabase.from('drafts').delete().in('id', ids))
      }
      await query(supabase.from('leagues').delete().eq('id', league))
      await query(supabase.from('players').delete().in('id', players))
      assert.equal((await query(supabase.from('players').select('id').in('id', players)))?.length, 0)
      if (year) await query(supabase.from('season_weeks').delete().eq('season_year', year))
      for (const user of users) {
        const { error } = await supabase.auth.admin.deleteUser(user)
        if (error) throw error
      }
      console.log(JSON.stringify({ cleanup: 'owned ET boundary fixture removed', weekStart }))
    }
  }
} finally {
  globalThis.fetch = nativeFetch
}
