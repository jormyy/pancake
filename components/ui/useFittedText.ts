import { useLayoutEffect, useRef } from 'react'
import { Platform, type Text } from 'react-native'

export function useFittedText(label: string, enabled = true, inset = 0) {
    const ref = useRef<Text>(null)
    useLayoutEffect(() => {
        if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return
        const node = ref.current as unknown as HTMLElement | null
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        let disposed = false
        const original = node.style.fontSize
        const base = parseFloat(getComputedStyle(node).fontSize)
        const fit = () => {
            if (disposed || !Number.isFinite(base)) return
            node.style.fontSize = original
            const available = Math.max(0, node.clientWidth - inset)
            const required = node.scrollWidth
            if (available > 0 && required > available) node.style.fontSize = `${base * available / required}px`
        }
        fit()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
        observer?.observe(node)
        if (node.parentElement) observer?.observe(node.parentElement)
        void document.fonts?.ready.then(fit)
        return () => { disposed = true; observer?.disconnect(); node.style.fontSize = original }
    }, [enabled, label, inset])
    return ref
}
