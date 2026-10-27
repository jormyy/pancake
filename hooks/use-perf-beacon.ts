import { useEffect, useLayoutEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { usePathname, useNavigationContainerRef, useGlobalSearchParams } from 'expo-router'
import Constants from 'expo-constants'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { API_URL } from '@/lib/shared/api'
import { createRequestId } from '@/lib/api-client'
import { beaconScreen, createPerfBeacon, observeUsefulContent } from '@/lib/perf-beacon'

export function PerfBeacon() {
    usePerfBeacon()
    return null
}

function usePerfBeacon() {
    const path = usePathname()
    const params = useGlobalSearchParams()
    const paramsKey = JSON.stringify(Object.entries(params).sort(([left], [right]) => left.localeCompare(right)))
    const routeKey = `${path}:${paramsKey}`
    const navigation = useNavigationContainerRef()
    const { session } = useAuth()
    const { current } = useLeagueContext()
    const collector = useRef<ReturnType<typeof createPerfBeacon> | null>(null)
    const opened = useRef(false)
    const lastOpen = useRef('')
    const began = useRef(0)
    const previousPath = useRef<string | null>(null)
    const memberId = current?.id
    const token = session?.access_token
    const userId = session?.user.id
    const credentials = useRef({ token, userId, memberId })
    credentials.current = { token, userId, memberId }

    useEffect(() => {
        if (Platform.OS !== 'web') return
        return navigation.addListener('state', () => { began.current = performance.now() })
    }, [navigation])

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !userId || !memberId) return
        const client = createPerfBeacon({
            now: () => performance.now(), online: () => navigator.onLine,
            schedule: (callback, delay) => setTimeout(callback, delay),
            cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            sampleN: Number(process.env.EXPO_PUBLIC_PERF_SAMPLE_N) || 1,
            send: async (rows) => {
                const auth = credentials.current
                if (!auth.token || auth.userId !== userId || auth.memberId !== memberId) return
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 5000)
                try {
                    await fetch(`${API_URL.replace(/\/$/, '')}/beacons`, { method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}`, 'x-request-id': createRequestId() },
                        body: JSON.stringify({ member_id: memberId, beacons: rows }), signal: controller.signal })
                } finally { clearTimeout(timeout) }
            },
        })
        collector.current = client
        window.addEventListener('offline', client.drop)
        return () => { client.stop(); collector.current = null; lastOpen.current = ''; window.removeEventListener('offline', client.drop) }
    }, [userId, memberId])

    useLayoutEffect(() => {
        if (routeKey !== previousPath.current) {
            previousPath.current = routeKey
            if (opened.current && began.current === 0) began.current = performance.now()
        }
    }, [routeKey])

    useEffect(() => {
        if (Platform.OS !== 'web' || !collector.current || typeof document === 'undefined') return
        const screen = beaconScreen(path)
        const identity = `${memberId}:${routeKey}`
        if (!screen) { lastOpen.current = ''; return }
        if (lastOpen.current === identity) return
        lastOpen.current = identity
        const cold = !opened.current
        opened.current = true
        const start = cold ? 0 : began.current || performance.now()
        began.current = 0
        const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType
        const observation = collector.current.open(screen, start, {
            cold, device_class: matchMedia('(pointer: coarse)').matches ? (innerWidth < 768 ? 'phone' : 'tablet') : 'desktop',
            connection_type: connection === 'slow-2g' || connection === '2g' || connection === '3g' || connection === '4g' ? connection : 'unknown',
            app_version: (Constants.expoConfig?.version ?? 'unknown').slice(0, 40),
        })
        if (!observation.selected) return
        return observeUsefulContent(screen, start, () => {
            observation.painted(performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        }, observation.cancel)
    }, [path, routeKey, userId, memberId])
}
