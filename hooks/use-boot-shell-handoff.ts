import { useEffect, useLayoutEffect } from 'react'
import { Platform } from 'react-native'
import { BOOT_SHELL_ID } from '@/constants/boot-shell'

// The static boot shell in app/+html.tsx paints the app chrome before the JS
// bundle mounts React. This removes it in the same frame the real chrome first
// paints, so the handoff shows no flicker and no duplicated navigation.
//
// useLayoutEffect runs after the DOM is updated but before the browser paints,
// which is exactly the swap point. Static export prerenders on the server where
// layout effects do not run, so fall back to useEffect there.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useBootShellHandoff(): void {
    useBrowserLayoutEffect(() => {
        if (Platform.OS !== 'web') return
        document.getElementById(BOOT_SHELL_ID)?.remove()
        document.documentElement.removeAttribute('data-pancake-boot')
    }, [])
}
