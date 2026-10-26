import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { authSession, fixtureProject } from './helpers/auth-session'

vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', fixtureProject)

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
}))


const {
    APP_MOUNTED_MARK,
    BOOT_SHELL_CSS,
    BOOT_SHELL_HTML,
    BOOT_SHELL_ID,
    BOOT_SHELL_MARK,
    BOOT_SHELL_READY_ATTR,
    BOOT_SHELL_SCRIPT,
} = await import('@/constants/boot-shell')

type Storage = Record<string, string>

const NAV_HREFS = ['/', '/roster', '/players', '/trades', '/league']

/** Minimal DOM stand-in: the shell script only reads storage and one element. */
function runBootScript(pathname: string, storage: Storage) {
    const texts: Record<string, string> = {}
    const attributes: Record<string, string> = {}
    const hidden = new Set(['commissioner'])

    const textNode = (name: string) => ({
        set textContent(value: string) { texts[name] = value },
        get textContent() { return texts[name] ?? `stub-${name}` },
        getAttribute: () => (name === 'active' ? '/roster' : null),
        removeAttribute: () => {},
    })
    const activeHrefs: string[] = []
    const element = {
        setAttribute(key: string, value: string) { attributes[key] = value },
        querySelectorAll: (selector: string) => {
            if (selector === '[data-href]') {
                return NAV_HREFS.map((href) => ({
                    getAttribute: (name: string) => (name === 'data-href' ? href : null),
                    setAttribute: (name: string, value: string) => {
                        if (name === 'aria-current' && value === 'page') activeHrefs.push(href)
                    },
                }))
            }
            const match = /\[data-pbs="([^"]+)"\]/.exec(selector)
            return match ? [textNode(match[1])] : []
        },
        querySelector: (selector: string) => {
            if (selector === '[aria-current="page"]') return textNode('active')
            const match = /\[data-pbs="([^"]+)"\]/.exec(selector)
            if (!match) return null
            if (match[1] === 'commissioner') {
                return { removeAttribute: () => hidden.delete('commissioner') }
            }
            return textNode(match[1])
        },
    }
    const keys = Object.keys(storage)
    const marks: string[] = []
    const scope = { __PANCAKE_BOOT__: null as unknown }

    new Function('document', 'location', 'window', 'performance', BOOT_SHELL_SCRIPT)(
        {
            getElementById: (id: string) => (id === BOOT_SHELL_ID ? element : null),
            documentElement: { setAttribute: () => {} },
        },
        { pathname },
        Object.assign(scope, {
            localStorage: {
                length: keys.length,
                key: (index: number) => keys[index] ?? null,
                getItem: (key: string) => storage[key] ?? null,
            },
        }),
        { mark: (name: string) => marks.push(name) },
    )
    return { attributes, texts, marks, activeHrefs, breadcrumb: scope.__PANCAKE_BOOT__, commissionerHidden: hidden.has('commissioner') }
}

const session = (userId = 'u1') => JSON.stringify(authSession(userId))

const membershipStorage = ({ role = 'member', teamName = 'E2E Team 1', leagueName = 'Sunday Dynasty' } = {}) => ({
    'sb-auth-fixture-auth-token': session(),
    'pancake:league-memberships:v1:u1': JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        value: [{ id: 'm1', role, team_name: teamName, leagues: { id: 'l1', name: leagueName } }],
    }),
    'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: Date.now(), value: 'm1' }),
})

// The boot shell is emitted as a raw string into the document, so nothing type
// checks it. A single lost escape once left the whole script unparsable, which
// silently disabled the instant paint while every other gate stayed green.
describe('boot shell', () => {
    it('emits a script the browser can actually parse', () => {
        expect(() => new Function(BOOT_SHELL_SCRIPT)).not.toThrow()
    })

    it('reveals the shell only for a stored session on a non-auth route', () => {
        expect(runBootScript('/', { 'sb-auth-fixture-auth-token': session() }).attributes).toMatchObject({
            'data-visible': '1',
            [BOOT_SHELL_READY_ATTR]: '1',
        })
        // Signed out: the app boots to a marketing/auth screen, not the chrome.
        expect(runBootScript('/', {}).attributes).toEqual({})
        // Signed in but heading to auth: that screen owns the whole viewport.
        expect(runBootScript('/sign-in', { 'sb-auth-fixture-auth-token': session() }).attributes).toEqual({})
        expect(runBootScript('/sign-up', { 'sb-auth-fixture-auth-token': session() }).attributes).toEqual({})
        // Corrupt storage entry must not break the launch.
        expect(runBootScript('/', { 'sb-auth-fixture-auth-token': '{not json' }).attributes).toEqual({})
    })

    it('renders the cached league, team, and initials the app will render', () => {
        const { texts, breadcrumb, commissionerHidden } = runBootScript('/roster', membershipStorage({ role: 'commissioner' }))
        expect(texts).toEqual({
            league: 'Sunday Dynasty', 'league-compact': 'Sunday Dynasty',
            team: 'E2E Team 1', profile: 'E2E Team 1', initials: 'ET',
        })
        expect(commissionerHidden).toBe(false)
        expect(breadcrumb).toMatchObject({ league: 'Sunday Dynasty', team: 'E2E Team 1', active: '/roster' })
    })

    it.each(['/player/123', '/profile', '/lineup', '/propose-trade', '/claim-player', '/team-roster',
        '/change-password', '/commissioner-settings', '/create-league', '/join-league', '/bracket', '/draft-room', '/rookie-draft-room'])('reserves only the back header on boot: %s', pathname => {
        expect(runBootScript(pathname, membershipStorage()).attributes['data-back-header']).toBe('1')
    })

    it('keeps the one-league title plain from the first paint', () => {
        const { attributes } = runBootScript('/', membershipStorage())
        expect(attributes['data-single-league']).toBe('1')
        expect(attributes['data-multiple-leagues']).toBeUndefined()
    })

    it('renders plain chrome when the cached shape is not what it expects', () => {
        // Cache keys carry their own version, so a schema change makes these
        // reads miss rather than match. The shell must degrade, not break.
        const shapes = [
            JSON.stringify({ version: 2, savedAt: Date.now(), value: [{ id: 'm1', team_name: 'T' }] }),
            JSON.stringify({ version: 1, savedAt: Date.now(), value: { not: 'an array' } }),
            JSON.stringify({ version: 1, savedAt: Date.now(), value: null }),
            JSON.stringify({ version: 1, savedAt: Date.now(), value: [null, 'not a membership'] }),
        ]
        for (const memberships of shapes) {
            const { attributes, texts } = runBootScript('/', {
                'sb-auth-fixture-auth-token': session(),
                'pancake:league-memberships:v1:u1': memberships,
            })
            expect(attributes['data-visible']).toBe('1')
            expect(texts).toEqual({})
        }
    })

    // Missing cached membership data cannot establish an authoritative empty league list.
    it('keeps boot membership state unknown until the app checks league access', () => {
        const component = readFileSync(path.join(process.cwd(), 'components/navigation/WebTabShell.tsx'), 'utf8')
        expect(component).toContain("membershipStatus === 'empty' ? 'No league' : 'League unavailable'")
        expect(component).toContain("membershipStatus === 'empty' ? 'Create or join from League' : 'Waiting for league access'")
        expect(BOOT_SHELL_HTML).toContain('data-pbs="league">League unavailable<')
        expect(BOOT_SHELL_HTML).toContain('data-pbs="league-compact">League unavailable<')
        expect(BOOT_SHELL_HTML).toContain('data-pbs="team">Waiting for league access<')
        expect(BOOT_SHELL_HTML).not.toContain('>No league<')
        expect(BOOT_SHELL_HTML).not.toContain('>Create or join from League<')
        expect(BOOT_SHELL_HTML).toContain('data-pbs="profile">Profile<')

        // With a session but no membership, the script must not overwrite them.
        const { attributes, texts, breadcrumb } = runBootScript('/', { 'sb-auth-fixture-auth-token': session() })
        expect(attributes['data-visible']).toBe('1')
        expect(texts).toEqual({})
        expect(breadcrumb).toMatchObject({ league: null, team: null, initials: null })
    })

    it('marks the active route exactly as isRouteActive does', () => {
        const storage = membershipStorage()
        const activeFor = (pathname: string) => runBootScript(pathname, storage).activeHrefs
        // Every form isRouteActive treats as the home route.
        for (const home of ['/', '/index', '/(tabs)', '/(tabs)/index']) {
            expect(activeFor(home), `home form ${home}`).toContain('/')
        }
        expect(activeFor('/roster')).toEqual(['/roster'])
        expect(activeFor('/players')).toEqual(['/players'])
        // A route outside the nav highlights nothing, as in the component.
        expect(activeFor('/profile')).toEqual([])
        expect(activeFor('/player/abc')).toEqual(['/players'])
        expect(activeFor('/lineup')).toEqual(['/roster'])
        expect(activeFor('/claim-player')).toEqual(['/players'])
        expect(activeFor('/propose-trade')).toEqual(['/trades'])
        expect(activeFor('/team-roster')).toEqual(['/league'])
    })

    it('keeps the full mobile league label through the app handoff', () => {
        const long = runBootScript('/', membershipStorage({ leagueName: 'Pancake E2E 20260827175814' })).texts
        expect(long.league).toBe('Pancake E2E 20260827175814')
        expect(long['league-compact']).toBe(long.league)
        const short = runBootScript('/', membershipStorage({ leagueName: 'Sunday Dynasty' })).texts
        expect(short['league-compact']).toBe('Sunday Dynasty')
    })

    it('shows commissioner tools for co-commissioners too, matching isCommissioner', () => {
        expect(runBootScript('/', membershipStorage({ role: 'co_commissioner' })).commissionerHidden).toBe(false)
        expect(runBootScript('/', membershipStorage({ role: 'member' })).commissionerHidden).toBe(true)
    })

    it('picks the same membership league-context would', () => {
        const two = (selected: string) => ({
            'sb-auth-fixture-auth-token': session(),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                value: [
                    { id: 'm1', role: 'member', team_name: 'First Team', leagues: { id: 'l1', name: 'First League' } },
                    { id: 'm2', role: 'member', team_name: 'Second Team', leagues: { id: 'l2', name: 'Second League' } },
                ],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: Date.now(), value: selected }),
        })
        expect(runBootScript('/', two('m2')).texts.league).toBe('Second League')
        // Cached rows cannot confirm that the saved membership was removed.
        expect(runBootScript('/', two('gone')).texts.league).toBeUndefined()
    })

    it('uses a durable old selection with fresh memberships instead of painting the default league', () => {
        const storage = membershipStorage()
        storage['pancake:selected-league:v1:u1'] = JSON.stringify({ version: 1, savedAt: Date.now() - 365 * 86400_000, value: 'm2' })
        storage['pancake:league-memberships:v1:u1'] = JSON.stringify({ version: 1, savedAt: Date.now() - 7 * 86400_000, value: [
            { id: 'm1', team_name: 'First', leagues: { name: 'First League' } },
            { id: 'm2', team_name: 'Selected', leagues: { name: 'Selected League' } },
        ] })
        expect(runBootScript('/', storage).texts.league).toBe('Selected League')
    })

    it('claims no default league when a cached list omits the saved selection', () => {
        const storage = membershipStorage()
        storage['pancake:selected-league:v1:u1'] = JSON.stringify({ version: 1, savedAt: Date.now(), value: 'missing-from-cache' })
        expect(runBootScript('/', storage).texts).toEqual({})
    })

    it('never paints another stored owner\'s identity', () => {
        const storage = { ...membershipStorage(), 'sb-auth-fixture-auth-token': session('other-owner') }
        expect(runBootScript('/', storage).texts).toEqual({})
    })

    it('uses only the configured project owner when another project has a stored session', () => {
        const storage = { 'sb-other-project-auth-token': session('other-owner'), ...membershipStorage() }
        expect(runBootScript('/', storage).texts.league).toBe('Sunday Dynasty')
    })

    it('honors the project logout marker even if stored auth removal failed', () => {
        const storage = { ...membershipStorage(), 'sb-auth-fixture-auth-token-local-logout': JSON.stringify({
            id: 'logout', generation: 1, signedOut: true,
        }) }
        expect(runBootScript('/', storage).attributes).toEqual({})
    })

    it('hides cached identity for malformed or foreign-project auth but permits a checked expired session', () => {
        const storage = membershipStorage()
        for (const value of [
            { ...authSession('u1'), refresh_token: '' },
            { ...authSession('foreign'), user: { id: 'u1', aud: 'authenticated' } },
        ]) {
            storage['sb-auth-fixture-auth-token'] = JSON.stringify(value)
            expect(runBootScript('/', storage).attributes).toEqual({})
        }
        storage['sb-auth-fixture-auth-token'] = JSON.stringify(authSession('u1', Math.floor(Date.now() / 1000) - 60))
        expect(runBootScript('/', storage).texts.league).toBe('Sunday Dynasty')
    })

    it('derives initials exactly like lib/format getInitials', async () => {
        // Evaluate the real function's source rather than importing lib/format,
        // which drags in the whole React Native module graph.
        const source = await readFile(path.join(process.cwd(), 'lib/format.ts'), 'utf8')
        const body = source.slice(source.indexOf('export function getInitials'))
        const declaration = body.slice(0, body.indexOf('\n}\n') + 2).replace('export function', 'function')
        expect(declaration).toContain('letterWords')
        const getInitials = new Function(`${declaration.replace(/: string \| null \| undefined/g, '').replace(/: string/g, '')}; return getInitials`)() as (name: string) => string

        for (const name of ['E2E Team 1', 'Sunday Dynasty', 'Team #1', 'Solo', 'a', '123', 'The Big Bad Wolves']) {
            const { texts } = runBootScript('/', membershipStorage({ teamName: name }))
            expect(texts.initials, `initials for ${name}`).toBe(getInitials(name))
        }
    })

    it('paints the chrome but claims no league when the cache is long abandoned', () => {
        const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000
        const { attributes, texts } = runBootScript('/', {
            'sb-auth-fixture-auth-token': session(),
            'pancake:league-memberships:v1:u1': JSON.stringify({
                version: 1,
                savedAt: ancient,
                value: [{ id: 'm1', role: 'member', team_name: 'Stale Team', leagues: { id: 'l1', name: 'Stale League' } }],
            }),
            'pancake:selected-league:v1:u1': JSON.stringify({ version: 1, savedAt: ancient, value: 'm1' }),
        })
        expect(attributes['data-visible']).toBe('1')
        expect(texts).toEqual({})
    })

    it('marks the moment it paints so the launch gate can measure the gap', () => {
        expect(runBootScript('/', { 'sb-auth-fixture-auth-token': session() }).marks).toEqual([BOOT_SHELL_MARK])
    })

    it('keeps the launch gate reading the marks this module actually emits', async () => {
        // The gate is an .mjs harness and cannot import this module, so it
        // repeats the mark names. Renaming one here must not silently blind it.
        const gate = await readFile(path.join(process.cwd(), 'tests/e2e/browser-pwa-launch.mjs'), 'utf8')
        expect(gate).toContain(`const BOOT_SHELL_MARK = '${BOOT_SHELL_MARK}'`)
        expect(gate).toContain(`const APP_MOUNTED_MARK = '${APP_MOUNTED_MARK}'`)
        expect(gate).toContain(`getElementById('${BOOT_SHELL_ID}')`)
    })

    // The shell restates WebTabShell's navigation so it can render without the
    // bundle. Five separate drift bugs already shipped in this file's first
    // draft, so pin the restatement against the component it mirrors.
    it('mirrors the navigation WebTabShell renders, label, route, and icon', async () => {
        const shell = await readFile(path.join(process.cwd(), 'components/navigation/WebTabShell.tsx'), 'utf8')
        const block = (name: string) => {
            const start = shell.indexOf(`const ${name}`)
            expect(start, `${name} in WebTabShell`).toBeGreaterThan(-1)
            return shell.slice(start, shell.indexOf('\n]', start))
        }
        const entries = (source: string) =>
            [...source.matchAll(/\{ label: '([^']+)', href: '([^']+)', icon: '([^']+)' \}/g)]
                .map((m) => ({ label: m[1], href: m[2], icon: m[3] }))
        const live = entries(block('PRIMARY_NAV'))
        expect(live.length).toBeGreaterThan(0)

        // League is appended to PRIMARY_NAV to form MOBILE_NAV; the shell keeps
        // it in its own sidebar group, so assert it separately.
        const mobileLabels = Object.fromEntries(
            [...block('MOBILE_LABELS').matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]]),
        )

        for (const item of [...live, { label: 'League', href: '/league', icon: 'emoji-events' }]) {
            expect(BOOT_SHELL_HTML, `route ${item.href}`).toContain(`data-href="${item.href}"`)
            expect(BOOT_SHELL_HTML, `sidebar label for ${item.href}`).toContain(`<span>${item.label}</span>`)
            const mobile = mobileLabels[item.href]
            expect(mobile, `MOBILE_LABELS entry for ${item.href}`).toBeTruthy()
            expect(BOOT_SHELL_HTML, `mobile label for ${item.href}`)
                .toContain(`<span class="pbs-bottomlabel">${mobile}</span>`)
        }
    })

    it('links every primary route in both the sidebar and the mobile bar', () => {
        // Checked per region: the two navs carry the same routes, so a single
        // whole-document search stays green when one of them loses an item.
        const region = (className: string) => {
            const start = BOOT_SHELL_HTML.indexOf(`<nav class="${className}"`)
            expect(start, `${className} region`).toBeGreaterThan(-1)
            return BOOT_SHELL_HTML.slice(start, BOOT_SHELL_HTML.indexOf('</nav>', start))
        }
        const sidebar = region('pbs-side')
        const bottomNav = region('pbs-bottomnav')
        for (const href of ['/', '/roster', '/players', '/trades', '/league']) {
            expect(sidebar, `sidebar ${href}`).toContain(`data-href="${href}"`)
            expect(bottomNav, `bottom nav ${href}`).toContain(`data-href="${href}"`)
            expect(sidebar, `sidebar href ${href}`).toContain(`href="${href}"`)
        }
    })

    it('is announced as navigation, since it is the only nav on screen', () => {
        // Focusable links inside an aria-hidden container is the anti-pattern.
        // The shell is removed before the real navigation paints, so there is
        // never a moment where both are announced.
        expect(BOOT_SHELL_HTML).not.toContain(`id="${BOOT_SHELL_ID}" aria-hidden`)
        expect(BOOT_SHELL_HTML).toContain('<nav class="pbs-side" aria-label="Primary">')
        expect(BOOT_SHELL_HTML).toContain('<nav class="pbs-bottomnav" aria-label="Primary">')
        // Icons and the menu affordance stay decorative.
        const links = BOOT_SHELL_HTML.match(/<a class="pbs-[^"]*"[^>]*>/g) ?? []
        expect(links.length).toBeGreaterThan(0)
        for (const link of links) expect(link).not.toContain('aria-hidden')
    })

    it('keeps the shell hidden until the script opts it in', () => {
        // Scoped to the shell's own rule: the mobile bars carry display:none
        // too, so a loose search would pass even with the shell shown by default.
        const rule = BOOT_SHELL_CSS.slice(BOOT_SHELL_CSS.indexOf(`#${BOOT_SHELL_ID}{`))
        expect(rule.slice(0, rule.indexOf('}'))).toContain('display:none')
        expect(BOOT_SHELL_CSS).toContain(`#${BOOT_SHELL_ID}[data-visible="1"]{display:block;}`)
    })
})

describe('release reconciliation', () => {
    async function updatePage({ held = false, loading = false, previous = null as string | null, documentVersion = 'old' } = {}) {
        const { runInNewContext } = await import('node:vm')
        const source = readFileSync('app/+html.tsx', 'utf8')
        const script = source.split("const SW_REGISTER = process.env.NODE_ENV === 'production' ? `")[1].split('` : `')[0]
        const windowEvents = new Map<string, () => void>()
        const documentEvents = new Map<string, () => void>()
        const workerEvents = new Map<string, () => void>()
        const ports: { onmessage: ((event: unknown) => void) | null; close: () => void }[] = []
        const timers: { callback: () => void; delay: number }[] = []
        const storage = new Map(previous ? [['pancake-sw-worker-version', previous]] : [])
        const worker = { postMessage: vi.fn() }
        const reload = vi.fn()
        const holds = new Map(held ? [[1, 'pending bid']] : [])
        const buttons: Map<string, () => void>[] = []
        const document = {
            readyState: loading ? 'loading' : 'complete', visibilityState: 'visible',
            querySelector: () => ({ content: documentVersion }),
            addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback),
            getElementById: () => null,
            createElement: (tag: string) => {
                const events = new Map<string, () => void>()
                if (tag === 'button') buttons.push(events)
                return { setAttribute: vi.fn(), style: {}, appendChild: vi.fn(), addEventListener: (name: string, callback: () => void) => events.set(name, callback) }
            },
            body: { appendChild: vi.fn() },
        }
        const navigator = { onLine: true, serviceWorker: { controller: worker,
            register: async () => ({ active: worker, update: async () => {} }),
            addEventListener: (name: string, callback: () => void) => workerEvents.set(name, callback) } }
        runInNewContext(script, {
            window: { __pancakePwaHolds: holds, isSecureContext: true,
                addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback),
                location: { reload, pathname: '/players' } },
            document,
            navigator,
            sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value) },
            MessageChannel: class { port1 = { onmessage: null, close: vi.fn() }; port2 = {}; constructor() { ports.push(this.port1) } },
            setInterval: vi.fn(), clearTimeout: vi.fn(),
            setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length },
        })
        return { reload, holds, timers, storage, navigator,
            reply: (version: string) => { expect(ports.length).toBeGreaterThan(0); ports.at(-1)!.onmessage?.({ data: { version } }) },
            load: async () => { document.readyState = 'complete'; windowEvents.get('load')?.(); await Promise.resolve() },
            release: () => { holds.clear(); windowEvents.get('pancake-pwa-hold-change')?.() },
            change: () => workerEvents.get('controllerchange')?.(),
            hide: () => { document.visibilityState = 'hidden'; documentEvents.get('visibilitychange')?.() },
            show: () => { document.visibilityState = 'visible'; documentEvents.get('visibilitychange')?.() },
            pagehide: () => windowEvents.get('pagehide')?.(),
            online: () => windowEvents.get('online')?.(),
            clickReload: () => buttons.at(-1)?.get('click')?.(),
        }
    }

    it('reconciles a controller that replaces the document release before load without prior session storage', async () => {
        const page = await updatePage({ loading: true })
        page.change()
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
        await page.load()
        expect(page.reload).toHaveBeenCalledOnce()
        page.hide()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('lets a new online document reconcile its old controller before considering a reload', async () => {
        const page = await updatePage({ loading: true, documentVersion: 'next' })
        page.reply('old')
        await page.load()
        expect(page.reload).not.toHaveBeenCalled()
        page.change()
        page.reply('next')
        page.release()
        expect(page.reload).not.toHaveBeenCalled()
    })

    it('holds an update through a pending bid and reloads when it is released', async () => {
        const page = await updatePage({ held: true, previous: 'old' })
        await page.load()
        page.change()
        page.reply('next')
        expect(page.reload).not.toHaveBeenCalled()
        for (const timer of page.timers.filter(timer => timer.delay === 60000)) timer.callback()
        expect(page.reload).not.toHaveBeenCalled()
        page.release()
        expect(page.reload).toHaveBeenCalledOnce()
        page.hide()
        expect(page.reload).toHaveBeenCalledOnce()
        page.release()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('reloads a visible page once through controller changes, reconnect, and foreground checks', async () => {
        const page = await updatePage()
        await page.load()
        page.change()
        page.reply('next')
        page.online()
        page.show()
        expect(page.reload).toHaveBeenCalledOnce()
        page.hide()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('never starts a second reload on pagehide', async () => {
        const page = await updatePage()
        await page.load()
        page.change()
        page.reply('next')
        expect(page.reload).toHaveBeenCalledOnce()
        page.pagehide()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('keeps offline and held updates pending while hidden', async () => {
        const page = await updatePage({ held: true })
        await page.load()
        page.change()
        page.reply('next')
        page.hide()
        page.pagehide()
        expect(page.reload).not.toHaveBeenCalled()
        page.navigator.onLine = false
        page.release()
        expect(page.reload).not.toHaveBeenCalled()
        page.navigator.onLine = true
        page.online()
        expect(page.reload).not.toHaveBeenCalled()
        page.show()
        expect(page.reload).toHaveBeenCalledOnce()
    })

    it('keeps the once-per-release guard when hidden', async () => {
        const page = await updatePage()
        page.storage.set('pancake-update-reload:/players', 'next')
        await page.load()
        page.change()
        page.reply('next')
        page.hide()
        page.pagehide()
        expect(page.reload).not.toHaveBeenCalled()
    })

    it('lets the user reload a visible page after the notice appears', async () => {
        const page = await updatePage({ held: true })
        await page.load()
        page.change()
        page.reply('next')
        for (const timer of page.timers.filter(timer => timer.delay === 60000)) timer.callback()
        page.clickReload()
        expect(page.reload).not.toHaveBeenCalled()
        page.release()
        page.clickReload()
        expect(page.reload).toHaveBeenCalledOnce()
    })
})

describe('PWA update holds', () => {
    it('requires every holder to release and makes release idempotent', async () => {
        const { holdPwaUpdate, isPwaUpdateHeld } = await import('@/lib/pwa-update-guard')
        const target = new EventTarget()
        vi.stubGlobal('window', target)
        try {
            const releaseBid = holdPwaUpdate('bid')
            const releaseAuction = holdPwaUpdate('auction')
            expect(isPwaUpdateHeld()).toBe(true)
            releaseBid()
            releaseBid()
            expect(isPwaUpdateHeld()).toBe(true)
            releaseAuction()
            expect(isPwaUpdateHeld()).toBe(false)
        } finally { vi.unstubAllGlobals() }
    })
})
