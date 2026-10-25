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
        if (Platform.OS !== 'web' || !userId || typeof window === 'undefined') return
        let stopped = false
        let running = false
        let queued = false
        let lastSuccess = 0
        const reconcile = (force = false) => {
            if (stopped || navigator.onLine === false || document.visibilityState === 'hidden') return
            if (running) { queued ||= force; return }
            if (!force && Date.now() - lastSuccess < 300000) return
            running = true
            void syncWebPushSubscription().then(() => { lastSuccess = Date.now() })
                .catch((error) => console.warn('Web push re-sync failed.', error))
                .finally(() => {
                    running = false
                    if (queued) { queued = false; reconcile(true) }
                })
        }
        const foreground = () => reconcile()
        const reconnect = () => reconcile(true)
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type === 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED') reconcile(true)
        }
        window.addEventListener('focus', foreground)
        window.addEventListener('online', reconnect)
        document.addEventListener('visibilitychange', foreground)
        navigator.serviceWorker?.addEventListener('message', onMessage)
        navigator.serviceWorker?.addEventListener('controllerchange', reconnect)
        reconcile(true)
        return () => {
            stopped = true
            window.removeEventListener('focus', foreground)
            window.removeEventListener('online', reconnect)
            document.removeEventListener('visibilitychange', foreground)
            navigator.serviceWorker?.removeEventListener('message', onMessage)
            navigator.serviceWorker?.removeEventListener('controllerchange', reconnect)
        }
    }, [userId])

    // The service worker posts tap targets to an already-open window so the SPA
    // routes client-side instead of reloading the document.
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
        const onMessage = (event: MessageEvent) => {
            if (event.data?.type !== NOTIFICATION_CLICK || typeof event.data.url !== 'string') return
            if (!event.data.url.startsWith('/') || event.data.url.startsWith('//')) return
            router.dismissTo(event.data.url as Href)
        }
        navigator.serviceWorker.addEventListener('message', onMessage)
        return () => navigator.serviceWorker.removeEventListener('message', onMessage)
    }, [router])
}
