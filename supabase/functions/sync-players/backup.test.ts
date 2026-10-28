import { strict as assert } from 'node:assert'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

Deno.test({
  name: 'the complete player worker finishes the backup and preserves source birthdates',
  ignore: !Deno.env.get('PLAYER_SYNC_BACKUP_DIR'),
  fn: async () => {
    const [evidence, statusFile, output] = [process.env.PLAYER_SYNC_BACKUP_DIR, process.env.PLAYER_SYNC_STATUS_FILE, process.env.PLAYER_SYNC_REPORT]
    assert.ok(evidence && statusFile && output, 'Provide fixture directory, local status file and report path')
    const status = Object.fromEntries((await readFile(statusFile, 'utf8')).split('\n').flatMap(line => {
      const match = line.match(/^([A-Z_]+)="(.*)"$/)
      return match ? [[match[1], match[2]]] : []
    }))
    const databaseUrl = new URL(status.API_URL)
    assert.equal(databaseUrl.hostname, '127.0.0.1')
    assert.equal(databaseUrl.port, process.env.PANCAKE_TEST_API_PORT ?? '57021')
    const espn: { espn_id: string; first_name: string; last_name: string; nba_team: string; birthdate: string | null; position: string | null; years_exp: number | null; status: string }[] = JSON.parse(await readFile(path.join(evidence, 'espn-listing.json'), 'utf8')).records
    const nba = JSON.parse(await readFile(path.join(evidence, 'nba-index.json'), 'utf8'))
    const sleeper: Record<string, { birth_date?: string }> = JSON.parse(await readFile(path.join(evidence, 'sleeper-players.json'), 'utf8'))
    const profileDates: Record<string, string> = JSON.parse(await readFile(path.join(evidence, 'profile-birthdates.json'), 'utf8').catch(() => '{}'))
    const live = process.env.SYNC_TEST_LIVE_SOURCES === '1'
    for (const [key, value] of Object.entries({ SUPABASE_URL: databaseUrl.href.replace(/\/$/, ''),
      PANCAKE_SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY ?? status.SECRET_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-player-sync',
      ESPN_SITE_BASE_URL: live ? 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba' : 'http://source.invalid/espn',
      NBA_CDN_BASE_URL: live ? 'https://cdn.nba.com/static/json' : 'http://source.invalid/nba',
      SLEEPER_BASE_URL: live ? 'https://api.sleeper.app/v1' : 'http://source.invalid/sleeper',
      ESPN_CAREER_BASE_URL: live ? 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba' : 'http://source.invalid/career',
      ESPN_SEARCH_BASE_URL: live ? 'https://site.web.api.espn.com/apis/common/v3/search' : 'http://source.invalid/search',
      NBA_COM_BASE_URL: live ? 'https://www.nba.com' : 'http://source.invalid/profile',
    })) { assert.ok(value, `Missing ${key}`); process.env[key] = value }
    const teams = [...new Set(espn.map(row => row.nba_team))]
    const fetch = globalThis.fetch
    const counts: Record<string, number> = {}
    const nbaBatches: string[][] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      counts[url.pathname] = (counts[url.pathname] ?? 0) + 1
      if (url.origin === databaseUrl.origin) {
        if (url.pathname.endsWith('/link_player_sources_atomic')) {
          const body = await request.clone().json()
          if (body.p_source === 'nba') {
            nbaBatches.push(body.p_records.map((row: { provider_id: string }) => row.provider_id))
            if (nbaBatches.length === Number(process.env.SYNC_TEST_FAIL_NBA_BATCH)) {
              return Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 })
            }
          }
        }
        return fetch(request)
      }
      if (live) {
        assert.equal(url.protocol, 'https:')
        assert.ok(['site.web.api.espn.com', 'cdn.nba.com', 'api.sleeper.app', 'www.nba.com'].includes(url.hostname))
        const response = await fetch(request)
        if (response.ok && url.hostname === 'www.nba.com' && /^\/player\/\d+(?:\/[^/]+)?$/.test(url.pathname)) {
          const html = await response.clone().text()
          const embedded = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
          const info = embedded ? JSON.parse(embedded[1])?.props?.pageProps?.player?.info : null
          if (typeof info?.BIRTHDATE === 'string') profileDates[`nba:${info.PERSON_ID}`] = info.BIRTHDATE
        }
        if (response.ok && url.hostname === 'site.web.api.espn.com' && /\/athletes\/\d+$/.test(url.pathname)) {
          const data = await response.clone().json()
          if (typeof data.athlete?.dateOfBirth === 'string') profileDates[`espn:${data.athlete.id}`] = data.athlete.dateOfBirth
            const displayed = typeof data.athlete?.displayDOB === 'string' ? data.athlete.displayDOB.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/) : null
            if (displayed) profileDates[`espn:${data.athlete.id}`] = `${displayed[3]}-${displayed[2].padStart(2, '0')}-${displayed[1].padStart(2, '0')}`
        }
        return response
      }
      assert.equal(url.origin, 'http://source.invalid', `Unexpected outbound request: ${url.origin}`)
      if (url.pathname === '/espn/teams') return Response.json({ sports: [{ leagues: [{ teams: teams.map(code => ({ team: { id: code, abbreviation: code } })) }] }] })
      const team = url.pathname.match(/^\/espn\/teams\/([^/]+)\/roster$/)?.[1]
      if (team) return Response.json({ athletes: espn.filter(row => row.nba_team === team).map(row => ({
        id: row.espn_id, firstName: row.first_name, lastName: row.last_name, dateOfBirth: row.birthdate,
        position: { abbreviation: row.position }, experience: row.years_exp == null ? undefined : { years: row.years_exp + 1 },
        status: { type: row.status === 'Active' ? 'active' : 'inactive' },
      })) })
      if (url.pathname === '/espn/injuries') return Response.json({ injuries: [] })
      if (url.pathname === '/espn/news') return Response.json({ articles: [] })
      if (url.pathname === '/nba/staticData/playerIndex.json') return Response.json(nba)
      if (url.pathname === '/sleeper/players/nba') return Response.json(sleeper)
      const nbaId = url.pathname.match(/^\/profile\/player\/(\d+)(?:\/[^/]+)?$/)?.[1]
      if (nbaId && profileDates[`nba:${nbaId}`]) return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { player: { info: { PERSON_ID: Number(nbaId), BIRTHDATE: profileDates[`nba:${nbaId}`] } } } } })}</script>`)
      const espnId = url.pathname.match(/^\/career\/athletes\/(\d+)$/)?.[1]
      if (espnId && profileDates[`espn:${espnId}`]) return Response.json({ athlete: { id: espnId, dateOfBirth: profileDates[`espn:${espnId}`] } })
      return Response.json({})
    }
    let handler = async (request = new Request('http://worker.invalid')) => Response.json({ error: 'Worker did not register', url: request.url }, { status: 503 })
    const deno = Reflect.get(globalThis, 'Deno')
    const descriptor = Object.getOwnPropertyDescriptor(deno, 'serve')
    assert.ok(descriptor)
    Object.defineProperty(deno, 'serve', { value: (callback: typeof handler) => { handler = callback } })
    try { await import('./index.ts') }
    finally { Object.defineProperty(deno, 'serve', descriptor) }
    const started = performance.now()
    const response = await handler(new Request('http://worker.invalid/sync-players', {
      method: 'POST', headers: { 'x-internal-function-token': 'local-player-sync' }, body: '{}',
    }))
    const elapsedMs = performance.now() - started
    const result = await response.json()
    const { supabase } = await import('../_shared/supabase.ts')
    const { fetchAllPlayers } = await import('./players.ts')
    const players = await fetchAllPlayers<{ id: string; sleeper_id: string | null; espn_id: string | null; nba_id: string | null; birthdate: string | null }>(supabase, 'id, sleeper_id, espn_id, nba_id, birthdate')
    const available = players.filter(player => (player.sleeper_id && /^\d{4}-\d{2}-\d{2}$/.test(sleeper[player.sleeper_id]?.birth_date ?? ''))
      || profileDates[`nba:${player.nba_id}`] || profileDates[`espn:${player.espn_id}`])
    const missing = available.filter(player => !player.birthdate).map(player => player.id)
    const summary = { availableSourceBirthdates: available.length, missingSourceBirthdates: missing.length, nbaBatches, status: response.status, elapsedMs, result, players: players.length,
      birthdates: players.filter(row => row.birthdate).length, calls: counts }
    await writeFile(output, JSON.stringify(summary, null, 2) + '\n')
    await writeFile(path.join(evidence, 'profile-birthdates.json'), JSON.stringify(profileDates) + '\n')
    console.log(JSON.stringify(summary))
    if (process.env.SYNC_TEST_ALLOW_PENDING && response.status === 500) {
      assert.match(result.failure, /Birthdate profiles: \d+ remaining/)
    } else assert.equal(response.status, process.env.SYNC_TEST_FAIL_NBA_BATCH ? 500 : 200)
    if (response.status === 200) {
      assert.equal(result.ok, true)
      assert.equal(missing.length, 0)
      for (const record of espn) {
        if (record.birthdate) assert.equal(players.find(player => player.espn_id === record.espn_id)?.birthdate, record.birthdate)
      }
    }
    assert.ok(elapsedMs < 110000, `Sync exceeded worker budget: ${elapsedMs}ms`)
  },
})
