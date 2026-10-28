import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

export function readScreenSection(accountId: string | undefined, memberId: string | undefined, screen: string): string | undefined {
    if (!accountId || !memberId) return undefined
    return readPersistentCache<string>(`pancake:screen-section:v1:${accountId}:${memberId}:${screen}`) ?? undefined
}

export function saveScreenSection(accountId: string | undefined, memberId: string | undefined, screen: string, section: string): void {
    if (accountId && memberId) writePersistentCache(`pancake:screen-section:v1:${accountId}:${memberId}:${screen}`, section)
}
