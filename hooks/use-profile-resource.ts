import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { listenForProfileUpdates } from '@/lib/profile-updates'
import { getProfile, suspendProfileRead } from '@/lib/auth'
import {
    DEFAULT_NOTIFICATION_PREFERENCES,
    getNotificationPreferences,
    type NotificationPreferences,
} from '@/lib/notification-preferences'
import type { Profile } from '@/types/database'

type ResourceState = {
    ownerId: string | undefined
    resourceType: 'profile' | 'preferences'
    profile: Profile | null
    preferences: NotificationPreferences
    loaded: boolean
    error: string | null
}

function errorMessage(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message ? reason.message : fallback
}

export function useProfileResource(userId: string | undefined, resourceType: 'profile' | 'preferences' = 'profile') {
    const { active, revision, isCurrent } = useBrowserReadActivity()
    const activeOwnerRef = useRef(userId)
    activeOwnerRef.current = userId
    const [resource, setResource] = useState<ResourceState>({
        ownerId: userId,
        resourceType,
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
                resourceType,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
                error: null,
            })
            return
        }

        if (!isCurrent(revision)) return
        const ownerId = userId
        setResource((current) => current.ownerId === ownerId && current.resourceType === resourceType
            ? { ...current, error: null }
            : {
                ownerId,
                resourceType,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
                error: null,
            })
        const [profileResult, preferencesResult] = await Promise.allSettled([
            resourceType === 'profile' ? getProfile(ownerId, options) : Promise.resolve(null),
            resourceType === 'preferences' ? getNotificationPreferences(ownerId) : Promise.resolve(DEFAULT_NOTIFICATION_PREFERENCES),
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
        setResource((current) => current.ownerId === ownerId && current.resourceType === resourceType ? {
            ownerId,
            resourceType,
            profile: profileResult.status === 'fulfilled' ? profileResult.value : current.profile,
            preferences: preferencesResult.status === 'fulfilled'
                ? preferencesResult.value
                : current.preferences,
            loaded: errors.length === 0,
            error: errors.length > 0 ? errors.join(' ') : null,
        } : current)
    }, [userId, resourceType, revision, isCurrent])

    useEffect(() => {
        if (active) void load({ force: revision > 0 })
        else if (userId && resourceType === 'profile') suspendProfileRead(userId)
        return () => { requestRef.current += 1 }
    }, [load, userId, resourceType, active, revision])

    useEffect(() => {
        if (!userId || resourceType !== 'profile') return
        return listenForProfileUpdates(userId, patch => {
            setResource(current => current.ownerId === userId && current.profile
                ? { ...current, profile: { ...current.profile, ...patch } } : current)
        })
    }, [userId, resourceType])

    const retryProfile = useCallback(() => load({ force: true }), [load])
    const ownsResource = resource.ownerId === userId && resource.resourceType === resourceType
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
