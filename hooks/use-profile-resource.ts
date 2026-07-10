import { useCallback, useEffect, useRef, useState } from 'react'
import { getProfile } from '@/lib/auth'
import {
    getNotificationPreferences,
    type NotificationPreferences,
} from '@/lib/notification-preferences'
import type { Profile } from '@/types/database'

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
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
}

export function useProfileResource(userId: string | undefined) {
    const activeOwnerRef = useRef(userId)
    activeOwnerRef.current = userId
    const [resource, setResource] = useState<ResourceState>({
        ownerId: userId,
        profile: null,
        preferences: DEFAULT_NOTIFICATION_PREFERENCES,
        loaded: false,
    })

    useEffect(() => {
        let cancelled = false
        if (!userId) {
            setResource({
                ownerId: undefined,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
            })
            return
        }

        const ownerId = userId
        setResource((current) => current.ownerId === ownerId
            ? { ...current, loaded: false }
            : {
                ownerId,
                profile: null,
                preferences: DEFAULT_NOTIFICATION_PREFERENCES,
                loaded: false,
            })
        Promise.all([getProfile(ownerId), getNotificationPreferences(ownerId)])
            .then(([profile, preferences]) => {
                if (cancelled || activeOwnerRef.current !== ownerId) return
                setResource({ ownerId, profile, preferences, loaded: true })
            })
            .catch((error: unknown) => {
                if (!cancelled && activeOwnerRef.current === ownerId) console.error(error)
            })
            .finally(() => {
                if (cancelled || activeOwnerRef.current !== ownerId) return
                setResource((current) => current.ownerId === ownerId
                    ? { ...current, loaded: true }
                    : current)
            })
        return () => { cancelled = true }
    }, [userId])

    const ownsResource = resource.ownerId === userId
    const setProfile = useCallback((updater: React.SetStateAction<Profile | null>) => {
        setResource((current) => {
            if (current.ownerId !== activeOwnerRef.current) return current
            const profile = typeof updater === 'function' ? updater(current.profile) : updater
            return { ...current, profile }
        })
    }, [])
    const setPreferences = useCallback((updater: React.SetStateAction<NotificationPreferences>) => {
        setResource((current) => {
            if (current.ownerId !== activeOwnerRef.current) return current
            const preferences = typeof updater === 'function' ? updater(current.preferences) : updater
            return { ...current, preferences }
        })
    }, [])

    return {
        profile: ownsResource ? resource.profile : null,
        preferences: ownsResource ? resource.preferences : DEFAULT_NOTIFICATION_PREFERENCES,
        profileLoaded: ownsResource ? resource.loaded : false,
        setProfile,
        setPreferences,
    }
}
