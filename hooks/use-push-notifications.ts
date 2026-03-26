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

export function usePushNotifications() {
    const { user } = useAuth()

    useEffect(() => {
        if (!user) return

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

            let token: string
            try {
                const tokenData = await Notifications.getExpoPushTokenAsync()
                token = tokenData.data
            } catch {
                // No EAS project ID — push tokens unavailable in dev builds without EAS
                return
            }

            // Save to Supabase profile
            if (!user) return
            await supabase
                .from('profiles')
                .update({ push_token: token } as any)
                .eq('id', user.id)
        }

        register().catch(console.error)
    }, [user])
}
