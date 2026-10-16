import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openWebTarget, WEB_TARGETS } from './e2e/web-targets-browser.mjs'
import { webTargetGeometryReady } from './e2e/web-targets-geometry.mjs'

const driver = vi.hoisted(() => ({ launch: vi.fn(), newContext: vi.fn(), newPage: vi.fn(), addInitScript: vi.fn() }))
vi.mock('playwright', () => ({ chromium: { launch: driver.launch }, webkit: { launch: driver.launch }, devices: {} }))

type Frame = { phase: string; source?: string; first: { y: number } | null }

async function stalledPaintPage() {
    let populated = false
    let visibleHeading = true
    let headingY = 120
    const rectangle = () => ({ x: 0, y: headingY, width: 200, height: 40 })
    const heading = { getClientRects: () => [rectangle()], getBoundingClientRect: rectangle }
    const main = { ...heading, firstElementChild: heading, querySelectorAll: () => populated && visibleHeading ? [heading] : [] }
    const window = { matchMedia: () => ({}), addEventListener: vi.fn() }
    const scope = {
        window, navigator: {},
        document: { querySelector: (selector: string) => {
            if (selector === '[role="main"]') return main
            if (selector === '[aria-label="Open menu"]') return { parentElement: heading }
            if (selector === '[role="navigation"][aria-label="Primary"]') return heading
            if (selector === '[data-populated]') return populated ? heading : null
            return null
        } },
        CSSStyleSheet: class { insertRule() {} }, Element: class {},
        MutationObserver: class { observe() {} disconnect() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        getComputedStyle: () => ({ display: 'block' }),
        performance: { now: () => Date.now() },
        requestAnimationFrame: vi.fn(() => 1),
        setInterval, clearInterval, setTimeout, clearTimeout,
    }
    driver.launch.mockResolvedValue({ newContext: driver.newContext })
    driver.newContext.mockResolvedValue({ addInitScript: driver.addInitScript, newPage: driver.newPage })
    driver.newPage.mockResolvedValue(new EventEmitter())
    await openWebTarget(WEB_TARGETS[0], 'unused-capture-directory')
    for (const [script, argument] of driver.addInitScript.mock.calls) {
        runInNewContext(`(${script.toString()})(${JSON.stringify(argument)})`, scope)
    }
    return {
        frames: () => Reflect.get(window, '__webTargetFrames') as Frame[],
        populate: () => { populated = true },
        hideHeading: () => { visibleHeading = false },
        move: (y: number) => { headingY = y },
        animationFrame: scope.requestAnimationFrame,
        checkpoint: (id: number) => Reflect.set(window, '__webTargetGeometryCheckpoint', { id, selector: '[data-populated]' }),
        ready: (checkpoint: number) => runInNewContext(`(${webTargetGeometryReady.toString()})(${JSON.stringify({ checkpoint, mobile: true, requireFirstContent: true })})`, scope),
    }
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('web layout when the engine stops rendering updates', () => {
    it('records populated geometry without an animation callback and identifies the sample source', async () => {
        const page = await stalledPaintPage()
        await vi.advanceTimersByTimeAsync(100)
        expect(page.frames().filter((frame) => frame.first)).toHaveLength(0)
        page.populate()
        await vi.advanceTimersByTimeAsync(150)
        const populated = page.frames().filter((frame) => frame.phase === 'app' && frame.first)
        expect(populated.length).toBeGreaterThanOrEqual(2)
        expect(populated.every((frame) => frame.first?.y === 120)).toBe(true)
        expect(populated.some((frame) => frame.source === 'timer')).toBe(true)
        expect(page.animationFrame).toHaveBeenCalled()
        expect(page.frames().some((frame) => frame.source === 'animation-frame')).toBe(false)
    })

    it('requires populated rows and two later geometry readings from the same readiness checkpoint', async () => {
        const page = await stalledPaintPage()
        page.checkpoint(1)
        await vi.advanceTimersByTimeAsync(150)
        expect(page.ready(1)).toBe(false)
        page.populate()
        await vi.advanceTimersByTimeAsync(50)
        expect(page.ready(1)).toBe(false)
        await vi.advanceTimersByTimeAsync(50)
        expect(page.ready(1)).toBe(true)
        page.checkpoint(2)
        expect(page.ready(2)).toBe(false)
        await vi.advanceTimersByTimeAsync(100)
        expect(page.ready(2)).toBe(true)
    })

    it('rejects stable chrome when the first populated content has no geometry', async () => {
        const page = await stalledPaintPage()
        page.populate()
        page.hideHeading()
        page.checkpoint(1)
        await vi.advanceTimersByTimeAsync(500)
        expect(page.frames().filter((frame) => frame.phase === 'app').length).toBeGreaterThan(2)
        expect(page.ready(1)).toBe(false)
    })

    it('keeps actual movement in the record when animation callbacks never arrive', async () => {
        const page = await stalledPaintPage()
        page.populate()
        await vi.advanceTimersByTimeAsync(100)
        page.move(123)
        await vi.advanceTimersByTimeAsync(100)
        const positions = page.frames().flatMap((frame) => frame.first ? [frame.first.y] : [])
        expect(positions.length).toBeGreaterThanOrEqual(2)
        expect(Math.max(...positions) - Math.min(...positions)).toBe(3)
    })
})
