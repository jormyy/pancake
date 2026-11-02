import { useEffect, useMemo, useState } from 'react'
import { createLivePoller, fetchLiveSnapshot, type LiveSnapshot } from '@pancake/core'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { usePanelActivity } from '@/contexts/panel-activity'
import type { NBAGameRow } from '@/lib/games'

export function usePublicLiveSnapshot(date: string, games: readonly NBAGameRow[], enabled: boolean) {
    const activity = useBrowserReadActivity()
    const panelActive = usePanelActivity()
    const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
    const [time, setTime] = useState(Date.now)
    const active = games.some(game => game.status === 'InProgress' || game.status === 'Scheduled'
        && game.game_time != null && Date.parse(game.game_time) <= time && !/postpon|cancel/i.test(game.game_status_text ?? ''))
    const poller = useMemo(() => createLivePoller({
        load: (day, signal) => fetchLiveSnapshot(`/api/live/${day}`, signal),
        onSnapshot: setSnapshot,
    }), [])
    useEffect(() => {
        const next = games.filter(game => game.status === 'Scheduled' && game.game_time)
            .map(game => Date.parse(game.game_time!)).filter(value => Number.isFinite(value) && value > Date.now())
        if (!next.length || !enabled) return
        const timer = setTimeout(() => setTime(Date.now()), Math.max(1, Math.min(...next) - Date.now() + 1))
        return () => clearTimeout(timer)
    }, [games, enabled, time])
    useEffect(() => {
        poller.update({ date, active: enabled && active, visible: activity.active && panelActive, online: activity.active })
    }, [poller, date, enabled, active, activity.active, panelActive])
    useEffect(() => () => poller.dispose(), [poller])
    return { snapshot, active: enabled && active }
}
