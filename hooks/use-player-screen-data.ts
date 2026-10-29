import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useScreenView } from '@/hooks/use-screen-view'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { screenScope } from '@/lib/cache/screen-scope'
import type { PlayerView, PlayerSection, PlayerSectionView, PlayerGameCursor } from '@/lib/cache/view-types'
import { currentSeasonYear } from '@/lib/shared/season'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { compareLeagueVersions } from '@/lib/league-version'
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
    const [page, setPage] = useState<{ identity: string; year: number; cursor: PlayerGameCursor | null }>({ identity, year: selectedSeason, cursor: null })
    const cursor = page.identity === identity && page.year === selectedSeason ? page.cursor : null
    const sectionScope = (section: PlayerSection) => accountId && memberId && leagueId ? screenScope('player', leagueId, memberId, { playerId, seasonYear: selectedSeason, section, ...(section === 'games' ? { gameLimit: cursor ? 15 : count, ...(cursor ? { gameAfter: cursor } : {}) } : {}) }, accountId) : null
    const gamesView = useScreenView<PlayerSectionView>(sectionScope('games'), enabled && opened.games === true)
    const newsView = useScreenView<PlayerSectionView>(sectionScope('news'), enabled && opened.news === true)
    const historyView = useScreenView<PlayerSectionView>(sectionScope('history'), enabled && opened.history === true)
    const refreshGames = gamesView.refresh
    const previousGames = useRef<{ identity: string; season: number; version: PlayerSectionView['context']['version']; limit: number; pages: Map<string, PlayerSectionView> } | null>(null)
    const currentGames = previousGames.current?.identity === identity && previousGames.current.season === selectedSeason ? previousGames.current : null
    const newerOverview = Boolean(currentGames && data && compareLeagueVersions(String(data.context.version ?? 0), String(currentGames.version ?? 0)) > 0)
    const changedVersion = Boolean(cursor && currentGames && (gamesView.data && gamesView.data.context.version !== currentGames.version || newerOverview))
    const staleFirstPage = Boolean(!cursor && newerOverview && (!gamesView.data || compareLeagueVersions(String(gamesView.data.context.version ?? 0), String(data?.context.version ?? 0)) < 0))
    useEffect(() => {
        if (changedVersion) setPage({ identity, year: selectedSeason, cursor: null })
    }, [changedVersion, identity, selectedSeason])
    useEffect(() => {
        if (staleFirstPage && enabled && opened.games) void refreshGames(true, false)
    }, [staleFirstPage, enabled, opened.games, refreshGames])
    if (gamesView.data && !changedVersion && !staleFirstPage) {
        if (!currentGames || currentGames.version !== gamesView.data.context.version) {
            previousGames.current = { identity, season: selectedSeason, version: gamesView.data.context.version, limit: count, pages: new Map() }
        }
        previousGames.current!.limit = count
        previousGames.current!.pages.set(JSON.stringify(cursor), gamesView.data)
    }
    const loadedPages = previousGames.current?.identity === identity && previousGames.current.season === selectedSeason ? [...previousGames.current.pages.values()] : []
    const gamesData = loadedPages.at(-1)
    const keysetGames = loadedPages.some(value => 'nextGameCursor' in value)
    const lines = keysetGames ? loadedPages.flatMap(value => value.lines ?? []) : gamesData?.lines ?? data?.lines
    const visibleGameCount = keysetGames ? lines?.length ?? 0 : gamesView.loading ? Math.min(count, currentGames?.limit ?? count) : count
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
    const loadMoreGames = useCallback(async () => {
        if (keysetGames) {
            if (!gamesView.loading && !gamesView.refreshing && gamesData?.nextGameCursor) setPage({ identity, year: selectedSeason, cursor: gamesData.nextGameCursor })
        } else setVisible({ identity, year: selectedSeason, count: count + 15 })
    }, [identity, selectedSeason, count, keysetGames, gamesData, gamesView.loading, gamesView.refreshing])
    const retrySeason = useCallback(() => { void refreshView(true) }, [refreshView])
    const error = view.error?.message ?? null
    return { canRead, readEpoch, isCurrentRead, rosterRevision: data?.context.version ?? 0, initialSettled: view.loaded || Boolean(error), player: data?.player ?? null, loading: view.loading, playerError: error, availableSeasons: data?.availableSeasons ?? [currentSeasonYear()], selectedSeason, handleSeasonSelect, seasonAverages: data && 'pickup' in data ? data.averages : data?.averages ?? summary.averages, seasonLoading: view.loading, seasonError: error, gameLogLoading: gamesView.loading || gamesView.refreshing || changedVersion, gameLogError: gamesView.error?.message ?? null, retrySeason, includesLive: summary.includesLive, liveGame: summary.games.find(game => game.live && !game.didNotPlay) ?? null, gameLog: summary.games.slice(0, visibleGameCount), hasMoreGames: gamesData?.hasMoreGames ?? summary.games.length > count, loadMoreGames, fantasyPointsMap: summary.fantasyPointsMap, avgFantasyPoints: data && 'pickup' in data ? data.avgFantasyPoints : data?.avgFantasyPoints ?? summary.avgFantasyPoints, nextProjection: data?.nextProjection ?? null, projectionError: error, projectionSettled: view.loaded || Boolean(error), transactions: historyView.data?.transactions ?? data?.transactions ?? [], transactionsError: historyView.error?.message ?? null, transactionsSettled: historyView.loaded || Boolean(historyView.error), view: data, opened, toggleSection, news: newsView.data?.news ?? [], newsLoading: newsView.loading, newsError: newsView.error?.message ?? null, historyLoading: historyView.loading, retryGames: gamesView.refresh, retryNews: newsView.refresh, retryHistory: historyView.refresh }
}
