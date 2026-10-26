interface Window {
    __pancakePwaHolds?: Map<symbol, { reason: string; canRecover?: () => boolean }>
    __holdCreateResponse?: boolean
    __heldCreateResponse?: { status: number; path: string }
    __releaseCreateResponse?: () => void
    __confirmationShares?: ShareData[]
}
