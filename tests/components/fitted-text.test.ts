import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useFittedText } from '@/components/ui/useFittedText'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.unstubAllGlobals())
it('shrinks long names to the available web width and restores the font on disposal', async () => {
    let width = 50
    let resized = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal('document', {})
    vi.stubGlobal('getComputedStyle', () => ({ fontSize: '20px' }))
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resized = callback }
        observe() {}
        disconnect = disconnect
    })
    const node = { style: { fontSize: '' }, clientWidth: width, scrollWidth: 100, getBoundingClientRect: () => ({ width }), parentElement: null }
    function Name() { return React.createElement('span', { ref: useFittedText('Antetokounmpo') }, 'Antetokounmpo') }
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(Name), { createNodeMock: () => node }) })
    expect(node.style.fontSize).toBe('10px')
    width = 25
    node.clientWidth = width
    resized()
    expect(node.style.fontSize).toBe('5px')
    await act(async () => screen.unmount())
    expect(node.style.fontSize).toBe('')
    expect(disconnect).toHaveBeenCalledOnce()
})
