import { fetchBoxScore, fetchTodaysGames, parseNBAMinutes } from '../../supabase/functions/_shared/nba.ts'
import type { NBABoxScore, NBABoxScorePlayer, NBAGame } from '../../supabase/functions/_shared/nba.ts'
import { gameElapsedSeconds } from '../../supabase/functions/_shared/gameProgress.ts'
import { newerNbaSource } from '../../supabase/functions/_shared/liveSourceChoice.ts'
import { runBounded } from '../../supabase/functions/_shared/runBounded.ts'
import { EspnLiveSource, matchEspnGame, teamCode } from '../../supabase/functions/live-poll/espn.ts'
import type { EspnEvent } from '../../supabase/functions/live-poll/espn.ts'
import type { LiveLine, LiveSnapshot, PublicLiveGame } from '../../core/src/live/overlay.ts'
import { liveLineStats } from '../../core/src/live/codec.ts'

const etDate = (value: number | string) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

function boardDate(game: NBAGame, now: number) {
  const extra = game as NBAGame & { gameEt?: string; gameCode?: string }
  if (extra.gameEt && Number.isFinite(Date.parse(extra.gameEt))) return etDate(extra.gameEt)
  const date = /^(\d{4})(\d{2})(\d{2})\//.exec(extra.gameCode ?? '')
  return date ? `${date[1]}-${date[2]}-${date[3]}` : etDate(now)
}

function compactPlayer(player: NBABoxScorePlayer, id = String(player.personId)): LiveLine {
  if (!/^\d+$/.test(id)) throw new Error('Invalid provider player identity')
  const s = player.statistics
  const minutes = parseNBAMinutes(s.minutes)
  const didNotPlay = player.played === '0' || player.played === 0 || player.played == null && minutes == null
  const row: LiveLine = [id,s.points ?? 0,s.reboundsTotal ?? 0,s.assists ?? 0,s.steals ?? 0,s.blocks ?? 0,
    s.turnovers ?? 0,s.threePointersMade ?? 0,s.fieldGoalsMade ?? 0,s.fieldGoalsAttempted ?? 0,
    s.freeThrowsMade ?? 0,s.freeThrowsAttempted ?? 0,s.foulsPersonal ?? 0,minutes ?? 0,didNotPlay ? 1 : 0]
  if (!liveLineStats(row)) throw new Error('Invalid provider stat line')
  return row
}

function compactBox(box: NBABoxScore, board: NBAGame | undefined, event: EspnEvent | undefined, observedAt: number, ids?: Map<NBABoxScorePlayer, string>): PublicLiveGame {
  if (box.gameStatus !== 3) gameElapsedSeconds(box)
  const updatedAt = Date.parse(box.liveSourceUpdatedAt ?? box.sourceUpdatedAt ?? board?.sourceUpdatedAt ?? '')
  if (!Number.isFinite(updatedAt) || updatedAt > observedAt+5000) throw new Error('Provider snapshot has an invalid source timestamp')
  const sides = [box.homeTeam,box.awayTeam].map(side => {
    const players = side.players.map(player => compactPlayer(player, ids?.get(player)))
    if (!players.length || new Set(players.map(row => row[0])).size !== players.length || !Number.isFinite(side.score)
      || players.reduce((sum, row) => sum+row[1],0) !== side.score) throw new Error('Provider box is incomplete')
    return { team: side.teamTricode, score: side.score!, players }
  })
  const identities = sides.flatMap(side => side.players.map(player => player[0]))
  if (new Set(identities).size !== identities.length) throw new Error('Provider player appears on both sides')
  return { id: board?.gameId ?? `espn:${event!.id}`, nbaId: board?.gameId ?? null, espnId: event?.id ?? null,
    source: ids ? 'espn' : 'nba', status: box.gameStatus === 3 ? 'Final' : 'InProgress', updatedAt,
    period: box.period, clock: box.gameClock, home: sides[0], away: sides[1] }
}

export function createSnapshotSource(now: () => number = Date.now) {
  const espn = new EspnLiveSource(now)
  return async (date: string): Promise<LiveSnapshot> => {
    const results = await Promise.allSettled([fetchTodaysGames(2500),espn.scoreboard([date])])
    if (results.every(result => result.status === 'rejected')) throw new Error('Both public score providers are unavailable')
    const boards = results[0].status === 'fulfilled' ? results[0].value.filter(game => boardDate(game,now()) === date) : []
    const events = results[1].status === 'fulfilled' ? results[1].value.filter(event => etDate(event.date) === date && event.season?.type === 2) : []
    const year = Number(date.slice(0,4)) + (Number(date.slice(5,7)) >= 10 ? 1 : 0)
    const catalog: { board?: NBAGame; event?: EspnEvent }[] = boards.map(board => ({ board, event: matchEspnGame({ game_date: date, season_year: year,
      home_team: board.homeTeam.teamTricode, away_team: board.awayTeam.teamTricode },events) }))
    for (const event of events) if (!catalog.some(item => item.event?.id === event.id)) catalog.push({ event })
    if (catalog.length > 15) throw new Error('Public slate is larger than the supported limit')
    const games: PublicLiveGame[] = []
    const failures: string[] = []
    await runBounded(catalog.map(({board,event}) => async () => {
      try {
        if (((board?.gameStatus === 1 || !board) && event?.status.type.state === 'pre') || (board?.gameStatus === 1 && !event)) {
          const sides = event?.competitions[0].competitors
          games.push({ id: board?.gameId ?? `espn:${event!.id}`, nbaId: board?.gameId ?? null, espnId: event?.id ?? null,
            source: board ? 'nba' : 'espn', status: 'Scheduled', updatedAt: Date.parse(board?.sourceUpdatedAt ?? '') || now(),
            home: { team: board?.homeTeam.teamTricode ?? teamCode(sides!.find(side => side.homeAway === 'home')!.team.abbreviation), score: 0, players: [] },
            away: { team: board?.awayTeam.teamTricode ?? teamCode(sides!.find(side => side.homeAway === 'away')!.team.abbreviation), score: 0, players: [] } })
          return
        }
        const [nbaResult, espnResult] = await Promise.allSettled([
          board ? fetchBoxScore(board.gameId,2500) : Promise.resolve(undefined),
          event && ['in','post'].includes(event.status.type.state) ? espn.summary(event) : Promise.resolve(undefined),
        ])
        let nba = nbaResult.status === 'fulfilled' ? nbaResult.value : undefined
        if (nba && (nba.gameId !== board?.gameId || nba.gameEt && etDate(nba.gameEt) !== date
          || nba.homeTeam.teamTricode !== board?.homeTeam.teamTricode || nba.awayTeam.teamTricode !== board?.awayTeam.teamTricode)) nba = undefined
        const other = espnResult.status === 'fulfilled' ? espnResult.value : undefined
        let nbaCompact: PublicLiveGame | undefined
        if (nba) {
          try { nbaCompact = compactBox(nba,board,event,now()) } catch { nba = undefined }
        }
        if (nba && nbaCompact && (!other || newerNbaSource(nba,other.game))) games.push(nbaCompact)
        else if (other) {
          const identities = new Map(other.players.map(row => [row.player,row.espnId]))
          const box = { ...other.game, gameEt: null,
            homeTeam: { ...other.game.homeTeam, players: other.players.filter(row => row.team === other.game.homeTeam.teamTricode).map(row => row.player) },
            awayTeam: { ...other.game.awayTeam, players: other.players.filter(row => row.team === other.game.awayTeam.teamTricode).map(row => row.player) } }
          games.push(compactBox(box,board,event,now(),identities))
        } else if (nbaCompact) games.push(nbaCompact)
        else throw new Error('No valid live box')
      } catch { failures.push(board?.gameId ?? `espn:${event!.id}`) }
    }),8)
    if (catalog.length && !games.length) throw new Error('No public game snapshot is usable')
    return { version: 1, mode: 'public', date, capturedAt: now(), games: games.sort((a,b) => a.id.localeCompare(b.id)),
      ...(failures.length ? { unavailable: failures.sort() } : {}) }
  }
}
