import { useCallback } from 'react'
import { useRouter, type Href } from 'expo-router'

/**
 * Back for a screen opened on top of a tab. A direct link or a refresh has no
 * history, and the installed iPhone app has no back swipe, so it falls back to
 * the screen this one is normally opened from.
 */
export function useGoBack(fallback: Href) {
    const router = useRouter()
    return useCallback(() => {
        if (!router.canGoBack || router.canGoBack()) router.back()
        else router.replace(fallback)
    }, [router, fallback])
}
