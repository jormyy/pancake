import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import { usePanelActivity } from '@/contexts/panel-activity'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'

export function useDraftActivity(ownerKey: string | null) {
    const routeFocused = useIsFocused()
    const panelActive = usePanelActivity()
    const focused = routeFocused && panelActive
    const generation = sessionGeneration()
    const user = sessionOwner()
    const bindingRef = useRef({ key: ownerKey, user, generation })
    if (bindingRef.current.key !== ownerKey || bindingRef.current.user === undefined && user) {
        bindingRef.current = { key: ownerKey, user, generation }
    }
    const identity = JSON.stringify([ownerKey, user, generation])
    const ownerRef = useRef(identity)
    const focusRef = useRef(focused)
    const mountedRef = useRef(true)
    const appStateRef = useRef(AppState.currentState)
    const epochRef = useRef(0)
    const readyRef = useRef<number | null>(null)
    const [, render] = useState(0)
    const environmentAllowsReads = useCallback(() => appStateRef.current === 'active' && AppState.currentState === 'active'
        && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        && (typeof navigator === 'undefined' || navigator.onLine !== false), [])
    const availableRef = useRef(focused && environmentAllowsReads())
    if (ownerRef.current !== identity || focusRef.current !== focused) {
        ownerRef.current = identity
        focusRef.current = focused
        epochRef.current += 1
        readyRef.current = null
    }
    const canRead = useCallback(() => Boolean(ownerKey) && mountedRef.current && ownerRef.current === identity
        && focusRef.current && environmentAllowsReads() && user != null
        && sessionGeneration() === generation && sessionOwner() === user
        && bindingRef.current.user === user && bindingRef.current.generation === generation,
    [identity, ownerKey, user, generation, environmentAllowsReads])
    const capture = useCallback(() => epochRef.current, [])
    const isCurrent = useCallback((epoch: number) => canRead() && epochRef.current === epoch, [canRead])
    const canAct = useCallback(() => canRead() && readyRef.current === epochRef.current, [canRead])
    const markReady = useCallback((epoch: number) => {
        if (!isCurrent(epoch)) return
        readyRef.current = epoch
        render(value => value + 1)
    }, [isCurrent])
    const blockActions = useCallback(() => {
        if (readyRef.current === null) return
        readyRef.current = null
        render(value => value + 1)
    }, [])
    const invalidate = useCallback(() => {
        epochRef.current += 1
        readyRef.current = null
        render(value => value + 1)
    }, [])
    useEffect(() => {
        mountedRef.current = true
        let active = true
        appStateRef.current = AppState.currentState
        const update = () => {
            if (!active) return
            const next = focusRef.current && environmentAllowsReads()
            if (next === availableRef.current) return
            availableRef.current = next
            invalidate()
        }
        const subscription = AppState.addEventListener('change', next => {
            if (!active) return
            appStateRef.current = next
            update()
        })
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
        if (typeof window !== 'undefined') {
            window.addEventListener('online', update)
            window.addEventListener('offline', update)
        }
        return () => {
            active = false
            mountedRef.current = false
            readyRef.current = null
            subscription.remove()
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update)
            if (typeof window !== 'undefined') {
                window.removeEventListener('online', update)
                window.removeEventListener('offline', update)
            }
        }
    }, [identity, invalidate, environmentAllowsReads])
    return { identity, capture, epoch: epochRef.current, canRead, isCurrent, canAct, markReady, blockActions, ready: canAct() }
}
