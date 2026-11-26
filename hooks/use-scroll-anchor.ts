import { useCallback, useRef } from 'react'
import { Platform, type ScrollView, type View } from 'react-native'

type WebScroll = ScrollView & { getScrollableNode?: () => HTMLElement }

export function useScrollAnchor() {
    const scroller = useRef<HTMLElement | null>(null)
    const lead = useRef<HTMLElement | null>(null)
    const stop = useRef<(() => void) | null>(null)
    const connect = useCallback(() => {
        stop.current?.()
        stop.current = null
        const scrollNode = scroller.current
        const leadNode = lead.current
        if (!scrollNode || !leadNode || typeof ResizeObserver === 'undefined') return
        scrollNode.style.overflowAnchor = 'none'
        let height = leadNode.offsetHeight
        let anchor: Element | null = null
        let anchorTop = 0
        const track = () => {
            if (leadNode.offsetHeight !== height) return
            const top = scrollNode.getBoundingClientRect().top
            anchor = [...Array.from(leadNode.children), leadNode.nextElementSibling].find(node => node && node.getBoundingClientRect().bottom > top) ?? null
            anchorTop = anchor?.getBoundingClientRect().top ?? 0
        }
        const observer = new ResizeObserver(() => {
            height = leadNode.offsetHeight
            if (anchor?.isConnected) scrollNode.scrollTop = Math.max(0, scrollNode.scrollTop + anchor.getBoundingClientRect().top - anchorTop)
            track()
        })
        track()
        scrollNode.addEventListener('scroll', track, { passive: true })
        observer.observe(leadNode)
        stop.current = () => {
            observer.disconnect()
            scrollNode.removeEventListener('scroll', track)
        }
    }, [])
    const scrollRef = useCallback((node: ScrollView | null) => {
        scroller.current = Platform.OS === 'web' ? (node as WebScroll | null)?.getScrollableNode?.() ?? null : null
        connect()
    }, [connect])
    const leadRef = useCallback((node: View | null) => {
        lead.current = Platform.OS === 'web' ? node as unknown as HTMLElement | null : null
        connect()
    }, [connect])
    return {
        scrollRef,
        leadRef,
        scrollProps: Platform.OS === 'web' ? {} : { maintainVisibleContentPosition: { minIndexForVisible: 1 } },
    }
}
