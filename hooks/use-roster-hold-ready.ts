import { useEffect, useState } from 'react'
import { probeRosterHoldReady } from '@/lib/waivers'

const readyByMember = new Map<string, boolean>()
const inFlight = new Map<string, Promise<boolean>>()

function probe(memberId: string): Promise<boolean> {
    const existing = inFlight.get(memberId)
    if (existing) return existing
    const request = probeRosterHoldReady(memberId).then((ready) => {
        inFlight.delete(memberId)
        if (ready) readyByMember.set(memberId, true)
        return ready
    }, () => {
        inFlight.delete(memberId)
        return false
    })
    inFlight.set(memberId, request)
    return request
}

export function useRosterHoldReady(memberId: string | undefined): boolean {
    const [ready, setReady] = useState(() => (memberId ? readyByMember.get(memberId) === true : false))
    useEffect(() => {
        if (!memberId) {
            setReady(false)
            return
        }
        if (readyByMember.get(memberId)) {
            setReady(true)
            return
        }
        let active = true
        setReady(false)
        void probe(memberId).then((next) => { if (active) setReady(next) })
        return () => { active = false }
    }, [memberId])
    return ready
}
