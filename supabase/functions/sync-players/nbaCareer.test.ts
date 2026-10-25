import { strict as assert } from 'node:assert'

Deno.env.set('NBA_COM_BASE_URL', 'http://nba.invalid')
const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/nba-profile-beringer.json', import.meta.url)))
const { fetchNbaCareerProfile } = await import('./nbaCareer.ts')

async function profile(info: Record<string, unknown> | null) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response(info === null ? '<html>Unavailable</html>'
    : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { player: { info } } } })}</script>`))
  try {
    return await fetchNbaCareerProfile('1642866', new Date('2025-10-25T16:00:00Z'))
  } finally {
    globalThis.fetch = originalFetch
  }
}

Deno.test('NBA person data supplies experience independently of ESPN and verifies no-debut flags', async () => {
  const info = fixture.props.pageProps.player.info
  assert.deepEqual(await profile(info), { years: 1, noGames: false })
  assert.deepEqual(await profile({ ...info, SEASON_EXP: undefined }), { years: 0, noGames: false })
  assert.deepEqual(await profile({ ...info, SEASON_EXP: undefined, FROM_YEAR: undefined, GAMES_PLAYED_FLAG: 'N' }), { years: 0, noGames: true })
})

Deno.test('NBA profile identity mismatches and missing data never supply player facts', async () => {
  await assert.rejects(() => profile({ ...fixture.props.pageProps.player.info, PERSON_ID: 2544 }), /identity mismatch/)
  await assert.rejects(() => profile(null), /no player data/)
})
