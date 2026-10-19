import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Avatar } from '@/components/Avatar'

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://localhost' }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let intersect: IntersectionObserverCallback
const disconnect = vi.fn()
const observe = vi.fn()
const node = {}
const render = (uri: string) => React.createElement(Avatar, { name: 'Test Player', uri, size: 44 })
const images = () => screen.root.findAllByType('Image' as React.ElementType)
const enter = async () => { await act(async () => { intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver) }) }

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
            intersect = callback
            expect(options.rootMargin).toBe('128px')
        }
        observe = observe
        disconnect = disconnect
    })
})
afterEach(async () => {
    await act(async () => { screen?.unmount() })
    vi.unstubAllGlobals()
})

it('keeps initials and dimensions until the image enters the viewport margin', async () => {
    await act(async () => { screen = create(render('near.png'), { createNodeMock: () => node }) })
    expect(images()).toHaveLength(0)
    expect(screen.root.findByType('Text' as React.ElementType).props.children).toBe('TP')
    expect(screen.root.findByType('View' as React.ElementType).props.style[1]).toMatchObject({ width: 44, height: 44 })
    expect(observe).toHaveBeenCalledWith(node)
    await enter()
    expect(images()[0].props.source.uri).toBe('near.png')
    await act(async () => { images()[0].props.onLoad() })
    await act(async () => { screen.unmount(); screen = create(render('near.png'), { createNodeMock: () => node }) })
    expect(images()[0].props.source.uri).toBe('near.png')
})

it('resets eligibility on URI replacement and keeps initials after a failed image', async () => {
    await act(async () => { screen = create(render('first.png'), { createNodeMock: () => node }) })
    await enter()
    await act(async () => { images()[0].props.onError() })
    expect(images()).toHaveLength(0)
    await act(async () => { screen.update(render('replacement.png')) })
    expect(images()).toHaveLength(0)
    await enter()
    expect(images()[0].props.source.uri).toBe('replacement.png')
})

it('loads immediately when intersection observation is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    await act(async () => { screen = create(render('fallback.png'), { createNodeMock: () => node }) })
    expect(images()[0].props.source.uri).toBe('fallback.png')
})
