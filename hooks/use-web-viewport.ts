import { useEffect, useState } from 'react'
import { Platform, useWindowDimensions } from 'react-native'

/**
 * Viewport size that tracks window.innerWidth/innerHeight on web (where the
 * static export can hydrate with stale RN dimensions) and falls back to
 * useWindowDimensions on native. Also derives the shared compact-landscape
 * breakpoint (wide but short viewports, e.g. phones rotated sideways).
 */
export function useWebViewport() {
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState<{ width: number; height: number } | null>(null)

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])

    const viewportWidth = Platform.OS === 'web' && webViewport !== null ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' && webViewport !== null ? webViewport.height : height

    return {
        viewportWidth,
        viewportHeight,
        compactLandscape: viewportWidth >= 600 && viewportHeight < 500,
    }
}
