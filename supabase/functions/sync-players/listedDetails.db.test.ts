import { strict as assert } from 'node:assert'

Deno.test({
  name: 'listed size and draft details rerun, keep partial values and separate verified undrafted from unknown',
  ignore: Deno.env.get('PANCAKE_DATA_DB_TESTS') !== '1',
  fn: async () => {
    const api = new URL(Deno.env.get('SUPABASE_URL')!)
    assert.ok(['localhost', '127.0.0.1'].includes(api.hostname), 'Use a private local stack')
    const { supabase } = await import('../_shared/supabase.ts')
    const { applyListedDetails } = await import('./listedDetails.ts')
    const base = 900000000 + Math.floor(Math.random() * 90000000)
    const ids = { drafted: String(base), undrafted: String(base + 1), unknown: String(base + 2) }
    const columns = 'height_inches, weight_lb, draft_status, draft_year, draft_round, draft_overall_pick'
    const read = async (nba: string) => {
      const { data, error } = await supabase.from('players').select(columns).eq('nba_id', nba).single()
      assert.ifError(error)
      return data
    }
    const inserted = await supabase.from('players').insert(Object.entries(ids).map(([kind, id]) => ({
      first_name: 'Listed', last_name: `${kind} ${id}`, espn_id: id, nba_id: id,
    }))).select('id')
    assert.ifError(inserted.error)
    try {
      const size = await applyListedDetails(supabase, 'espn', [{ provider_id: ids.drafted, height_inches: 80, weight_lb: 222 }])
      assert.deepEqual(size, { matched: 1, updated: 1, conflicts: 0, missing: [] })
      assert.equal((await applyListedDetails(supabase, 'espn', [{ provider_id: ids.drafted, height_inches: 80, weight_lb: 222 }])).updated, 0)
      const partial = await applyListedDetails(supabase, 'espn', [{ provider_id: ids.drafted, height_inches: 81 }, { provider_id: String(base + 3), weight_lb: 200 }])
      assert.deepEqual(partial, { matched: 1, updated: 1, conflicts: 0, missing: [String(base + 3)] })
      console.log('PASS: size writes once, reruns change nothing, a partial record keeps the stored weight and unknown ids are reported')

      const draft = { provider_id: ids.drafted, draft_year: 2026, draft_round: 1, draft_overall_pick: 21 }
      assert.equal((await applyListedDetails(supabase, 'nba_index', [draft])).updated, 1)
      assert.equal((await applyListedDetails(supabase, 'nba_index', [draft])).updated, 0)
      const undrafted = await applyListedDetails(supabase, 'nba_profile', [ids.undrafted, ids.drafted].map(provider_id => ({ provider_id, draft_status: 'undrafted' as const })))
      assert.deepEqual(undrafted, { matched: 2, updated: 1, conflicts: 1, missing: [] })
      assert.deepEqual(await read(ids.drafted), { height_inches: 81, weight_lb: 222, draft_status: 'drafted', draft_year: 2026, draft_round: 1, draft_overall_pick: 21 })
      assert.deepEqual(await read(ids.undrafted), { height_inches: null, weight_lb: null, draft_status: 'undrafted', draft_year: null, draft_round: null, draft_overall_pick: null })
      assert.deepEqual(await read(ids.unknown), { height_inches: null, weight_lb: null, draft_status: null, draft_year: null, draft_round: null, draft_overall_pick: null })
      console.log('PASS: index draft is idempotent, a profile marks only an unknown player undrafted and never overrides a draft, unknown stays empty')

      const shape = await supabase.from('players').update({ draft_status: 'drafted' }).eq('nba_id', ids.unknown)
      assert.equal(shape.error?.code, '23514')
      const field = await supabase.rpc('apply_player_listed_details', { p_source: 'espn', p_records: [{ provider_id: ids.drafted, draft_year: 2026 }] })
      assert.equal(field.error?.code, '22023')
      const range = await supabase.rpc('apply_player_listed_details', { p_source: 'espn', p_records: [{ provider_id: ids.drafted, height_inches: 20 }] })
      assert.equal(range.error?.code, '23514')
      assert.equal((await read(ids.drafted))?.height_inches, 81)
      console.log('PASS: a drafted status without its pick, a foreign field and an impossible height are refused without changing stored values')
    } finally {
      await supabase.from('players').delete().in('nba_id', Object.values(ids))
    }
  },
})
