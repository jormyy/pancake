import { onSessionCachesCleared } from '@/lib/session-cache-registry'

const revisions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

export function memberClaimsRevision(memberId: string): number {
    return revisions.get(memberId) ?? 0
}

export function notifyMemberClaimsChanged(memberId: string): void {
    revisions.set(memberId, memberClaimsRevision(memberId) + 1)
    for (const listener of listeners.get(memberId) ?? []) listener()
}

export function listenForMemberClaimsChanges(memberId: string, listener: () => void): () => void {
    let group = listeners.get(memberId)
    if (!group) { group = new Set(); listeners.set(memberId, group) }
    group.add(listener)
    return () => { group.delete(listener); if (!group.size) listeners.delete(memberId) }
}

onSessionCachesCleared(() => revisions.clear())
