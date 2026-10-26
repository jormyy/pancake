import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { colors, shadows } from '@/constants/tokens'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('expo-router', () => ({ usePathname: () => '/' }))
vi.mock('@/components/auth/AuthDocumentForm', () => ({ AuthDocumentForm: () => null }))
vi.mock('expo-router/html', () => ({ ScrollViewStyleReset: () => null }))
vi.mock('expo-asset', () => ({ Asset: { fromModule: (uri: string) => ({ uri }) } }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: { font: { material: '/icons.woff2' } } }))
vi.mock('@expo-google-fonts/outfit', () => ({ Outfit_500Medium: '/medium.woff2', Outfit_600SemiBold: '/semibold.woff2', Outfit_700Bold: '/bold.woff2' }))
vi.mock('expo-font', () => ({ useFonts: () => [true], FontDisplay: { OPTIONAL: 'optional', SWAP: 'swap', BLOCK: 'block' } }))

const read = (path: string) => readFile(path, 'utf8')

// Source contracts for states that only show up in a browser: an error must
// never render as an empty result, empty lists must say so, and the PWA must
// keep looking for updates while it stays in the foreground.

describe('home matchup surface wiring', () => {
    it('drives the play surface from resolveHomeSurface so the tested precedence is what renders', async () => {
        const source = await read('app/(tabs)/index.tsx')
        expect(source).toContain("resolveHomeSurface({ leagueStatus: league?.status, hasMatchup: Boolean(matchup), loading: matchupLoading, error, emptyConfirmed })")
        for (const surface of ['draft', 'error']) expect(source).toContain(`homeSurface === '${surface}'`)
        expect(source.indexOf("homeSurface === 'error'")).toBeLessThan(source.indexOf('<WeekOffNotice leagueId='))
    })
})

describe('trades tab empty states', () => {
    // The read model emits its own empty rows per section, so the screen must
    // not add a parallel empty branch (review S3: listData always has a header).
    it('lets the read model own the empty rows and adds no screen-level fallback', async () => {
        const source = await read('app/(tabs)/trades.tsx')
        expect(source).not.toContain('TRADE_TAB_EMPTY_TEXT')
        expect(source).not.toMatch(/listData\.length === 0/)
    })
})

describe('service worker registration cadence', () => {
    let script: string
    beforeAll(async () => {
        await import('react/jsx-dev-runtime')
        vi.stubEnv('NODE_ENV', 'production')
        let Root: typeof import('@/app/+html')['default']
        try {
            Root = (await import('@/app/+html')).default
        } finally { vi.unstubAllEnvs() }
        const html = renderToStaticMarkup(React.createElement(Root))
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
        script = scripts.find(value => value.includes('navigator.serviceWorker.register'))!
        expect(script).toBeTruthy()
    })
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    class Element extends EventTarget {
        id = ''
        disabled = false
        textContent = ''
        style = { cssText: '' }
        children: Element[] = []
        setAttribute = vi.fn()
        appendChild(child: Element) { this.children.push(child) }
        querySelector() { return this.children[0] ?? null }
    }

    function updatePage() {
        const ports: { onmessage: ((event: { data: { version: string } }) => void) | null; close: ReturnType<typeof vi.fn> }[] = []
        const reload = vi.fn()
        const update = vi.fn(async () => {})
        const worker = { postMessage: vi.fn() }
        const registration = { active: worker, update }
        const serviceWorker = Object.assign(new EventTarget(), { controller: worker, register: vi.fn(async () => registration) })
        const navigator = { onLine: true, serviceWorker }
        const body = new Element()
        const document = Object.assign(new EventTarget(), {
            readyState: 'complete', visibilityState: 'visible', body,
            querySelector: () => ({ content: 'current' }),
            getElementById: (id: string) => body.children.find(child => child.id === id) ?? null,
            createElement: () => new Element(),
        })
        const window = Object.assign(new EventTarget(), {
            isSecureContext: true, location: { pathname: '/draft-room', reload },
        })
        vi.stubGlobal('window', window)
        const storage = new Map<string, string>()
        runInNewContext(script, {
            window, document, navigator, Date, setTimeout, clearTimeout, setInterval,
            sessionStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
            },
            MessageChannel: class {
                port1 = { onmessage: null, close: vi.fn() }
                port2 = {}
                constructor() { ports.push(this.port1) }
            },
        })
        const reply = (version: string) => {
            expect(ports.length).toBeGreaterThan(0)
            ports.at(-1)!.onmessage?.({ data: { version } })
        }
        return { update, reload, document, navigator, window, serviceWorker, ports, reply, storage,
            load: async () => {
                window.dispatchEvent(new Event('load'))
                await vi.advanceTimersByTimeAsync(0)
                expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js')
                reply('current')
            },
        }
    }

    it('checks hourly only while visible and online, and checks again on reconnect', async () => {
        const page = updatePage()
        await page.load()
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(page.update).toHaveBeenCalledTimes(1)
        page.document.visibilityState = 'hidden'
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(page.update).toHaveBeenCalledTimes(1)
        page.document.visibilityState = 'visible'
        page.navigator.onLine = false
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(page.update).toHaveBeenCalledTimes(1)
        page.navigator.onLine = true
        page.window.dispatchEvent(new Event('online'))
        await vi.advanceTimersByTimeAsync(0)
        expect(page.update).toHaveBeenCalledTimes(2)
    })

    it('throttles foreground checks, retries reconnect, and joins an unfinished check', async () => {
        const page = updatePage()
        await page.load()
        await vi.advanceTimersByTimeAsync(299999)
        page.document.dispatchEvent(new Event('visibilitychange'))
        expect(page.update).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        let finish!: () => void
        page.update.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
        page.document.dispatchEvent(new Event('visibilitychange'))
        expect(page.update).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(300000)
        page.window.dispatchEvent(new Event('online'))
        expect(page.update).toHaveBeenCalledTimes(1)
        finish()
        await vi.advanceTimersByTimeAsync(0)
        page.window.dispatchEvent(new Event('online'))
        await vi.advanceTimersByTimeAsync(0)
        expect(page.update).toHaveBeenCalledTimes(2)
    })

    it('accepts a worker version after nine seconds', async () => {
        const page = updatePage()
        await page.load()
        page.serviceWorker.dispatchEvent(new Event('controllerchange'))
        const port = page.ports.at(-1)!
        await vi.advanceTimersByTimeAsync(9000)
        expect(port.close).not.toHaveBeenCalled()
        page.reply('next')
        expect(page.reload).toHaveBeenCalledOnce()
        page.document.visibilityState = 'hidden'
        page.document.dispatchEvent(new Event('visibilitychange'))
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('closes an unanswered version request at ten seconds and ignores its late reply', async () => {
        const page = updatePage()
        await page.load()
        page.serviceWorker.dispatchEvent(new Event('controllerchange'))
        const port = page.ports.at(-1)!
        await vi.advanceTimersByTimeAsync(9999)
        expect(port.close).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(port.close).toHaveBeenCalledOnce()
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
    })

    const assetMiss = (page: ReturnType<typeof updatePage>) => {
        page.serviceWorker.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'PANCAKE_ASSET_MISS' } }))
    }

    it.each(['asset', 'Loading module 42 failed', 'AsyncRequireError: module unavailable'])(
        'recovers a missing lazy route while visible: %s', async failure => {
            const page = updatePage()
            await page.load()
            expect(page.reload).not.toHaveBeenCalled()
            if (failure === 'asset') assetMiss(page)
            else page.window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error(failure) }))
            await vi.advanceTimersByTimeAsync(0)
            expect(page.update).toHaveBeenCalledOnce()
            page.reply('next')
            expect(page.reload).toHaveBeenCalledOnce()
            assetMiss(page)
            await vi.advanceTimersByTimeAsync(0)
            page.reply('next')
            expect(page.reload).toHaveBeenCalledOnce()
        },
    )

    it('offers manual recovery instead of auto-reloading the same release twice', async () => {
        const page = updatePage()
        await page.load()
        page.storage.set('pancake-update-reload:/draft-room', 'next')
        assetMiss(page)
        await vi.advanceTimersByTimeAsync(0)
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
        const button = page.document.getElementById('pancake-update-notice')?.querySelector()
        expect(button).toBeTruthy()
        button?.dispatchEvent(new Event('click'))
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('shows a held missing-route update immediately and reloads after the hold ends', async () => {
        const page = updatePage()
        const release = holdPwaUpdate('unsent trade')
        await page.load()
        page.serviceWorker.dispatchEvent(new Event('controllerchange'))
        page.reply('next')
        assetMiss(page)
        await vi.advanceTimersByTimeAsync(0)
        page.reply('next')
        const notice = page.document.getElementById('pancake-update-notice')
        expect(notice?.querySelector()?.disabled).toBe(true)
        expect(page.reload).not.toHaveBeenCalled()
        release()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it.each(['loading', 'interactive', 'offline'])('retains the missing-route reload guard while %s', async guard => {
        const page = updatePage()
        await page.load()
        if (guard === 'offline') page.navigator.onLine = false
        else page.document.readyState = guard
        assetMiss(page)
        page.serviceWorker.dispatchEvent(new Event('controllerchange'))
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
        page.document.readyState = 'complete'
        page.navigator.onLine = true
        page.window.dispatchEvent(new Event('online'))
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('keeps a held update through the notice deadline and reloads once after safe recovery', async () => {
        const page = updatePage()
        const release = holdPwaUpdate('live auction')
        await page.load()
        page.serviceWorker.dispatchEvent(new Event('controllerchange'))
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60000)
        const notice = page.document.getElementById('pancake-update-notice')!
        expect(notice.textContent).toContain('Finish your current work')
        expect(notice.style.cssText).toContain(`background:${colors.bgCard}`)
        expect(notice.style.cssText).toContain(`color:${colors.textPrimary}`)
        expect(notice.style.cssText).toContain(`box-shadow:${shadows.lg}`)
        expect(notice.querySelector()?.disabled).toBe(true)
        expect(page.reload).not.toHaveBeenCalled()
        page.document.visibilityState = 'hidden'
        page.navigator.onLine = false
        release()
        expect(notice.querySelector()?.disabled).toBe(false)
        expect(page.reload).not.toHaveBeenCalled()
        page.navigator.onLine = true
        page.window.dispatchEvent(new Event('online'))
        expect(page.reload).not.toHaveBeenCalled()
        page.document.visibilityState = 'visible'
        page.document.dispatchEvent(new Event('visibilitychange'))
        expect(page.reload).toHaveBeenCalledOnce()
        release()
        page.window.dispatchEvent(new Event('online'))
        expect(page.reload).toHaveBeenCalledOnce()
    })
})

describe('edge job bookkeeping', () => {
    it('season-boundary records per-league failures on the sync run', async () => {
        const source = await read('supabase/functions/season-boundary/index.ts')
        expect(source).toContain('failure: summarizeBoundaryFailures(reports)')
    })

    it('process-waivers leaves notifications to committed database transitions', async () => {
        const source = await read('supabase/functions/process-waivers/index.ts')
        expect(source).not.toMatch(/notifyClaimResults|notifyMember|notifications\.ts/)
        const producer = await read('supabase/sql/functions/by-name/private/notif_waiver_trigger.sql')
        expect(producer).toContain("OLD.status IS NOT DISTINCT FROM NEW.status")
        expect(producer).toContain("'waiver_claim_won'")
        expect(producer).toContain("'waiver_claim_lost'")
        const { drainDueClaims, MAX_BATCHES } = await import('../supabase/functions/process-waivers/drain')
        const batches = [[], ['claim-1'], [], ['claim-2', 'claim-3'], [], [], ['never-fetched']]
        const processBatch = vi.fn(async () => batches.shift() ?? [])
        await expect(drainDueClaims(processBatch)).resolves.toEqual(['claim-1', 'claim-2', 'claim-3'])
        expect(processBatch).toHaveBeenCalledTimes(6)
        let processedBatches = 0
        const continuousBatch = async () => {
            processedBatches += 1
            if (processedBatches > MAX_BATCHES) throw new Error('Drain exceeds its batch limit')
            return ['claim']
        }
        await expect(drainDueClaims(continuousBatch)).resolves.toHaveLength(MAX_BATCHES)
        expect(processedBatches).toBe(MAX_BATCHES)
    })

    it('the backfill progress poll projects columns instead of select(*)', async () => {
        const source = await read('supabase/functions/api/sync.ts')
        expect(source).not.toContain("select('*')")
    })
})
