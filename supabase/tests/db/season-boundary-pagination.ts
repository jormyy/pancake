import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL')!
assert.ok(api && ['localhost', '127.0.0.1'].includes(new URL(api).hostname))
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { runSeasonBoundary } = await import(
  '../../functions/_shared/seasonBoundary.ts'
)
const q = async (op: any): Promise<any> => {
  const { data, error } = await op
  if (error) throw new Error(error.message)
  return data
}
const token = crypto.randomUUID().replaceAll('-', ''),
  prefix = token.slice(0, 8)
const leagues = Array.from(
  { length: 1001 },
  (_, i) =>
    `00000000-0000-4000-8000-${prefix}${i.toString(16).padStart(4, '0')}`,
)
const seasons = Array.from({ length: 1001 }, () => crypto.randomUUID())
let owner: string | undefined, year = 0, scoped = false, removeFirstPage = false
let removedLeague: string | undefined
const scans: { count: number; offset: string | null; containsLast: boolean }[] =
  []
const native = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  )
  assert.equal(url.origin, api, 'Only own local API')
  const scan = scoped && url.pathname === '/rest/v1/league_seasons' &&
    url.searchParams.get('is_current') === 'eq.true'
  if (scan) url.searchParams.set('season_year', `eq.${year}`)
  const response = await native(
    input instanceof Request ? new Request(url, input) : url,
    init,
  )
  if (scan && response.ok) {
    const rows = await response.clone().json()
    scans.push({
      count: rows.length,
      offset: url.searchParams.get('offset'),
      containsLast: rows.some((r: any) => r.league_id === leagues[1000]),
    })
    if (removeFirstPage && rows.length === 1000) {
      removeFirstPage = false
      removedLeague = rows[0].league_id
      await q(
        supabase.from('leagues').update({ status: 'setup' }).eq(
          'id',
          removedLeague!,
        ),
      )
    }
  }
  return response
}
try {
  for (let i = 0; i < 30; i++) {
    const candidate = 9000 +
      crypto.getRandomValues(new Uint32Array(1))[0] % 5000
    const rows = await q(
      supabase.from('league_seasons').select('id').eq('season_year', candidate),
    )
    const weeks = await q(
      supabase.from('season_weeks').select('id').eq('season_year', candidate),
    )
    if (!rows.length && !weeks.length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  const user = await supabase.auth.admin.createUser({
    email: `boundary-page-${token}@example.test`,
    password: `Synthetic-${crypto.randomUUID()}!`,
    email_confirm: true,
    user_metadata: {
      username: `page_${token.slice(0, 16)}`,
      display_name: 'Synthetic boundary scan',
    },
  })
  if (user.error) throw user.error
  owner = user.data.user!.id
  for (let i = 0; i < leagues.length; i += 50) {
    const ids = leagues.slice(i, i + 50)
    await q(
      supabase.from('leagues').insert(ids.map((id, j) => ({
        id,
        slug: `page-${token}-${i + j}`,
        name: 'Synthetic boundary pagination',
        commissioner_id: owner!,
        status: i + j === 1000 ? 'offseason' as const : 'setup' as const,
        playoff_start_week: 1,
      }))),
    )
    await q(
      supabase.from('league_seasons').insert(
        ids.map((id, j) => ({
          id: seasons[i + j],
          league_id: id,
          season_year: year,
          is_current: true,
        })),
      ),
    )
  }
  scoped = true
  const first = await runSeasonBoundary()
  console.log(JSON.stringify({
    case: 'eligible-after1000setup',
    scans,
    reports: first.length,
    found: first.some((r) => r.leagueId === leagues[1000]),
    fixtureIsolation:
      'only append unused synthetic season_year predicate to real league_seasons HTTP reads; real PostgREST cap and payload unchanged',
  }))
  assert.ok(
    first.some((r) => r.leagueId === leagues[1000]),
    'eligible league after1000setup seasons must be visited',
  )
  assert.ok(first.every((r) => !r.error))
  for (let i = 0; i < leagues.length; i += 50) {
    await q(
      supabase.from('leagues').update({ status: 'offseason' }).in(
        'id',
        leagues.slice(i, i + 50),
      ),
    )
  }
  scans.length = 0
  const all = await runSeasonBoundary()
  console.log(
    JSON.stringify({
      case: '1001eligible',
      scans,
      reports: all.length,
      errors: all.filter((r) => r.error),
    }),
  )
  assert.equal(all.length, 1001)
  assert.equal(new Set(all.map((r) => r.leagueId)).size, 1001)
  assert.ok(all.every((r) => !r.error))
  scans.length = 0
  removeFirstPage = true
  const changing = await runSeasonBoundary()
  console.log(JSON.stringify({
    case: 'eligibility-changes-between-pages',
    scans,
    reports: changing.length,
    removedLeague,
    missing: leagues.filter((id) => !changing.some((r) => r.leagueId === id)),
    errors: changing.filter((r) => r.error),
  }))
  assert.equal(
    changing.length,
    1001,
    'removing first-page eligibility must not skip a different league between pages',
  )
  assert.equal(new Set(changing.map((r) => r.leagueId)).size, 1001)
  assert.ok(changing.every((r) => !r.error))
  console.log(
    'PASS actual boundary visits all1001 eligible seasons with static and concurrent eligibility',
  )
} finally {
  scoped = false
  const errors: string[] = []
  for (let i = 0; i < leagues.length; i += 50) {
    try {
      await q(
        supabase.from('leagues').delete().in('id', leagues.slice(i, i + 50)),
      )
    } catch (e) {
      errors.push(String(e))
    }
  }
  if (owner) {
    const { error } = await supabase.auth.admin.deleteUser(owner)
    if (error) errors.push(error.message)
  }
  globalThis.fetch = native
  console.log(JSON.stringify({ cleanupErrors: errors }))
  assert.equal(errors.length, 0)
}
