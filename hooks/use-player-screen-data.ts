import { useCallback, useMemo, useRef, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useScreenView } from '@/hooks/use-screen-view'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { screenScope } from '@/lib/cache/screen-scope'
import type { PlayerView, PlayerSection, PlayerSectionView } from '@/lib/cache/view-types'
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
    const view = useScreenView<PlayerView>(accountId && memberId && leagueId ? screenScope('player', leagueId, memberId, { playerId, seasonYear: selectedSeason, section: 'overview' }, accountId) : null, enabled)
    const refreshView = view.refresh
    const data = view.data
    const [visible, setVisible] = useState({ identity, year: selectedSeason, count: 15 })
    const count = visible.identity === identity && visible.year === selectedSeason ? visible.count : 15
    const [sections, setSections] = useState<{ identity: string; open: Partial<Record<PlayerSection, boolean>> }>({ identity, open: {} })
    const opened = sections.identity === identity ? sections.open : {}
    const toggleSection = useCallback((section: PlayerSection) => setSections(previous => ({ identity, open: { ...(previous.identity === identity ? previous.open : {}), [section]: !(previous.identity === identity && previous.open[section]) } })), [identity])
    const sectionScope = (section: PlayerSection) => accountId && memberId && leagueId ? screenScope('player', leagueId, memberId, { playerId, seasonYear: selectedSeason, section, ...(section === 'games' ? { gameLimit: count } : {}) }, accountId) : null
    const gamesView = useScreenView<PlayerSectionView>(sectionScope('games'), enabled && opened.games === true)
    const newsView = useScreenView<PlayerSectionView>(sectionScope('news'), enabled && opened.news === true)
    const historyView = useScreenView<PlayerSectionView>(sectionScope('history'), enabled && opened.history === true)
    const previousGames = useRef<{ identity: string; season: number; limit: number; data: PlayerSectionView } | null>(null)
    if (gamesView.data) previousGames.current = { identity, season: selectedSeason, limit: count, data: gamesView.data }
    const gamesData = gamesView.data ?? (previousGames.current?.identity === identity && previousGames.current.season === selectedSeason ? previousGames.current.data : undefined)
    const visibleGameCount = gamesView.loading && previousGames.current?.identity === identity && previousGames.current.season === selectedSeason ? Math.min(count, previousGames.current.limit) : count
    const lines = gamesData?.lines ?? data?.lines
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
    const summary = useMemo(() => summarizePlayerSeason([...new Map((lines ?? []).map(line => [line.nba_games.id, line])).values()], data?.player.nba_team ?? null, scoring), [lines, data?.player.nba_team, scoring])
    const handleSeasonSelect = useCallback((year: number) => setSelection({ identity, year }), [identity])
    const loadMoreGames = useCallback(async () => { setVisible({ identity, year: selectedSeason, count: count + 15 }) }, [identity, selectedSeason, count])
    const retrySeason = useCallback(() => { void refreshView(true) }, [refreshView])
    const error = view.error?.message ?? null
    return { canRead, readEpoch, isCurrentRead, rosterRevision: data?.context.version ?? 0, initialSettled: view.loaded || Boolean(error), player: data?.player ?? null, loading: view.loading, playerError: error, availableSeasons: data?.availableSeasons ?? [currentSeasonYear()], selectedSeason, handleSeasonSelect, seasonAverages: data && 'pickup' in data ? data.averages : data?.averages ?? summary.averages, seasonLoading: view.loading, seasonError: error, gameLogLoading: gamesView.loading, gameLogError: gamesView.error?.message ?? null, retrySeason, includesLive: summary.includesLive, liveGame: summary.games.find(game => game.live && !game.didNotPlay) ?? null, gameLog: summary.games.slice(0, visibleGameCount), hasMoreGames: gamesData?.hasMoreGames ?? summary.games.length > count, loadMoreGames, fantasyPointsMap: summary.fantasyPointsMap, avgFantasyPoints: data && 'pickup' in data ? data.avgFantasyPoints : data?.avgFantasyPoints ?? summary.avgFantasyPoints, nextProjection: data?.nextProjection ?? null, projectionError: error, projectionSettled: view.loaded || Boolean(error), transactions: historyView.data?.transactions ?? data?.transactions ?? [], transactionsError: historyView.error?.message ?? null, transactionsSettled: historyView.loaded || Boolean(historyView.error), view: data, opened, toggleSection, news: newsView.data?.news ?? [], newsLoading: newsView.loading, newsError: newsView.error?.message ?? null, historyLoading: historyView.loading, retryGames: gamesView.refresh, retryNews: newsView.refresh, retryHistory: historyView.refresh }
}
