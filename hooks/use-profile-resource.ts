import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { listenForProfileUpdates } from '@/lib/profile-updates'
import { getProfile, suspendProfileRead } from '@/lib/auth'
import {
    getNotificationPreferences,
    type NotificationPreferences,
} from '@/lib/notification-preferences'
import type { Profile } from '@/types/database'

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
    tradeEnabled: true,
    waiverEnabled: true,
    draftEnabled: true,
    activityEnabled: true,
}

type ResourceState = {
    ownerId: string | undefined
    profile: Profile | null
    preferences: NotificationPreferences
    loaded: boolean
    error: string | null
}

function errorMessage(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message ? reason.message : fallback
}

export function useProfileResource(userId: string | undefined) {
    const { active, revision, isCurrent } = useBrowserReadActivity()
    const activeOwnerRef = useRef(userId)
    activeOwnerRef.current = userId
    const [resource, setResource] = useState<ResourceState>({
        ownerId: userId,
        profile: null,
        preferences: DEFAULT_NOTIFICATION_PREFERENCES,
        loaded: false,
        error: null,
    })
    const requestRef = useRef(0)

    const load = useCallback(async (options: { force?: boolean } = {}) => {
        const requestId = ++requestRef.current
        if (!userId) {
            setResource({
                ownerId: undefined,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
                error: null,
            })
            return
        }

        if (!isCurrent(revision)) return
        const ownerId = userId
        setResource((current) => current.ownerId === ownerId
            ? { ...current, error: null }
            : {
                ownerId,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
                error: null,
            })
        const [profileResult, preferencesResult] = await Promise.allSettled([
            getProfile(ownerId, options),
            getNotificationPreferences(ownerId),
        ])
        if (requestRef.current !== requestId || activeOwnerRef.current !== ownerId || !isCurrent(revision)) return

        const errors = [
            profileResult.status === 'rejected'
                ? errorMessage(profileResult.reason, 'Could not load profile.')
                : null,
            preferencesResult.status === 'rejected'
                ? errorMessage(preferencesResult.reason, 'Could not load notification preferences.')
                : null,
        ].filter((message): message is string => Boolean(message))
        setResource((current) => current.ownerId === ownerId ? {
            ownerId,
            profile: profileResult.status === 'fulfilled' ? profileResult.value : current.profile,
            preferences: preferencesResult.status === 'fulfilled'
                ? preferencesResult.value
                : current.preferences,
            loaded: errors.length === 0,
            error: errors.length > 0 ? errors.join(' ') : null,
        } : current)
    }, [userId, revision, isCurrent])

    useEffect(() => {
        if (active) void load({ force: revision > 0 })
        else if (userId) suspendProfileRead(userId)
        return () => { requestRef.current += 1 }
    }, [load, userId, active, revision])

    useEffect(() => {
        if (!userId) return
        return listenForProfileUpdates(userId, patch => {
            setResource(current => current.ownerId === userId && current.profile
                ? { ...current, profile: { ...current.profile, ...patch } } : current)
        })
    }, [userId])

    const retryProfile = useCallback(() => load({ force: true }), [load])
    const ownsResource = resource.ownerId === userId
    const setProfile = useCallback((updater: React.SetStateAction<Profile | null>) => {
        setResource((current) => {
            if (current.ownerId !== activeOwnerRef.current || !current.loaded) return current
            const profile = typeof updater === 'function' ? updater(current.profile) : updater
            return { ...current, profile }
        })
    }, [])
    const setPreferences = useCallback((updater: React.SetStateAction<NotificationPreferences>) => {
        setResource((current) => {
            if (current.ownerId !== activeOwnerRef.current || !current.loaded) return current
            const preferences = typeof updater === 'function' ? updater(current.preferences) : updater
            return { ...current, preferences }
        })
    }, [])

    return {
        profile: ownsResource ? resource.profile : null,
        preferences: ownsResource ? resource.preferences : DEFAULT_NOTIFICATION_PREFERENCES,
        profileLoaded: ownsResource ? resource.loaded : false,
        profileError: ownsResource ? resource.error : null,
        retryProfile,
        setProfile,
        setPreferences,
    }
}
