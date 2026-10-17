import { runInNewContext } from 'node:vm'
import { beforeEach, expect, it, vi } from 'vitest'
import { checkAutoSetRefreshReadiness } from './e2e/browser-lineup-gameplay.mjs'

const mocks = vi.hoisted(() => ({ browser: vi.fn() }))
vi.mock('./e2e/browser-agent.mjs', () => ({ createBrowser: () => mocks.browser }))

beforeEach(() => vi.resetAllMocks())

it('confirms the sheet opens before holding its next refresh', async () => {
    let open = false
    let held = false
    const events: string[] = []
    const choices = ['Auto-set today', 'Auto-set whole week', 'Auto-set rest of season']
    mocks.browser.mockImplementation(async (_session: string, args: string[]) => {
        if (args[0] === 'wait' && args[1] === '--fn') {
            if (!held) {
                const labels = [...choices, 'Cancel auto-set']
                const nodes = new Map(labels.map((label) => [label, { visible: false, disabled: false }]))
                const ready = () => runInNewContext(args[2], { document: { querySelector: (selector: string) => {
                    const state = nodes.get(selector.slice(13, -2))
                    return state ? { getClientRects: () => state.visible ? [{}] : [], getAttribute: () => state.disabled ? 'true' : null } : null
                } } })
                expect(ready()).toBe(false)
                for (const state of nodes.values()) state.visible = true
                expect(ready()).toBe(true)
                for (const label of labels) {
                    const state = nodes.get(label)!
                    state.disabled = true
                    expect(ready()).toBe(false)
                    state.disabled = false
                    state.visible = false
                    expect(ready()).toBe(false)
                    state.visible = true
                }
                open = true
                events.push('sheet-ready')
            }
            return ''
        }
        if (args[1].includes('const original = window.fetch;')) {
            held = true
            events.push('hold-refresh')
        }
        if (args[1].includes('const labels =')) {
            return JSON.stringify({ choices: choices.map((label) => ({ label, visible: open, disabled: held && open })), cancelAvailable: open })
        }
        if (args[1].includes('window.__pancakeReleaseAutoSetRefresh?.()')) {
            held = false
            events.push('release-refresh')
        }
        return ''
    })
    const record = vi.fn()
    await checkAutoSetRefreshReadiness('lineup', record)
    expect(events.slice(0, 3)).toEqual(['sheet-ready', 'hold-refresh', 'release-refresh'])
    expect(record).toHaveBeenCalledWith({ refreshReadiness: {
        choices: choices.map((label) => ({ label, visible: true, disabled: true })), cancelAvailable: true,
    } })
})

it('fails a missing sheet before it can freeze a refresh', async () => {
    const missing = new Error('Auto-set sheet never opened')
    mocks.browser.mockImplementation(async (_session: string, args: string[]) => {
        if (args[0] === 'wait') throw missing
        throw new Error('Refresh started before the sheet opened')
    })
    await expect(checkAutoSetRefreshReadiness('lineup', vi.fn())).rejects.toBe(missing)
    expect(mocks.browser).toHaveBeenCalledTimes(1)
})
