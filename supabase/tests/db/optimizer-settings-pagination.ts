import { strict as assert } from 'node:assert'
import { loadEnabledOptimizerSettings } from '../../functions/lineup-optimizer/settings.ts'

const api = Deno.env.get('SUPABASE_URL')!
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const { supabase } = await import('../../functions/_shared/supabase.ts')
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const token = crypto.randomUUID().replaceAll('-', '')
const leagues = Array.from({ length: 1003 }, (_, index) =>
  `00000000-0000-4000-8000-${token.slice(0, 8)}${index.toString(16).padStart(4, '0')}`)
const seasons = leagues.map(() => crypto.randomUUID())
const members = leagues.map(() => crypto.randomUUID())
const nativeFetch = globalThis.fetch.bind(globalThis)
const pages: number[] = []
let owner: string | undefined, year = 0, observe = false, failNextPage = false, disableFirst = false
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api, 'Only the explicitly configured local API is allowed')
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const scan = observe && method === 'GET' && url.pathname === '/rest/v1/lineup_optimizer_settings'
  if (scan && url.searchParams.has('or') && failNextPage) {
    failNextPage = false
    throw new Error('Owned second-page transport failure')
  }
  const response = await nativeFetch(input, init)
  if (scan && response.ok) {
    const rows = await response.clone().json()
    pages.push(rows.length)
    if (disableFirst && rows.length === 1000) {
      disableFirst = false
      await q(supabase.from('lineup_optimizer_settings').update({ enabled: false })
        .eq('league_id', leagues[0]).eq('league_season_id', seasons[0]).eq('member_id', members[0]))
    }
  }
  return response
}
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = 8000 + crypto.getRandomValues(new Uint32Array(1))[0] % 1000
    if (!(await q(supabase.from('league_seasons').select('id').in('season_year', [candidate, candidate + 1]))).length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  const account = await supabase.auth.admin.createUser({
    email: `optimizer-page-${token}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`,
    email_confirm: true, user_metadata: { display_name: 'Synthetic optimizer page' },
  })
  if (account.error) throw account.error
  owner = account.data.user!.id
  for (let offset = 0; offset < leagues.length; offset += 50) {
    const ids = leagues.slice(offset, offset + 50)
    await q(supabase.from('leagues').insert(ids.map((id, index) => ({
      id, slug: `optimizer-page-${token}-${offset + index}`, name: 'Synthetic optimizer pagination',
      commissioner_id: owner!, status: offset + index === 1001 ? 'setup' as const : 'active' as const,
    }))))
    await q(supabase.from('league_members').insert(ids.map((league_id, index) => ({
      id: members[offset + index], league_id, user_id: owner!, role: 'commissioner' as const,
    }))))
    await q(supabase.from('league_seasons').insert(ids.map((league_id, index) => ({
      id: seasons[offset + index], league_id, is_current: true,
      season_year: offset + index === 1002 ? year + 1 : year,
    }))))
    await q(supabase.from('lineup_optimizer_settings').insert(ids.map((league_id, index) => ({
      league_id, league_season_id: seasons[offset + index], member_id: members[offset + index], enabled: true,
      last_optimized_at: offset + index === 1000 ? null
        : new Date(Date.UTC(2025, 0, 1) - (offset + index) * 60_000).toISOString(),
    }))))
  }
  observe = true
  const all = await loadEnabledOptimizerSettings(supabase, [year])
  assert.equal(all.length, 1001)
  assert.equal(new Set(all.map((setting) => setting.league_id)).size, 1001)
  assert.equal(all[0].league_id, leagues[1000], 'Untouched setting on the second page gets first priority')
  assert.deepEqual(all.map((setting) => setting.league_id), leagues.slice(0, 1001).reverse(),
    'Never-attempted settings precede all dated settings, then oldest attempts run first across both pages')
  assert.ok(all.every((setting) => setting.league_id !== leagues[1001] && setting.league_id !== leagues[1002]))
  assert.deepEqual(pages, [1000, 1], 'Actual PostgREST pages include the tail beyond its row cap')
  console.log(JSON.stringify({ case: '1001-current-eligible-plus-ineligible', settings: all.length, pages, tailFirst: true }))
  pages.length = 0
  failNextPage = true
  await assert.rejects(() => loadEnabledOptimizerSettings(supabase, [year]), (error: unknown) =>
    typeof error === 'object' && error !== null && 'message' in error
      && String(error.message).includes('Owned second-page transport failure'))
  console.log(JSON.stringify({ case: 'second-page-failure-rejects-incomplete-work', pages }))
  pages.length = 0
  disableFirst = true
  const changed = await loadEnabledOptimizerSettings(supabase, [year])
  assert.equal(changed.length, 1001, 'Removing a first-page setting does not move the next page past the tail')
  assert.ok(changed.some((setting) => setting.league_id === leagues[1000]))
  assert.deepEqual(pages, [1000, 1])
  console.log(JSON.stringify({ case: 'retry-and-concurrent-first-page-opt-out', settings: changed.length, pages }))
  pages.length = 0
  const next = await loadEnabledOptimizerSettings(supabase, [year])
  assert.equal(next.length, 1000)
  assert.ok(next.every((setting) => setting.league_id !== leagues[0]))
  assert.deepEqual(pages, [1000, 0])
  console.log(JSON.stringify({ case: 'next-run-respects-opt-out', settings: next.length, pages }))
} finally {
  observe = false
  globalThis.fetch = nativeFetch
  for (let offset = 0; offset < leagues.length; offset += 50) {
    await q(supabase.from('leagues').delete().in('id', leagues.slice(offset, offset + 50)))
  }
  if (owner) {
    const result = await supabase.auth.admin.deleteUser(owner)
    if (result.error) throw result.error
  }
  for (let offset = 0; offset < leagues.length; offset += 50) {
    assert.deepEqual(await q(supabase.from('leagues').select('id').in('id', leagues.slice(offset, offset + 50))), [])
  }
  console.log('Owned optimizer pagination fixtures removed; native transport restored.')
}
