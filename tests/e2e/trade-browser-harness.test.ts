import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickTestId } from './trade-browser-harness.mjs'

const mocks = vi.hoisted(() => ({ browser: vi.fn() }))
vi.mock('./browser-agent.mjs', () => ({ createBrowser: () => mocks.browser }))

beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('E2E_WEB_TARGET_ID', 'desktop-chromium')
})
afterEach(() => vi.unstubAllEnvs())

function showSummary(label: string | null, width: number, text = '') {
    mocks.browser.mockImplementation(async (_session: string, args: string[]) => runInNewContext(args[1], {
        document: {
            body: { innerText: text },
            querySelectorAll: () => label == null ? [] : [{
                getAttribute: () => label,
                getBoundingClientRect: () => ({ width }),
            }],
        },
    }))
}

it('recognizes the expanded desktop summary without the removed overview heading', async () => {
    showSummary('Remove Player A sent by You from trade', 44)
    await expect(clickTestId('trades', 'trade-deal-summary', 'Expanded summary')).resolves.toMatchObject({
        ok: true, panelsVisible: true,
    })
})

it.each([
    [null, 44],
    ['Remove Player A sent by You from trade', 0],
    ['Remove Player A for trade', 44],
] as const)('rejects a missing or hidden routed asset: %s at width %s', async (label, width) => {
    showSummary(label, width, 'DEAL OVERVIEW')
    await expect(clickTestId('trades', 'trade-deal-summary', 'Expanded summary')).rejects.toThrow('overview panel is missing')
})
