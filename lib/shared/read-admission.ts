export function assertReadActive(canRead?: () => boolean): void {
    if (canRead && !canRead()) throw new Error('Read is no longer active')
}
