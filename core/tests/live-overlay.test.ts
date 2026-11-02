import { describe, expect, it } from 'vitest'
import { overlayLiveScores, type LiveLine, type LiveSnapshot, type SavedLiveMatchup } from '../src/live/overlay'

const now = Date.parse('2026-11-01T01:00:00Z')
const line = (id: string, points: number): LiveLine => [id,points,0,0,0,0,0,0,0,0,0,0,0,25,0]
const snapshot = (): LiveSnapshot => ({ version: 1, mode: 'public', date: '2026-10-31', capturedAt: now,
  games: [{ id: '0021', nbaId: '0021', espnId: '4001', status: 'InProgress', updatedAt: now,
    home: { team: 'BOS', score: 14, players: [line('10',14),line('12',99)] },
    away: { team: 'NYK', score: 9, players: [line('11',9)] } }] })
const basis = (): SavedLiveMatchup[] => [{ id: 'matchup', homeMemberId: 'a', awayMemberId: 'b', homePoints: 100, awayPoints: 80, finalized: false,
  players: [{ playerId: 'p1', memberId: 'a', nbaId: '10', espnId: '20', team: 'BOS', gameId: '0021', savedPoints: 10, savedAt: now-30000, starter: true },
    { playerId: 'p2', memberId: 'b', nbaId: '11', espnId: '21', team: 'NYK', gameId: '0021', savedPoints: 7, savedAt: now-30000, starter: true },
    { playerId: 'bench', memberId: 'a', nbaId: '12', espnId: '22', team: 'BOS', gameId: '0021', savedPoints: 0, savedAt: now-30000, starter: false }] }]

describe('public live-score overlay', () => {
  it('adds only lineup-player deltas to the saved official score', () => {
    const result = overlayLiveScores(basis(), snapshot(), { points: 1 }, now)
    expect(result.matchups[0]).toMatchObject({ homePoints: 104, awayPoints: 82 })
    expect(result.stats.p1.points).toBe(14)
    expect(result.stats.bench.points).toBe(99)
    expect(result.stale).toBe(false)
  })

  it('uses provider-specific IDs and keeps other-team matchups correct', () => {
    const source = snapshot()
    source.games[0].source = 'espn'
    source.games[0].home.players[0][0] = '20'
    source.games[0].home.players[1][0] = '22'
    source.games[0].away.players[0][0] = '21'
    const saved = basis()
    saved[0].id = 'other-teams'
    expect(overlayLiveScores(saved, source, { points: 1 }, now).matchups[0]).toMatchObject({ id: 'other-teams', homePoints: 104, awayPoints: 82 })
  })

  it('returns saved scores for missing or older-than-two-minute snapshots', () => {
    for (const source of [null, { ...snapshot(), capturedAt: now-120001 }]) {
      const result = overlayLiveScores(basis(), source, { points: 1 }, now)
      expect(result.matchups[0].homePoints).toBe(100)
      expect(result.stale).toBe(true)
    }
  })

  it('does not subtract newer official checkpoints or count a final twice', () => {
    const saved = basis()
    saved[0].homePoints = 104
    saved[0].players[0].savedPoints = 14
    saved[0].players[0].savedAt = now+1000
    expect(overlayLiveScores(saved, snapshot(), { points: 1 }, now).matchups[0].homePoints).toBe(104)
    saved[0].finalized = true
    expect(overlayLiveScores(saved, snapshot(), { points: 100 }, now).matchups[0].homePoints).toBe(104)
  })

  it('opens mid-game and reconnects from the current checkpoint', () => {
    const saved = basis()
    const first = overlayLiveScores(saved, snapshot(), { points: 1 }, now)
    saved[0].homePoints = first.matchups[0].homePoints
    saved[0].players[0].savedPoints = 14
    saved[0].players[0].savedAt = now
    const next = snapshot()
    next.capturedAt = now+30000
    next.games[0].updatedAt = now+30000
    next.games[0].home.players[0] = line('10',16)
    expect(overlayLiveScores(saved, next, { points: 1 }, now+30000).matchups[0].homePoints).toBe(106)
  })

  it('falls back for missing identities, corrupt numbers, and stale live games', () => {
    for (const change of [
      (source: LiveSnapshot) => { source.games[0].home.players[0][0] = 'unknown' },
      (source: LiveSnapshot) => { source.games[0].home.players[0][1] = NaN },
      (source: LiveSnapshot) => { source.games[0].updatedAt = now-120001 },
    ]) {
      const source = snapshot()
      change(source)
      const result = overlayLiveScores(basis(), source, { points: 1 }, now)
      expect(result.stale).toBe(true)
      expect(result.matchups[0].homePoints).toBe(100)
    }
  })

  it('the server off switch leaves official scores unchanged', () => {
    const source = snapshot()
    source.mode = 'database'
    const result = overlayLiveScores(basis(), source, { points: 1 }, now)
    expect(result.matchups[0].homePoints).toBe(100)
    expect(result.mode).toBe('database')
  })

  it('rejects duplicate lineup rows instead of adding the same live points twice', () => {
    const saved = basis()
    saved[0].players.push(saved[0].players[0])
    const result = overlayLiveScores(saved, snapshot(), { points: 1 }, now)
    expect(result.stale).toBe(true)
    expect(result.matchups[0].homePoints).toBe(100)
  })

  it('waits for a consistent score publication and preserves a later final correction', () => {
    const saved = basis()
    saved[0].ready = false
    expect(overlayLiveScores(saved, snapshot(), { points: 1 }, now).matchups[0]).toMatchObject({ homePoints: 100, stale: true })
    saved[0].ready = true
    saved[0].homePoints = 105
    saved[0].players[0].savedPoints = 15
    saved[0].players[0].final = true
    expect(overlayLiveScores(saved, snapshot(), { points: 1 }, now).matchups[0].homePoints).toBe(105)
  })

  it('does not replace a checkpoint with different cached stats from the same source timestamp', () => {
    const saved = basis()
    saved[0].homePoints = 105
    saved[0].players[0].savedPoints = 15
    saved[0].players[0].savedAt = now
    expect(overlayLiveScores(saved, snapshot(), { points: 1 }, now).matchups[0].homePoints).toBe(105)
  })
})
