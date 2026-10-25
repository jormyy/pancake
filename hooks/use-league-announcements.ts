import { useCallback, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { useKeyedResource } from '@/hooks/use-keyed-resource'
import { listLeagueAnnouncements, type LeagueAnnouncement } from '@/lib/league-announcements'
import { onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

const announcementCache = new Map<string, LeagueAnnouncement[]>()
onSessionCachesCleared(() => announcementCache.clear())
const cache = {
    read: (key: string) => announcementCache.get(key),
    write: (key: string, rows: LeagueAnnouncement[]) => { announcementCache.set(key, rows) },
}

const EMPTY_ANNOUNCEMENTS: LeagueAnnouncement[] = []

export function useLeagueAnnouncements(ownerId: string | undefined, leagueId: string | undefined, enabled = true) {
    const { active, revision, isCurrent } = useBrowserReadActivity()
    const generation = sessionGeneration()
    const key = ownerId && leagueId ? JSON.stringify([ownerId, leagueId, generation]) : null
    const focused = useRef(false)
    const canRead = useCallback(() => focused.current && enabled && active && key !== null
        && generation === sessionGeneration() && isCurrent(revision), [enabled, active, key, generation, revision, isCurrent])
    const admission = useRef(canRead)
    admission.current = canRead
    const resource = useKeyedResource(
        key,
        EMPTY_ANNOUNCEMENTS,
        useCallback(() => leagueId ? listLeagueAnnouncements(leagueId) : Promise.resolve([]), [leagueId]),
        cache,
        () => admission.current(),
    )
    const current = useRef(resource)
    current.current = resource
    const refresh = useCallback(() => current.current.refresh(), [])

    useFocusEffect(useCallback(() => {
        focused.current = true
        const request = current.current
        if (canRead()) void request.refresh()
        return () => {
            focused.current = false
            request.suspend()
        }
    }, [canRead]))

    return {
        announcements: resource.data,
        loaded: !key || resource.loaded || Boolean(resource.error),
        refreshing: resource.loading && resource.loaded,
        refresh,
    }
}
