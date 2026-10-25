import { useEffect, useRef, useState } from 'react'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { listLeagueAnnouncements, type LeagueAnnouncement } from '@/lib/league-announcements'
import { sessionGeneration } from '@/lib/session-cache-registry'

export function useLeagueAnnouncements(ownerId: string | undefined, leagueId: string | undefined, enabled = true) {
    const { active, revision, isCurrent } = useBrowserReadActivity()
    const key = ownerId && leagueId ? JSON.stringify([ownerId, leagueId, sessionGeneration()]) : null
    const current = useRef(key)
    current.current = key
    const [state, setState] = useState<{ key: string | null; rows: LeagueAnnouncement[]; loaded: boolean }>({ key, rows: [], loaded: false })
    const loaded = state.key === key && state.loaded
    useEffect(() => {
        if (!enabled || !active || !key || !leagueId || loaded) return
        let disposed = false
        const readRevision = revision
        void listLeagueAnnouncements(leagueId).then(rows => {
            if (!disposed && current.current === key && isCurrent(readRevision)) setState({ key, rows, loaded: true })
        }).catch(() => {
            if (!disposed && current.current === key && isCurrent(readRevision)) setState({ key, rows: [], loaded: true })
        })
        return () => { disposed = true }
    }, [enabled, key, leagueId, loaded, active, revision, isCurrent])
    return { announcements: state.key === key ? state.rows : [], loaded: !key || loaded }
}
