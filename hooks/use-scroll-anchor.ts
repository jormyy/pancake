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
        const content = scrollNode.firstElementChild instanceof HTMLElement ? scrollNode.firstElementChild : null
        const basePadding = content ? parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0
        let spacer = 0
        const setSpacer = (next: number) => {
            spacer = Math.max(0, Math.round(next))
            if (content) content.style.paddingBottom = spacer ? `${basePadding + spacer}px` : ''
        }
        const trimSpacer = () => {
            if (spacer) setSpacer(spacer - (scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop))
        }
        let height = leadNode.offsetHeight
        let anchor: Element | null = null
        let anchorTop = 0
        const track = () => {
            if (leadNode.offsetHeight !== height) return
            trimSpacer()
            const top = scrollNode.getBoundingClientRect().top
            anchor = [...Array.from(leadNode.children), leadNode.nextElementSibling].find(node => node && node.getBoundingClientRect().bottom > top) ?? null
            anchorTop = anchor?.getBoundingClientRect().top ?? 0
        }
        const observer = new ResizeObserver(() => {
            height = leadNode.offsetHeight
            if (anchor?.isConnected) {
                const wanted = Math.max(0, scrollNode.scrollTop + anchor.getBoundingClientRect().top - anchorTop)
                const shortfall = wanted - (scrollNode.scrollHeight - scrollNode.clientHeight)
                if (shortfall > 0) setSpacer(spacer + shortfall)
                scrollNode.scrollTop = wanted
            }
            track()
        })
        track()
        scrollNode.addEventListener('scroll', track, { passive: true })
        observer.observe(leadNode)
        stop.current = () => {
            observer.disconnect()
            scrollNode.removeEventListener('scroll', track)
            setSpacer(0)
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
