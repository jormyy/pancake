import { useEffect, useMemo, useRef, useState } from 'react'
import { createLivePoller, fetchLiveSnapshot, gamePhase, type LiveSnapshot } from '@pancake/core'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { usePanelActivity } from '@/contexts/panel-activity'
import type { LiveViewGame } from '@/lib/cache/view-types'

export function liveSnapshotDates(games: readonly LiveViewGame[], date: string, now: number): string {
    return [...new Set(games.filter(game => {
        const phase = gamePhase(game)
        return phase === 'live' || phase === 'finalPending'
            || phase === 'upcoming' && game.game_time != null && Date.parse(game.game_time) <= now
    }).map(game => game.game_date || date))].sort().join(',')
}

export function keepNewestGames(previous: LiveSnapshot | null | undefined, next: LiveSnapshot | null): LiveSnapshot | null {
    if (!next) return previous ?? null
    if (!previous || previous.mode !== 'public' || next.mode !== 'public' || previous.date !== next.date) return next
    const key = (game: LiveSnapshot['games'][number]) => `${game.away.team}@${game.home.team}`
    const games = new Map(previous.games.map(game => [key(game), game]))
    for (const game of next.games) {
        const kept = games.get(key(game))
        if (!kept || kept.updatedAt <= game.updatedAt) games.set(key(game), game)
    }
    return { ...next, capturedAt: Math.max(previous.capturedAt, next.capturedAt), games: [...games.values()] }
}

export function usePublicLiveSnapshot(date: string, games: readonly LiveViewGame[], enabled: boolean) {
    const activity = useBrowserReadActivity()
    const panelActive = usePanelActivity()
    const [snapshots, setSnapshots] = useState<Record<string, LiveSnapshot | null>>({})
    const [time, setTime] = useState(Date.now)
    const pollers = useRef(new Map<string, ReturnType<typeof createLivePoller>>())
    const datesKey = liveSnapshotDates(games, date, Date.now())
    useEffect(() => {
        const next = games.filter(game => gamePhase(game) === 'upcoming' && game.game_time)
            .map(game => Date.parse(game.game_time!)).filter(value => Number.isFinite(value) && value > Date.now())
        if (!next.length || !enabled) return
        const timer = setTimeout(() => setTime(Date.now()), Math.max(1, Math.min(...next) - Date.now() + 1))
        return () => clearTimeout(timer)
    }, [games, enabled, time])
    useEffect(() => {
        const dates = new Set(datesKey ? datesKey.split(',') : [])
        for (const [day, poller] of pollers.current) if (!dates.has(day)) { poller.dispose(); pollers.current.delete(day) }
        for (const day of dates) {
            let poller = pollers.current.get(day)
            if (!poller) {
                poller = createLivePoller({ load: (day, signal) => fetchLiveSnapshot(`/api/live/${day}`, signal),
                    onSnapshot: snapshot => { if (pollers.current.has(day)) setSnapshots(previous => ({ ...previous, [day]: keepNewestGames(previous[day], snapshot) })) } })
                pollers.current.set(day, poller)
            }
            poller.update({ date: day, active: enabled, visible: activity.active && panelActive, online: activity.active })
        }
    }, [datesKey, enabled, activity.active, panelActive])
    useEffect(() => () => { for (const poller of pollers.current.values()) poller.dispose(); pollers.current.clear() }, [])
    const sources = useMemo(() => datesKey ? datesKey.split(',').map(day => snapshots[day] ?? null) : [], [datesKey, snapshots])
    return { snapshot: sources[0] ?? null, snapshots: sources, active: enabled && Boolean(datesKey),
        mode: sources.some(source => source?.mode === 'database') ? 'database' : sources.some(source => source?.mode === 'public') ? 'public' : undefined }
}
