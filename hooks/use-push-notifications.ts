import { useEffect } from 'react'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { Platform } from 'react-native'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/use-auth'

// Show notifications as banners while the app is in foreground
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
})

const PUSH_TOKEN_RETRY_DELAYS_MS = [1_000, 5_000]

export function classifyPushTokenError(error: unknown): 'configuration' | 'retryable' {
    const message = error instanceof Error ? error.message : String(error)
    return /project\s*id|projectid|experienceid|eas project/i.test(message) ? 'configuration' : 'retryable'
}

export function usePushNotifications() {
    const { user } = useAuth()
    const userId = user?.id

    useEffect(() => {
        if (!userId) return
        const registeredUserId = userId
        let active = true
        let retryTimer: ReturnType<typeof setTimeout> | null = null

        async function acquireAndSaveToken(attempt: number): Promise<void> {
            let token: string
            try {
                const tokenData = await Notifications.getExpoPushTokenAsync()
                token = tokenData.data
            } catch (error) {
                if (classifyPushTokenError(error) === 'configuration') {
                    console.warn('Push notifications are not configured for this build.', error)
                    return
                }
                console.error('Could not acquire an Expo push token.', error)
                const delay = PUSH_TOKEN_RETRY_DELAYS_MS[attempt]
                if (!active || delay == null) return
                retryTimer = setTimeout(() => {
                    retryTimer = null
                    void acquireAndSaveToken(attempt + 1).catch(console.error)
                }, delay)
                return
            }

            if (!active) return
            const { error } = await supabase
                .from('profiles')
                .update({ push_token: token })
                .eq('id', registeredUserId)
            if (error) throw error
        }

        async function register() {
            // Push notifications only work on physical devices
            if (!Device.isDevice) return

            const { status: existing } = await Notifications.getPermissionsAsync()
            let finalStatus = existing

            if (existing !== 'granted') {
                const { status } = await Notifications.requestPermissionsAsync()
                finalStatus = status
            }

            if (finalStatus !== 'granted') return

            // Android needs a notification channel
            if (Platform.OS === 'android') {
                await Notifications.setNotificationChannelAsync('default', {
                    name: 'Pancake',
                    importance: Notifications.AndroidImportance.MAX,
                    vibrationPattern: [0, 250, 250, 250],
                })
            }

            await acquireAndSaveToken(0)
        }

        register().catch(console.error)
        return () => {
            active = false
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [userId])
}
