import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openWebTarget, waitForWebTargetReads, WEB_TARGETS } from './e2e/web-targets-browser.mjs'

const driver = vi.hoisted(() => ({ launch: vi.fn(), newContext: vi.fn(), newPage: vi.fn() }))
vi.mock('playwright', () => ({ chromium: { launch: driver.launch }, webkit: { launch: driver.launch }, devices: {} }))

let page: EventEmitter & { waitForTimeout: (ms: number) => Promise<void> }

beforeEach(async () => {
    vi.useFakeTimers()
    page = Object.assign(new EventEmitter(), {
        waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        waitForLoadState: vi.fn(async () => undefined),
    })
    driver.launch.mockResolvedValue({ newContext: driver.newContext })
    driver.newContext.mockResolvedValue({ addInitScript: vi.fn(), newPage: driver.newPage })
    driver.newPage.mockResolvedValue(page)
    await openWebTarget(WEB_TARGETS[4], 'unused-capture-directory')
})

afterEach(() => { vi.useRealTimers() })

describe('web reads before a measured reload', () => {
    it('waits for current reads and their follow-up reads after the earlier document was idle', async () => {
        const first = { url: () => 'http://127.0.0.1/rest/v1/matchups' }
        const next = { url: () => 'http://127.0.0.1/rest/v1/lineup_slot_templates' }
        page.emit('request', first)
        let finished = false
        const settling = waitForWebTargetReads(page).then(() => { finished = true })
        await vi.advanceTimersByTimeAsync(1000)
        expect(finished).toBe(false)
        page.emit('requestfinished', first)
        await vi.advanceTimersByTimeAsync(400)
        page.emit('request', next)
        await vi.advanceTimersByTimeAsync(1000)
        expect(finished).toBe(false)
        page.emit('requestfailed', next)
        await vi.advanceTimersByTimeAsync(499)
        expect(finished).toBe(false)
        await vi.advanceTimersByTimeAsync(51)
        await settling
        expect(finished).toBe(true)
    })

    it('fails with the outstanding read instead of waiting without a limit', async () => {
        page.emit('request', { url: () => 'http://127.0.0.1/rest/v1/matchups' })
        const result = waitForWebTargetReads(page).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await result).toEqual(new Error('Web reads did not finish: /rest/v1/matchups'))
    })
})
