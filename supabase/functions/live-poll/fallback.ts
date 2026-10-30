import { gameElapsedSeconds } from '../_shared/gameProgress.ts'
import { fetchBoxScore, parseNBAMinutes } from '../_shared/nba.ts'
import type { NBABoxScore, NBAGame } from '../_shared/nba.ts'
import type { StatsSyncGame } from '../_shared/syncStats.ts'
import { supabase } from '../_shared/supabase.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { errorMessage } from '../_shared/responses.ts'
import { fallbackReason, liveEspnSource, matchEspnGame } from './espn.ts'
import type { EspnEvent, EspnLiveSource, parseEspnSummary } from './espn.ts'

type Game = StatsSyncGame & { nba_game_id: string; game_date: string; home_team: string; away_team: string }
type ParsedEspn = ReturnType<typeof parseEspnSummary>
type Observation = {
  gameId: string; source: string; reason: string; nbaUpdatedAt?: string; espnUpdatedAt?: string;
  nbaAgeMs?: number; espnAgeMs?: number; nbaStaleReason?: string | null; scoreboardUpdatedAt?: string;
  nbaHome?: number; nbaAway?: number; espnHome?: number; espnAway?: number; nbaError?: string; espnError?: string;
}

export async function prepareLiveSources(games: Game[], events: EspnEvent[], scoreboard: NBAGame[], now = Date.now(), espn: EspnLiveSource = liveEspnSource) {
  const boxes = new Map<string, NBABoxScore>()
  const nbaBoxes = new Map<string, NBABoxScore>()
  const errors = new Map<string, unknown[]>()
  const primary = new Map<string, ParsedEspn>()
  const observations = new Map<string, Observation>()
  const useNba = (game: Game, reason: string, error?: unknown) => {
    const observation = observations.get(game.id)!
    observation.source = 'nba'
    observation.reason = reason
    if (error) observation.espnError = liveFailureText(error)
    const nba = nbaBoxes.get(game.id)
    if (nba) boxes.set(game.id, nba)
    else {
      observation.source = 'unavailable'
      if (error) errors.set(game.id, [...(errors.get(game.id) ?? []), error])
    }
  }
  await runBounded(games.map(game => async () => {
    const observation: Observation = { gameId: game.nba_game_id, source: 'unavailable', reason: 'no-source',
      scoreboardUpdatedAt: scoreboard.find(row => row.gameId === game.nba_game_id)?.sourceUpdatedAt }
    observations.set(game.id, observation)
    let event: EspnEvent | undefined
    try { event = game.status !== 'Final' ? matchEspnGame(game, events) : undefined } catch (error) { observation.espnError = liveFailureText(error) }
    const requests = await Promise.allSettled([
      fetchBoxScore(game.nba_game_id, 2500),
      event && ['in', 'post'].includes(event.status.type.state) ? espn.summary(event) : Promise.resolve(undefined),
    ])
    let nba: NBABoxScore | undefined
    if (requests[0].status === 'fulfilled') {
      try {
        nba = requests[0].value
        if (nba.gameId && nba.gameId !== game.nba_game_id) throw new Error('NBA box game identity changed')
        if (nba.gameStatus !== 3) {
          gameElapsedSeconds(nba)
          if (nba.gameStatus === 2 && (!nba.homeTeam?.players?.length || !nba.awayTeam?.players?.length)) throw new Error('NBA live box has an empty side')
        }
        if (nba.gameEt && new Date(nba.gameEt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== game.game_date) throw new Error('NBA box date identity changed')
        if (nba.homeTeam?.teamTricode && nba.homeTeam.teamTricode !== game.home_team ||
          nba.awayTeam?.teamTricode && nba.awayTeam.teamTricode !== game.away_team) throw new Error('NBA box team identity changed')
        nba = { ...nba, liveSource: 'nba' }
        nbaBoxes.set(game.id, nba)
        observation.nbaUpdatedAt = nba.liveSourceUpdatedAt ?? nba.sourceUpdatedAt
        observation.nbaAgeMs = observation.nbaUpdatedAt ? Math.max(0, now - Date.parse(observation.nbaUpdatedAt)) : undefined
        observation.nbaHome = nba.homeTeam.score
        observation.nbaAway = nba.awayTeam.score
      } catch (error) { nba = undefined; errors.set(game.id, [error]); observation.nbaError = liveFailureText(error) }
    } else { errors.set(game.id, [requests[0].reason]); observation.nbaError = liveFailureText(requests[0].reason) }
    if (game.status === 'Final' || nba?.gameStatus === 3) {
      useNba(game, 'nba-final')
      return
    }
    const parsed = requests[1].status === 'fulfilled' ? requests[1].value : undefined
    if (!parsed) {
      useNba(game, requests[1].status === 'rejected' ? 'espn-error' : 'espn-game-unavailable', requests[1].status === 'rejected' ? requests[1].reason : undefined)
      return
    }
    observation.espnUpdatedAt = parsed.sourceUpdatedAt
    observation.espnAgeMs = Math.max(0, now - Date.parse(parsed.sourceUpdatedAt))
    observation.espnHome = parsed.game.homeTeam.score
    observation.espnAway = parsed.game.awayTeam.score
    const nbaTime = observation.nbaUpdatedAt ? Date.parse(observation.nbaUpdatedAt) : NaN
    if (nba?.gameStatus === 2) {
      const elapsed = gameElapsedSeconds(nba)
      const nbaGame = typeof nba.homeTeam.score === 'number' && typeof nba.awayTeam.score === 'number'
        ? { ...nba, sourceUpdatedAt: observation.nbaUpdatedAt, gameStatusText: nba.gameStatusText ?? '',
          homeTeam: { ...nba.homeTeam, score: nba.homeTeam.score }, awayTeam: { ...nba.awayTeam, score: nba.awayTeam.score } } : undefined
      observation.nbaStaleReason = fallbackReason(nbaGame, parsed.game, now)
      if (nbaTime >= Date.parse(parsed.sourceUpdatedAt) || elapsed > gameElapsedSeconds(parsed.game)) {
        useNba(game, 'nba-newer')
        return
      }
    }
    primary.set(game.id, parsed)
    observation.source = 'espn'
    observation.reason = 'espn-primary'
  }), 4)
  const espnIds = [...new Set([...primary.values()].flatMap(value => value.players.map(player => player.espnId)))]
  if (espnIds.length) {
    try {
      const { data, error } = await supabase.from('players').select('id,espn_id,nba_id').in('espn_id', espnIds).abortSignal(AbortSignal.timeout(5000))
      if (error) throw error
      const identities = new Map<string, { id: string; nba_id: string | null }[]>()
      for (const row of data ?? []) {
        const list = identities.get(row.espn_id!) ?? []
        list.push(row)
        identities.set(row.espn_id!, list)
      }
      for (const [id, parsed] of primary) {
        const game = games.find(game => game.id === id)!
        try {
          const mapped = parsed.players.map(row => {
            const matches = identities.get(row.espnId)
            if (matches?.length !== 1 || !matches[0].nba_id || !/^\d+$/.test(matches[0].nba_id) || !Number.isSafeInteger(Number(matches[0].nba_id)) || Number(matches[0].nba_id) <= 0) throw new Error(`ESPN athlete ${row.espnId}: missing or ambiguous NBA identity link`)
            return { ...row, playerId: matches[0].id, player: { ...row.player, personId: Number(matches[0].nba_id) } }
          })
          if (new Set(mapped.map(row => row.playerId)).size !== mapped.length || new Set(mapped.map(row => row.player.personId)).size !== mapped.length) throw new Error('ESPN athletes resolve to duplicate players')
          const home = mapped.filter(row => row.team === parsed.game.homeTeam.teamTricode)
          const away = mapped.filter(row => row.team === parsed.game.awayTeam.teamTricode)
          const nba = nbaBoxes.get(id)
          const mappedNbaIds = new Map(mapped.map(row => [row.player.personId, row.playerId]))
          const witnesses = [nba?.homeTeam, nba?.awayTeam].flatMap(team => team?.players ?? []).filter(player =>
            player.played === '1' || player.played === 1 || (parseNBAMinutes(player.statistics?.minutes) ?? 0) > 0 ||
            Object.values(player.statistics ?? {}).some(value => typeof value === 'number' && Number.isFinite(value) && value !== 0))
            .flatMap(player => mappedNbaIds.has(player.personId) ? [mappedNbaIds.get(player.personId)!] : [])
          boxes.set(id, { ...parsed.game, gameId: game.nba_game_id, gameEt: null, liveSource: 'espn',
            livePlayerIds: [...home, ...away].map(row => row.playerId), nbaWitnessPlayerIds: witnesses,
            homeTeam: { ...parsed.game.homeTeam, players: home.map(row => row.player) },
            awayTeam: { ...parsed.game.awayTeam, players: away.map(row => row.player) } })
        } catch (error) { useNba(game, 'espn-identity-error', error) }
      }
    } catch (error) {
      for (const id of primary.keys()) useNba(games.find(game => game.id === id)!, 'espn-identity-error', error)
    }
  }
  for (const observation of observations.values()) console.log('[live-poll] source:', JSON.stringify(observation))
  return {
    observations: [...observations.values()],
    loadBoxScore: (game: StatsSyncGame): Promise<NBABoxScore> => {
      const box = boxes.get(game.id)
      if (box) return Promise.resolve(box)
      return Promise.reject(new AggregateError(errors.get(game.id) ?? [], `Game ${game.nba_game_id}: no usable live source`))
    },
    failures: [] as unknown[],
  }
}

export function liveFailureText(error: unknown, depth = 0): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(inner => liveFailureText(inner, depth + 1)).join('; ')}`
  const code = (error as { code?: string } | null)?.code
  const text = `${code ? code + ': ' : ''}${errorMessage(error)}`
  const cause = error instanceof Error ? error.cause : undefined
  return cause && depth < 8 ? `${text}: ${liveFailureText(cause, depth + 1)}` : text
}
