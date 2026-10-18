export function liveIngestionProvider() {
  let config = { gameId: '', homePersonId: 1, awayPersonId: 2, mode: 'active' }
  let counter = 0
  const requests: { kind: string; at: number; counter: number; mode: string }[] = []
  function player(personId: number, home: boolean) {
    return { personId, name: home ? 'Live Home' : 'Live Away', played: '1', statistics: {
      minutes: 'PT20M00.00S', points: home ? counter + 10 : 1,
      reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
      assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0,
      fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0, threePointersAttempted: 0,
      freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0,
    } }
  }
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === '/control' && request.method === 'POST') {
      config = { ...config, ...await request.json() }
      if (new URL(request.url).searchParams.get('reset') === '1') { counter = 0; requests.length = 0 }
      return Response.json({ ok: true })
    }
    if (path === '/state') return Response.json({ config, counter, requests })
    if (path.endsWith('/todaysScoreboard_00.json')) {
      counter++
      requests.push({ kind: 'scoreboard', at: Date.now(), counter, mode: config.mode })
      const gameStatus = config.mode === 'final' || config.mode === 'box-fail' ? 3 : 2
      return Response.json({ scoreboard: { games: [{ gameId: config.gameId, gameStatus,
        gameStatusText: gameStatus === 3 ? 'Final' : `Q1 ${counter}:00`,
        homeTeam: { teamTricode: 'BOS', score: counter + 10 }, awayTeam: { teamTricode: 'MIA', score: 1 },
      }] } })
    }
    if (path.endsWith(`/boxscore_${config.gameId}.json`)) {
      requests.push({ kind: 'boxscore', at: Date.now(), counter, mode: config.mode })
      if (config.mode === 'box-stall') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
      if (config.mode === 'box-fail') return new Response('Synthetic provider unavailable', { status: 503 })
      return Response.json({ game: { gameId: config.gameId, gameStatus: config.mode === 'final' ? 3 : 2,
        gameEt: null, homeTeam: { teamTricode: 'BOS', players: [player(config.homePersonId, true)] },
        awayTeam: { teamTricode: 'MIA', players: [player(config.awayPersonId, false)] },
      } })
    }
    return new Response('Unexpected local provider request', { status: 404 })
  }
}

if (import.meta.main) {
  const port = Number(Deno.args.find(value => value.startsWith('--port='))?.slice(7))
  if (!Number.isInteger(port) || port < 1024) throw new Error('An isolated provider port is required')
  Deno.serve({ hostname: '0.0.0.0', port }, liveIngestionProvider())
}
