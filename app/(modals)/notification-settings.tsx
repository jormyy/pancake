import { useEffect, useRef } from 'react'
import { Platform, ScrollView, StyleSheet } from 'react-native'
import { Stack } from 'expo-router'
import { useAuth } from '@/hooks/use-auth'
import { useProfileResource } from '@/hooks/use-profile-resource'
import { NotificationSettings } from '@/components/settings/NotificationSettings'
import { WebPushSettings } from '@/components/WebPushSettings'
import { ErrorBanner, usePageMetrics } from '@/components/ui'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { useGoBack } from '@/components/ui/useGoBack'
import { createNotificationPreferenceWriter, updateNotificationPreferences, type NotificationPreferences } from '@/lib/notification-preferences'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { layout, spacing } from '@/constants/tokens'

export default function NotificationSettingsScreen() {
    const { user } = useAuth()
    const back = useGoBack('/profile')
    const { padX } = usePageMetrics()
    const { preferences, profileLoaded, profileError, retryProfile, setPreferences } = useProfileResource(user?.id)
    const owner = `${user?.id ?? ''}:${sessionGeneration()}`
    const state = useRef({ owner, preferences, writer: createNotificationPreferenceWriter(
        next => user ? updateNotificationPreferences(user.id, next) : Promise.resolve(),
    ) })
    if (state.current.owner !== owner) state.current = { owner, preferences, writer: createNotificationPreferenceWriter(
        next => user ? updateNotificationPreferences(user.id, next) : Promise.resolve(),
    ) }
    state.current.preferences = preferences
    const activeOwner = useRef<string | null>(owner)
    activeOwner.current = owner
    useEffect(() => () => { activeOwner.current = null }, [])
    function change(update: (current: NotificationPreferences) => NotificationPreferences) {
        if (!user || !profileLoaded) return
        const session = state.current
        const next = update(session.preferences)
        session.preferences = next
        setPreferences(next)
        void session.writer.enqueue(next).catch(async error => {
            if (activeOwner.current !== session.owner) return
            if (state.current.preferences === next) await retryProfile()
            if (activeOwner.current === session.owner) showAlert('Error', getErrorMessage(error))
        })
    }
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <ModalScreen title="Notifications" onBack={back}>
                <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
                    {profileError ? <ErrorBanner message={profileError} onRetry={retryProfile} /> : null}
                    {profileLoaded ? <NotificationSettings preferences={preferences} disabled={false} onChange={change} /> : null}
                    {Platform.OS === 'web' ? <WebPushSettings key={owner} /> : null}
                </ScrollView>
            </ModalScreen>
        </>
    )
}

const styles = StyleSheet.create({
    content: { paddingTop: spacing.md, paddingBottom: spacing['4xl'], gap: spacing.lg, width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center' },
})
