import { useCallback, useMemo, useRef, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useScreenView } from '@/hooks/use-screen-view'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { screenScope } from '@/lib/cache/screen-scope'
import type { PlayerView } from '@/lib/cache/view-types'
import { currentSeasonYear } from '@/lib/shared/season'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { summarizePlayerSeason } from '@/components/player/season-data'

export function usePlayerScreenData(playerId: string, leagueId: string | null, options: { ownerKey?: string; authorized?: boolean; scoringSettings?: unknown } = {}) {
    const focused = useIsFocused()
    const activity = useBrowserReadActivity()
    const accountId = sessionOwner()
    let memberId: string | undefined
    try { memberId = options.ownerKey ? (JSON.parse(options.ownerKey) as [string, string])[1] : undefined } catch {}
    const generation = sessionGeneration()
    const identity = JSON.stringify([accountId, memberId, leagueId, playerId, generation])
    const [selection, setSelection] = useState({ identity, year: currentSeasonYear() })
    const selectedSeason = selection.identity === identity ? selection.year : currentSeasonYear()
    const enabled = focused && activity.active && options.authorized !== false
    const view = useScreenView<PlayerView>(accountId && memberId && leagueId ? screenScope('player', leagueId, memberId, { playerId, seasonYear: selectedSeason }, accountId) : null, enabled)
    const refreshView = view.refresh
    const data = view.data
    const [visible, setVisible] = useState({ identity, year: selectedSeason, count: 15 })
    const count = visible.identity === identity && visible.year === selectedSeason ? visible.count : 15
    const readEpoch = JSON.stringify([identity, activity.revision, focused])
    const latestEpoch = useRef(readEpoch)
    latestEpoch.current = readEpoch
    const canRead = useCallback(() => enabled && generation === sessionGeneration(), [enabled, generation])
    const isCurrentRead = useCallback((epoch: string) => canRead() && latestEpoch.current === epoch, [canRead])
    const scoring = useMemo(() => {
        const supplied = data?.scoringSettings ?? options.scoringSettings
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return null
        return Object.fromEntries(Object.entries(supplied).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
    }, [data?.scoringSettings, options.scoringSettings])
    const summary = useMemo(() => summarizePlayerSeason([...new Map((data?.lines ?? []).map(line => [line.nba_games.id, line])).values()], data?.player.nba_team ?? null, scoring), [data, scoring])
    const handleSeasonSelect = useCallback((year: number) => setSelection({ identity, year }), [identity])
    const loadMoreGames = useCallback(async () => { setVisible({ identity, year: selectedSeason, count: count + 15 }) }, [identity, selectedSeason, count])
    const retrySeason = useCallback(() => { void refreshView(true) }, [refreshView])
    const error = view.error?.message ?? null
    return { canRead, readEpoch, isCurrentRead, rosterRevision: data?.context.version ?? 0, initialSettled: view.loaded || Boolean(error), player: data?.player ?? null, loading: view.loading, playerError: error, availableSeasons: data?.availableSeasons ?? [currentSeasonYear()], selectedSeason, handleSeasonSelect, seasonAverages: data?.averages ?? summary.averages, seasonLoading: view.loading, seasonError: error, gameLogLoading: view.loading, gameLogError: error, retrySeason, includesLive: summary.includesLive, liveGame: summary.games.find(game => game.live && !game.didNotPlay) ?? null, gameLog: summary.games.slice(0, count), hasMoreGames: summary.games.length > count, loadMoreGames, fantasyPointsMap: summary.fantasyPointsMap, avgFantasyPoints: data?.avgFantasyPoints ?? summary.avgFantasyPoints, nextProjection: data?.nextProjection ?? null, projectionError: error, projectionSettled: view.loaded || Boolean(error), transactions: data?.transactions ?? [], transactionsError: error, transactionsSettled: view.loaded || Boolean(error), view: data }
}
