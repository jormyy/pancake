import { useCallback, useEffect, useState } from 'react'
import { useScreenView } from '@/hooks/use-screen-view'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { listenForProfileUpdates } from '@/lib/profile-updates'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@/lib/notification-preferences'
import type { Profile } from '@/types/database'

type ProfileView = { profile: Profile | null; preferences: NotificationPreferences }

export function useProfileResource(userId: string | undefined, resourceType: 'profile' | 'preferences' = 'profile') {
    const activity = useBrowserReadActivity()
    const view = useScreenView<ProfileView>(userId ? { accountId: userId, screen: 'profile' } : null, activity.active)
    const refreshView = view.refresh
    const [patch, setPatch] = useState<{ owner: string | undefined; base?: ProfileView; profile?: Profile | null; preferences?: NotificationPreferences }>({ owner: userId })
    const selected = patch.owner === userId && patch.base === view.data ? patch : undefined
    const profile = selected?.profile ?? view.data?.profile ?? null
    const preferences = selected?.preferences ?? view.data?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES
    const setProfile = useCallback((update: React.SetStateAction<Profile | null>) => setPatch(previous => ({ owner: userId, base: view.data, profile: typeof update === 'function' ? update(previous.owner === userId && previous.base === view.data ? previous.profile ?? view.data?.profile ?? null : view.data?.profile ?? null) : update, preferences: previous.owner === userId ? previous.preferences : undefined })), [userId, view.data])
    const setPreferences = useCallback((update: React.SetStateAction<NotificationPreferences>) => setPatch(previous => ({ owner: userId, base: view.data, profile: previous.owner === userId ? previous.profile : undefined, preferences: typeof update === 'function' ? update(previous.owner === userId && previous.base === view.data ? previous.preferences ?? view.data?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES : view.data?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES) : update })), [userId, view.data])
    useEffect(() => userId && resourceType === 'profile' ? listenForProfileUpdates(userId, change => { setProfile(previous => previous ? { ...previous, ...change } : previous) }) : undefined, [userId, resourceType, setProfile])
    const retryProfile = useCallback(async () => { await refreshView(true) }, [refreshView])
    return { profile, preferences, profileLoaded: view.loaded, profileError: view.error?.message ?? null, retryProfile, setProfile, setPreferences }
}
