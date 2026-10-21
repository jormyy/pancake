import assert from 'node:assert/strict'
import { fixture, literal, sql, type Rookie, type Identity } from './identity-db.ts'

assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated identity stack')
const origin = 'http://127.0.0.1:57780'
Deno.env.set('NBA_COM_BASE_URL', origin)
Deno.env.set('NBA_CDN_BASE_URL', origin)
const article = await Deno.readFile(new URL('../../../tests/fixtures/identity/draft-2025.html', import.meta.url))
const index = await Deno.readFile(new URL('../../../tests/fixtures/identity/player-index.json', import.meta.url))
const requested: string[] = []
const server = Deno.serve({ hostname: '127.0.0.1', port: 57780, onListen: () => undefined }, request => {
  const path = new URL(request.url).pathname
  requested.push(path)
  if (path === '/news/2025-nba-draft-order') return new Response(article)
  if (path === '/staticData/playerIndex.json') return new Response(index)
  return new Response('Unknown pinned source', { status: 404 })
})
const { syncDraftOrder } = await import('../../functions/sync-draft-order/lib.ts')
const { loadCdnPlayerResolver, resolveCdnPlayers } = await import('../../functions/_shared/playerResolver.ts')
const { syncNBAIds } = await import('../../functions/sync-players/nbaIds.ts')
const { picks } = await fixture<{ picks: Rookie[] }>('rookies-2025.json')
const { players: veterans } = await fixture<{ players: (Identity & { personId: string; team: string })[] }>('veterans-2024.json')
let owned: string[] = []
try {
  await sql(`INSERT INTO players(first_name,last_name,nba_id,nba_team,years_exp)
    SELECT r->>'firstName',r->>'familyName',r->>'personId',r->>'team',1
    FROM jsonb_array_elements(${literal(JSON.stringify(veterans))}::jsonb) r`)
  const imported = await syncDraftOrder(2025, new Date('2025-07-01T12:00:00Z'))
  assert.equal(imported.draftPickCount, 59)
  assert.deepEqual(imported.unmatched, [])
  const board: { id: string; nba_draft_number: number; display_name: string }[] = JSON.parse(
    await sql('SELECT jsonb_agg(to_jsonb(p)) FROM players p WHERE nba_draft_number IS NOT NULL'))
  assert.equal(board.length, 59)
  const byPick = new Map(board.map(player => [player.nba_draft_number, player.id]))
  const resolver = await loadCdnPlayerResolver()
  const games = new Map<string, Rookie[]>()
  for (const pick of picks) {
    if (!pick.personId) continue
    assert.ok(pick.identities?.length)
    for (const identity of pick.identities) {
      assert.ok(identity.firstName && identity.familyName)
      const incoming: (Identity & { personId: string; displayName: string })[] = [{ ...identity, personId: pick.personId, displayName: identity.name }]
      assert.deepEqual(await resolveCdnPlayers(resolver, incoming), [byPick.get(pick.pick)])
    }
    for (const game of pick.games ?? []) games.set(game.gameId, [...games.get(game.gameId) ?? [], pick])
  }
  let appearances = 0
  for (const [gameId, rookies] of games) {
    const actual = await resolveCdnPlayers(resolver, rookies.map(pick => ({ ...pick.identities![0], personId: pick.personId!, displayName: pick.identities![0].name })))
    assert.deepEqual(actual, rookies.map(pick => byPick.get(pick.pick)), `Identity changes in ${gameId}`)
    appearances += actual.length
  }
  const canonical: { id: string; nba_id: string | null; nba_draft_number: number | null }[] = JSON.parse(
    await sql('SELECT jsonb_agg(to_jsonb(p)) FROM players p'))
  owned = canonical.map(player => player.id)
  assert.equal(canonical.length, veterans.length + 59, 'A rookie import creates a duplicate')
  for (const pick of picks.filter(pick => pick.personId)) {
    const rows = canonical.filter(player => player.nba_id === pick.personId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, byPick.get(pick.pick))
    assert.equal(rows[0].nba_draft_number, pick.pick)
  }
  const report = ['pick\tboard_name\tbox_name\tpersonId\tplayer_row_id\tfirst_game\tgames_found\tgames_played']
  const never = ['pick\tboard_name\tbox_name\tpersonId\treason']
  for (const pick of picks) {
    const played = pick.games?.filter(game => game.played === '1') ?? []
    const identity = pick.identities?.[0]
    if (!played.length) never.push([pick.pick, pick.name, identity?.name ?? '', pick.personId ?? '', pick.games?.length ? 'DNP only' : 'No box-score identity found'].join('\t'))
    else report.push([pick.pick, pick.name, identity!.name, pick.personId, byPick.get(pick.pick), played[0].gameId, pick.games!.length, played.length].join('\t'))
  }
  await Deno.writeTextFile('evidence/rookies.tsv', report.join('\n') + '\n')
  await Deno.writeTextFile('evidence/never-played.tsv', never.join('\n') + '\n')
  await sql(`UPDATE players SET nba_id=NULL WHERE id IN (${board.map(player => literal(player.id)).join(',')})`)
  const mapped = await syncNBAIds()
  assert.deepEqual(mapped.failures, [])
  const indexRows: { id: string; nba_id: string | null }[] = JSON.parse(await sql(
    'SELECT jsonb_agg(to_jsonb(p)) FROM players p WHERE nba_draft_number IS NOT NULL'))
  const unavailable = picks.filter(pick => !indexRows.find(row => row.id === byPick.get(pick.pick))?.nba_id)
  for (const pick of picks.filter(pick => pick.personId && !unavailable.includes(pick))) {
    assert.equal(indexRows.find(row => row.id === byPick.get(pick.pick))?.nba_id, pick.personId)
  }
  assert.deepEqual(requested, ['/news/2025-nba-draft-order', '/staticData/playerIndex.json'])
  console.log(JSON.stringify({ provenance: 'REAL-DERIVED', veterans: veterans.length, draftPicks: picks.length,
    playedRookies: report.length - 1, neverPlayed: never.length - 1, boxAppearancesResolved: appearances,
    gamesResolved: games.size, indexMapped: mapped.mapped, indexUnavailable: unavailable.map(pick => pick.name),
    duplicates: 0, unresolvedReceipts: mapped.failures, firstBoxLinksInPlace: true }))
} finally {
  if (!owned.length) owned = JSON.parse(await sql("SELECT coalesce(jsonb_agg(id),'[]') FROM players"))
  if (owned.length) await sql(`DELETE FROM players WHERE id IN (${owned.map(literal).join(',')})`)
  await server.shutdown()
}
