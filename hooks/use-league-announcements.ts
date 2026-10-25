import { useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { useKeyedResource } from '@/hooks/use-keyed-resource'
import { listLeagueAnnouncements, type LeagueAnnouncement } from '@/lib/league-announcements'
import { deferLeagueRefresh, leagueActivityChanged, listenForLeagueChanges } from '@/lib/league-changes'
import { sessionGeneration } from '@/lib/session-cache-registry'

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
        undefined,
        () => admission.current(),
    )
    const current = useRef(resource)
    current.current = resource
    const refresh = useCallback(() => current.current.refresh(), [])

    useFocusEffect(useCallback(() => {
        focused.current = true
        const request = current.current
        if (canRead()) void request.refresh()
        const pending = deferLeagueRefresh(refresh)
        let registering = true
        const stop = leagueId ? listenForLeagueChanges(leagueId, change => {
            if (registering && change.topic === 'catchup') return
            if (canRead() && leagueActivityChanged(change)) pending.trigger()
        }) : () => {}
        registering = false
        return () => {
            focused.current = false
            stop()
            pending.cancel()
            request.suspend()
        }
    }, [leagueId, canRead, refresh]))

    useEffect(() => {
        if (typeof window === 'undefined') return
        const resume = () => { if (admission.current()) void refresh() }
        window.addEventListener('focus', resume)
        return () => window.removeEventListener('focus', resume)
    }, [refresh])

    return {
        announcements: resource.data,
        loaded: !key || resource.loaded || Boolean(resource.error),
        refreshing: resource.loading && resource.loaded,
        refresh,
    }
}
