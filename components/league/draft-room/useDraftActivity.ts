import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { usePanelActivity } from '@/contexts/panel-activity'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { onLifecycle, readsAllowed } from '@/lib/lifecycle'

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
    const epochRef = useRef(0)
    const readyRef = useRef<number | null>(null)
    const [, render] = useState(0)
    const environmentAllowsReads = readsAllowed
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
    const canQueue = useCallback(() => Boolean(ownerKey) && mountedRef.current && ownerRef.current === identity && focusRef.current && user != null && sessionGeneration() === generation && sessionOwner() === user, [ownerKey, identity, user, generation])
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
        const update = () => {
            if (!active) return
            const next = focusRef.current && environmentAllowsReads()
            if (next === availableRef.current) return
            availableRef.current = next
            invalidate()
        }
        const stop = onLifecycle(['visible', 'hidden', 'online', 'offline'], update)
        return () => {
            active = false
            mountedRef.current = false
            readyRef.current = null
            stop()
        }
    }, [identity, invalidate, environmentAllowsReads])
    return { identity, capture, epoch: epochRef.current, canRead, isCurrent, canAct, canQueue, markReady, blockActions, ready: canAct() }
}
