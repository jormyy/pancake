import { strict as assert } from 'node:assert'
import { sourceHeightInches, sourceWeightPounds } from '../_shared/playerSourceDetails.ts'
import { espnSizeRecords, indexDraftRecords, profileDraftStatus, verifyUndraftedProfiles } from './listedDetails.ts'

Deno.test('ESPN size keeps only listed values and drops implausible ones', () => {
  assert.equal(sourceHeightInches(80), 80)
  assert.equal(sourceHeightInches(80.0), 80)
  assert.equal(sourceHeightInches(80.5), null)
  assert.equal(sourceHeightInches(0), null)
  assert.equal(sourceWeightPounds('222'), 222)
  assert.equal(sourceWeightPounds(null), null)
  assert.deepEqual(espnSizeRecords([
    { espn_id: '5231919', height_inches: 80, weight_lb: 222 },
    { espn_id: '1', height_inches: 79, weight_lb: null },
    { espn_id: '2', height_inches: null, weight_lb: null },
  ]), [{ provider_id: '5231919', height_inches: 80, weight_lb: 222 }, { provider_id: '1', height_inches: 79 }])
})

Deno.test('NBA index draft rows are drafted only when complete and unlisted only when all blank', () => {
  const headers = ['PERSON_ID', 'DRAFT_YEAR', 'DRAFT_ROUND', 'DRAFT_NUMBER']
  const result = indexDraftRecords(headers, [
    [1643510, 2026, 1, 21],
    [1630559, null, null, null],
    [9, 2020, null, 12],
    [1643510, 2025, 2, 40],
  ])
  assert.deepEqual(result.drafted, [{ provider_id: '1643510', draft_year: 2026, draft_round: 1, draft_overall_pick: 21 }])
  assert.deepEqual(result.unlisted, ['1630559'])
  assert.deepEqual(indexDraftRecords(['PERSON_ID'], [[1]]), { drafted: [], unlisted: [] })
})

Deno.test('a profile verifies undrafted only when every draft field says so', () => {
  assert.equal(profileDraftStatus({ DRAFT_YEAR: 'Undrafted', DRAFT_ROUND: 'Undrafted', DRAFT_NUMBER: 'Undrafted' }), 'undrafted')
  assert.equal(profileDraftStatus({ DRAFT_YEAR: 'Undrafted', DRAFT_ROUND: null, DRAFT_NUMBER: null }), null)
  assert.equal(profileDraftStatus({ DRAFT_YEAR: '2024', DRAFT_ROUND: '2', DRAFT_NUMBER: '39' }), 'drafted')
  assert.equal(profileDraftStatus(null), null)
})

Deno.test('profile checks send verified undrafted players only and stop when limited', async () => {
  const page = (info: unknown) => new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { player: { info } } } })}</script>`)
  const pages: Record<string, () => Response> = {
    '1630559': () => page({ PERSON_ID: 1630559, DRAFT_YEAR: 'Undrafted', DRAFT_ROUND: 'Undrafted', DRAFT_NUMBER: 'Undrafted' }),
    '2': () => page({ PERSON_ID: 2, DRAFT_YEAR: null, DRAFT_ROUND: null, DRAFT_NUMBER: null }),
    '3': () => page({ PERSON_ID: 99, DRAFT_YEAR: 'Undrafted', DRAFT_ROUND: 'Undrafted', DRAFT_NUMBER: 'Undrafted' }),
    '4': () => new Response('', { status: 429 }),
  }
  const calls: unknown[] = []
  const db = { rpc: (name: string, args: unknown) => { calls.push([name, args]); return Promise.resolve({ data: { matched: 1, updated: 1, conflicts: 0, missing: [] }, error: null }) } }
  const fetcher = (input: string | URL | Request) => Promise.resolve(pages[String(input).split('/')[4]]())
  const result = await verifyUndraftedProfiles(db as never, ['1630559', '2', '3', '4', '5'].map(nba_id => ({ nba_id, display_name: 'Name' })), 10000,
    { intervalMs: 0, fetcher: fetcher as never })
  assert.deepEqual(calls, [['apply_player_listed_details', { p_source: 'nba_profile', p_records: [{ provider_id: '1630559', draft_status: 'undrafted' }] }]])
  assert.equal(result.verified, 1)
  assert.equal(result.updated, 1)
  assert.equal(result.failures.length, 2)
  assert.ok(result.failures.some(failure => failure.includes('identity mismatch')))
  assert.ok(result.failures.some(failure => failure.includes('NBA profile 429')))
})
