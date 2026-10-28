import assert from 'node:assert/strict'

Deno.test({
  name: 'live stat resolution overlaps committed player-link batches and defers a provider outage',
  ignore: !Deno.env.get('PLAYER_CONCURRENCY_STATUS'),
  fn: async () => {
    const status = Object.fromEntries((await Deno.readTextFile(Deno.env.get('PLAYER_CONCURRENCY_STATUS')!)).split('\n').flatMap(line => {
      const match = line.match(/^([A-Z_]+)="(.*)"$/)
      return match ? [[match[1], match[2]]] : []
    }))
    const api = new URL(status.API_URL)
    assert.equal(api.hostname, '127.0.0.1')
    assert.equal(api.port, '57021')
    const db = 'postgresql://postgres:postgres@127.0.0.1:57022/postgres'
    for (const [name, value] of Object.entries({ SUPABASE_URL: api.origin, PANCAKE_SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY ?? status.SECRET_KEY,
      NBA_CDN_BASE_URL: 'http://source.invalid', SLEEPER_BASE_URL: 'http://source.invalid/sleeper' })) Deno.env.set(name, value)
    const sql = async (input: string) => {
      const result = await new Deno.Command('psql', { args: [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', input], stdout: 'piped', stderr: 'piped' }).output()
      if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
      return new TextDecoder().decode(result.stdout).trim()
    }
    class Session {
      child = new Deno.Command('psql', { args: [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
      writer = this.child.stdin.getWriter()
      reader = this.child.stdout.getReader()
      errors = new Response(this.child.stderr).text()
      buffer = ''
      async query(input: string) {
        const marker = crypto.randomUUID()
        await this.writer.write(new TextEncoder().encode(`${input};\n\\echo ${marker}\n`))
        while (!this.buffer.includes(marker)) {
          const next = await this.reader.read()
          if (next.done) throw new Error(await this.errors)
          this.buffer += new TextDecoder().decode(next.value)
        }
        const result = this.buffer.slice(0, this.buffer.indexOf(marker)).trim()
        this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
        return result
      }
      async close() { await this.writer.close(); await this.reader.cancel(); await this.child.status; await this.errors }
    }
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const tag = crypto.randomUUID().replaceAll('-', '')
    const gameId = crypto.randomUUID()
    const providerGame = `00226${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`
    const nbaBase = 900000000 + Math.floor(Math.random() * 900000) * 100
    const players = Array.from({ length: 52 }, (_, index) => ({ id: crypto.randomUUID(), nba: String(nbaBase + index),
      first: `Concurrent${tag}`, last: `${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}`, team: index % 2 ? 'LAL' : 'BOS' }))
    const game = { id: gameId, nba_game_id: providerGame, season_year: 2027, week_number: 1, status: 'InProgress' as const }
    const statistics = { minutes: 'PT05M00.00S', points: 2, assists: 0, blocks: 0, fieldGoalsAttempted: 1, fieldGoalsMade: 1,
      foulsPersonal: 0, freeThrowsAttempted: 0, freeThrowsMade: 0, plusMinusPoints: 0, reboundsDefensive: 0, reboundsOffensive: 0,
      reboundsTotal: 0, steals: 0, threePointersAttempted: 0, threePointersMade: 0, turnovers: 0 }
    const boxPlayer = (index: number) => ({ personId: Number(players[index].nba), name: `${players[index].first} ${players[index].last}`, position: 'G', statistics })
    const { syncNBAIds } = await import('./nbaIds.ts')
    const { syncSleeperLinks } = await import('./sleeperLinks.ts')
    const { syncLiveStatsGames } = await import('../_shared/syncStats.ts')
    const { withWorkContext } = await import('../_shared/workContext.ts')
    const { resolveCdnPlayers } = await import('../_shared/playerResolver.ts')
    const originalFetch = globalThis.fetch
    const link = new Session()
    const race = new Session()
    const raceId = crypto.randomUUID()
    const raceNba = String(nbaBase + 99)
    let open!: () => void
    const held = new Promise<void>(resolve => { open = resolve })
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let committed!: () => void
    const commit = new Promise<void>(resolve => { committed = resolve })
    const batches: number[] = []
    const sleeperBatches: number[] = []
    let unavailable = true
    let linking: ReturnType<typeof syncNBAIds> | undefined
    try {
      await sql(`INSERT INTO public.players(id,first_name,last_name,nba_id,nba_team,position,eligible_positions) VALUES ${players.map(p => `(${quote(p.id)},${quote(p.first)},${quote(p.last)},${quote(p.nba)},${quote(p.team)},'G',ARRAY['G'])`).join(',')};
        INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES(${quote(gameId)},${quote(providerGame)},2027,1,current_date,'BOS','LAL','InProgress');
        ALTER FUNCTION public.resolve_player_imports_atomic(text,jsonb) SET lock_timeout='500ms';`)
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'source.invalid') {
          if (url.pathname.startsWith('/sleeper/')) return unavailable ? new Response(null, { status: 503 }) : Response.json(Object.fromEntries(players.map(p => [p.nba, {
            sport: 'nba', player_id: p.nba, first_name: p.first, last_name: p.last, team: p.team, position: 'G', years_exp: 6, birth_date: '1990-01-01',
          }])))
          if (url.pathname === '/staticData/playerIndex.json') return Response.json({ resultSets: [{
            headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS', 'TEAM_ABBREVIATION', 'POSITION', 'FROM_YEAR'],
            rowSet: players.map(p => [p.nba, p.first, p.last, 1, p.team, 'G', 2020]),
          }] })
          return Response.json({ game: { gameStatus: 2, period: 1, gameClock: 'PT05M00.00S',
            homeTeam: { teamTricode: 'BOS', players: [boxPlayer(0)] }, awayTeam: { teamTricode: 'LAL', players: [boxPlayer(1)] } } })
        }
        assert.equal(url.origin, api.origin)
        if (url.pathname.endsWith('/link_player_sources_atomic')) {
          const body = await request.clone().json()
          if (body.p_source === 'sleeper') { sleeperBatches.push(body.p_records.length); return originalFetch(request) }
          batches.push(body.p_records.length)
          const result = await link.query(`BEGIN; SELECT public.link_player_sources_atomic('nba',${quote(JSON.stringify(body.p_records))}::jsonb,false)`)
          if (batches.length === 1) { open(); await released }
          else await sql(`BEGIN; SELECT id FROM players WHERE id=${quote(players[49].id)} FOR UPDATE NOWAIT; ROLLBACK;`)
          await link.query('COMMIT')
          committed()
          return Response.json(JSON.parse(result))
        }
        if (url.pathname.endsWith('/save_live_game_stats_atomic')) { release(); await commit }
        return originalFetch(request)
      }
      linking = syncNBAIds()
      await held
      const [stats, identity] = await Promise.all([
        withWorkContext({ signal: AbortSignal.timeout(2000) }, () => syncLiveStatsGames([game])),
        syncSleeperLinks(),
      ])
      const failures = stats.failures.map(error => String((error as { message?: string }).message ?? error))
      console.log(JSON.stringify({ statLines: stats.statLines, failures, identityFailures: identity.failures, batches }))
      release()
      await linking
      if (Deno.env.get('PLAYER_CONCURRENCY_EXPECT_BROKEN')) {
        assert.ok(failures.some(value => /lock timeout/.test(value)))
        assert.ok(identity.failures.some(value => /Sleeper players 503/.test(value)))
      } else {
        assert.deepEqual(failures, [])
        assert.equal(stats.statLines, 2)
        assert.deepEqual(identity.failures, [])
        assert.equal(identity.deferred, true)
        assert.deepEqual(batches, [50, 2])
        assert.equal(await sql(`SELECT count(*) FROM player_game_stats WHERE game_id=${quote(gameId)}`), '2')
        await race.query(`BEGIN; SELECT id FROM players WHERE id=${quote(players[0].id)} FOR UPDATE`)
        assert.deepEqual(await withWorkContext({ signal: AbortSignal.timeout(500) }, () => resolveCdnPlayers([
          { personId: players[0].nba, displayName: `${players[0].first} ${players[0].last}` },
        ])), [players[0].id])
        await race.query('ROLLBACK')
        await race.query(`BEGIN; INSERT INTO players(id,first_name,last_name,nba_id,birthdate) VALUES(${quote(raceId)},'Raced','Identity',${quote(raceNba)},'1990-01-01')`)
        let settled = false
        const resolving = resolveCdnPlayers([{ personId: raceNba, displayName: 'Raced Identity' }]).finally(() => { settled = true })
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(settled, false)
        await race.query('COMMIT')
        assert.deepEqual(await resolving, [raceId])
        assert.equal(await sql(`SELECT count(*) FROM players WHERE nba_id=${quote(raceNba)}`), '1')
        unavailable = false
        const retry = await syncSleeperLinks()
        assert.equal(retry.deferred, false)
        assert.deepEqual(retry.failures, [])
        assert.equal(retry.linked, 52)
        assert.deepEqual(sleeperBatches, [50, 2])
      }
    } finally {
      release()
      await linking?.catch(() => {})
      globalThis.fetch = originalFetch
      await link.close()
      await race.query('ROLLBACK')
      await race.close()
      await sql(`ALTER FUNCTION public.resolve_player_imports_atomic(text,jsonb) RESET lock_timeout;
        DELETE FROM public.player_game_stats WHERE game_id=${quote(gameId)};
        DELETE FROM private.player_game_memberships WHERE game_id=${quote(gameId)};
        DELETE FROM public.nba_games WHERE id=${quote(gameId)};
        DELETE FROM public.players WHERE id IN (${[...players.map(p => quote(p.id)), quote(raceId)].join(',')});`)
    }
  },
})
