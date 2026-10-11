import { useEffect } from 'react'
import { Platform } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { useAuth } from '@/hooks/use-auth'
import { syncWebPushSubscription } from '@/lib/web-push'

const NOTIFICATION_CLICK = 'PANCAKE_NOTIFICATION_CLICK'

/** Keeps this device's Web Push subscription attached to the signed-in user. */
export function useWebPushNotifications() {
    const { user } = useAuth()
    const userId = user?.id
    const router = useRouter()

    useEffect(() => {
        if (Platform.OS !== 'web' || !userId) return
        syncWebPushSubscription().catch((error) => console.warn('Web push re-sync failed.', error))
    }, [userId])

    // The service worker posts tap targets to an already-open window so the SPA
    // routes client-side instead of reloading the document.
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type !== NOTIFICATION_CLICK || typeof event.data.url !== 'string') return
            if (!event.data.url.startsWith('/') || event.data.url.startsWith('//')) return
            router.push(event.data.url as Href)
        }
        navigator.serviceWorker.addEventListener('message', onMessage)
        return () => navigator.serviceWorker.removeEventListener('message', onMessage)
    }, [router])
}
