import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWebTargetBrowserCommand } from './e2e/web-targets-agent.mjs'
import { openWebTarget, waitForWebTargetReads, navigateWebTarget, reloadWebTarget, WEB_TARGETS } from './e2e/web-targets-browser.mjs'

const driver = vi.hoisted(() => ({ launch: vi.fn(), newContext: vi.fn(), newPage: vi.fn() }))
vi.mock('playwright', () => ({ chromium: { launch: driver.launch }, webkit: { launch: driver.launch }, devices: {} }))

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))

const mainFrame = { url: vi.fn(() => 'http://127.0.0.1:8082/') }
const readRequest = (url: string, navigation = false) => ({
    url: () => url, method: () => 'GET', isNavigationRequest: () => navigation, frame: () => mainFrame,
})

let page: EventEmitter & { mainFrame: () => object; url: () => string; viewportSize: () => { width: number; height: number }; waitForTimeout: (ms: number) => Promise<void>; goto: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> }

beforeEach(async () => {
    vi.useFakeTimers()
    mainFrame.url.mockReturnValue('http://127.0.0.1:8082/')
    page = Object.assign(new EventEmitter(), {
        waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        waitForLoadState: vi.fn(async () => undefined), goto: vi.fn(), reload: vi.fn(),
        mainFrame: () => mainFrame, url: () => 'http://127.0.0.1:8082/', viewportSize: () => ({ width: 1280, height: 720 }),
    })
    driver.launch.mockResolvedValue({ newContext: driver.newContext })
    driver.newContext.mockResolvedValue({ addInitScript: vi.fn(), newPage: driver.newPage })
    driver.newPage.mockResolvedValue(page)
    await openWebTarget(WEB_TARGETS[4], 'unused-capture-directory')
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('web reads before a measured reload', () => {
    it('waits for current reads and their follow-up reads after the earlier document was idle', async () => {
        const first = readRequest('http://127.0.0.1/rest/v1/matchups')
        const next = readRequest('http://127.0.0.1/rest/v1/lineup_slot_templates')
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
        page.emit('request', readRequest('http://127.0.0.1/rest/v1/matchups'))
        const result = waitForWebTargetReads(page).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await result).toEqual(new Error('Web reads did not finish: /rest/v1/matchups'))
    })
})

describe('document transitions in the web matrix', () => {
    it.each(['navigate', 'reload'])('does not %s until the active read and its follow-up finish', async (transition) => {
        const first = readRequest('http://127.0.0.1/rest/v1/matchups')
        const lineup = readRequest('http://127.0.0.1/rest/v1/weekly_lineups')
        page.emit('request', first)
        const result = transition === 'navigate' ? navigateWebTarget(page, '/create-league') : reloadWebTarget(page)
        await vi.advanceTimersByTimeAsync(1000)
        expect(page.goto).not.toHaveBeenCalled()
        expect(page.reload).not.toHaveBeenCalled()
        page.emit('requestfinished', first)
        await vi.advanceTimersByTimeAsync(400)
        page.emit('request', lineup)
        await vi.advanceTimersByTimeAsync(1000)
        expect(page.goto).not.toHaveBeenCalled()
        expect(page.reload).not.toHaveBeenCalled()
        page.emit('requestfailed', lineup)
        await vi.advanceTimersByTimeAsync(500)
        await result
        if (transition === 'navigate') expect(page.goto).toHaveBeenCalledExactlyOnceWith('/create-league')
        else expect(page.reload).toHaveBeenCalledExactlyOnceWith({ waitUntil: 'load' })
    })

    it('retains live-page errors while a document transition waits', async () => {
        const errors: Error[] = []
        page.on('pageerror', (error: Error) => errors.push(error))
        const read = readRequest('http://127.0.0.1/rest/v1/weekly_lineups')
        page.emit('request', read)
        const transition = navigateWebTarget(page, '/join-league')
        const failure = new Error('Live page unhandled rejection')
        page.emit('pageerror', failure)
        page.emit('requestfailed', read)
        await vi.advanceTimersByTimeAsync(500)
        await transition
        expect(errors).toEqual([failure])
    })
})

describe('gameplay document transitions', () => {
    it.each(['open', 'reload'])('settles the active live scoreboard read before %s', async (command) => {
        vi.stubEnv('E2E_WEB_TARGET_ID', 'desktop-chromium-1280')
        vi.stubEnv('E2E_BROWSER_ARTIFACT_DIR', 'unused-artifact-directory')
        const session = `live-read-${command}`
        await runWebTargetBrowserCommand({ session, args: ['get', 'url'] })
        const read = readRequest('http://127.0.0.1:54321/rest/v1/nba_games')
        page.emit('request', read)
        const transition = runWebTargetBrowserCommand({ session, args: command === 'open' ? ['open', 'http://127.0.0.1:8082/create-league'] : ['reload'] })
        await vi.advanceTimersByTimeAsync(1000)
        expect(page.goto).not.toHaveBeenCalled()
        expect(page.reload).not.toHaveBeenCalled()
        page.emit('requestfinished', read)
        await vi.advanceTimersByTimeAsync(500)
        await transition
        expect(command === 'open' ? page.goto : page.reload).toHaveBeenCalledOnce()
    })
})

describe('document ownership of pending reads', () => {
    it('keeps an active read during same-document navigation', async () => {
        page.emit('request', readRequest('http://127.0.0.1:54321/rest/v1/drafts'))
        mainFrame.url.mockReturnValue('http://127.0.0.1:8082/profile')
        page.emit('framenavigated', mainFrame)
        page.emit('domcontentloaded')
        const result = waitForWebTargetReads(page).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await result).toEqual(new Error('Web reads did not finish: /rest/v1/drafts'))
    })

    it('retires the previous document while retaining an active read started before DOM ready', async () => {
        const oldRead = readRequest('http://127.0.0.1:54321/rest/v1/drafts')
        const navigation = readRequest('http://127.0.0.1:8082/sign-in', true)
        const currentRead = readRequest('http://127.0.0.1:54321/rest/v1/drafts')
        page.emit('request', oldRead)
        page.emit('request', navigation)
        page.emit('request', readRequest('http://127.0.0.1:54321/rest/v1/weekly_lineups'))
        mainFrame.url.mockReturnValue(navigation.url())
        page.emit('framenavigated', mainFrame)
        page.emit('request', currentRead)
        page.emit('domcontentloaded')
        const errors: Error[] = []
        page.on('pageerror', (error: Error) => errors.push(error))
        const lateError = new Error('Late old-document failure')
        page.emit('pageerror', lateError)
        page.emit('requestfinished', navigation)
        let settled = false
        const result = waitForWebTargetReads(page).then(() => { settled = true }, (error: Error) => error)
        await vi.advanceTimersByTimeAsync(1000)
        expect(settled).toBe(false)
        page.emit('requestfinished', currentRead)
        await vi.advanceTimersByTimeAsync(29_000)
        expect(await result).toBeUndefined()
        expect(settled).toBe(true)
        expect(errors).toEqual([lateError])
    })

    it('keeps current reads when a navigation fails before committing a document', async () => {
        page.emit('request', readRequest('http://127.0.0.1:54321/rest/v1/drafts'))
        const navigation = readRequest('http://127.0.0.1:8082/sign-in', true)
        page.emit('request', navigation)
        page.emit('requestfailed', navigation)
        const result = waitForWebTargetReads(page).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await result).toEqual(new Error('Web reads did not finish: /rest/v1/drafts'))
    })
})
