export function nextRovingIndex(currentIndex: number, key: string, count: number): number | null {
    if (count <= 0) return null
    if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % count
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return null
}
