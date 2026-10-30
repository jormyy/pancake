export type PerfBeacon = {
    screen: string
    useful_ms: number
    request_count: number
    transfer_bytes: number
    bytes_complete: boolean
    cold: boolean
    device_class: 'phone' | 'tablet' | 'desktop'
    connection_type: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown'
    app_version: string
    sample_n: number
}

type Resource = { startTime: number; responseEnd: number; transferSize: number; initiatorType: string }

type Options = {
    now: () => number
    online: () => boolean
    send: (rows: PerfBeacon[]) => Promise<unknown>
    schedule: (callback: () => void, delay: number) => unknown
    cancel: (timer: unknown) => void
    random?: () => number
    sampleN?: number
}

export function createPerfBeacon(options: Options) {
    let rows: PerfBeacon[] = []
    let timer: unknown
    let lastSend = options.now()
    let volumeStart = lastSend
    let volume = 0
    let stopped = false
    let inFlight = false
    const safely = (action: () => void) => { try { action() } catch {} }
    const drop = () => { rows = [] }
    const flush = (force = false) => safely(() => {
        if (force && timer !== undefined) options.cancel(timer)
        timer = undefined
        if (stopped || !options.online()) { drop(); return }
        if (!rows.length) return
        const delay = 60_000 - (options.now() - lastSend)
        if ((delay > 0 && !force) || inFlight) { arm(Math.max(delay, 60_000)); return }
        const batch = rows
        rows = []
        lastSend = options.now()
        inFlight = true
        void Promise.resolve().then(() => {
            if (!stopped && options.online()) return options.send(batch)
        }).catch(() => {}).finally(() => { inFlight = false })
    })
    const arm = (delay: number) => {
        if (timer === undefined) timer = options.schedule(() => flush(), delay)
    }
    return {
        open(screen: string, startedAt: number, metadata: Omit<PerfBeacon, 'screen' | 'useful_ms' | 'request_count' | 'transfer_bytes' | 'bytes_complete' | 'sample_n'>) {
            let completed = false
            let selected = false
            let sampleN = 1
            safely(() => {
                if (stopped || !options.online()) { drop(); return }
                if (options.now() - volumeStart >= 60_000) { volumeStart = options.now(); volume = 0 }
                volume += 1
                sampleN = Math.max(1, Math.min(10_000, Math.ceil(options.sampleN || 1)), volume > 20 ? 10 : 1)
                selected = (options.random ?? Math.random)() < 1 / sampleN
            })
            return {
                selected,
                painted(resources: Resource[]) {
                    safely(() => {
                        if (completed || !selected || stopped) return
                        completed = true
                        if (!options.online()) { drop(); return }
                        const end = options.now()
                        if (end < startedAt || end - startedAt > 120_000) return
                        const requests = resources.filter((entry) => ['fetch', 'xmlhttprequest'].includes(entry.initiatorType)
                            && entry.startTime >= startedAt && entry.responseEnd > 0 && entry.responseEnd <= end)
                        rows.push({ ...metadata, screen, useful_ms: Math.round(end - startedAt), request_count: Math.min(requests.length, 10_000),
                            transfer_bytes: Math.min(requests.reduce((total, entry) => total + Math.max(0, entry.transferSize || 0), 0), 1_000_000_000),
                            bytes_complete: requests.every((entry) => entry.transferSize > 0), sample_n: sampleN })
                        rows = rows.slice(-20)
                        arm(Math.max(0, 60_000 - (end - lastSend)))
                    })
                },
                cancel() { completed = true },
            }
        },
        drop,
        flushNow: () => flush(true),
        stop() { stopped = true; drop(); safely(() => { if (timer !== undefined) options.cancel(timer) }); timer = undefined },
    }
}

export function beaconScreen(path: string, view: { section?: string; tab?: string } = {}): string | null {
    const parts = path.split('?')[0].split('/').filter(Boolean)
    if (!parts.length) return 'home'
    if (parts[0] === 'player' && parts.length === 2) return 'player'
    if (parts.length === 1 && parts[0] === 'players' && view.section === 'waivers') return 'waivers'
    if (parts.length === 1 && parts[0] === 'league' && view.tab === 'draft') return 'draft-setup'
    return parts.length === 1 && /^(matchup|roster|players|league|trades|profile|draft|draft-room|rookie-draft-room|lineup|team-roster|bracket|claim-player|propose-trade|commissioner-settings|notification-settings|change-password|create-league|join-league)$/.test(parts[0]) ? parts[0] : null
}

function usefulContent(root: ParentNode, screen: string, visible: (element: Element) => boolean): Element | null {
    const titles: Record<string, string[]> = { home: ['Matchup'], matchup: ['Matchup'], waivers: ['Players'], 'draft-setup': ['League'], roster: ['Roster'], players: ['Players'], league: ['League'], trades: ['Trades', 'Trade details', 'Trade analysis'], profile: ['Profile'], draft: ['Draft Room', 'Auction Draft', 'Mock Auction Draft'], 'draft-room': ['Auction Draft', 'Mock Auction Draft'], 'rookie-draft-room': ['Rookie Draft', 'Mock Rookie Draft'], lineup: ['Lineup'], bracket: ['Playoffs'], 'claim-player': ['Waiver Claim'], 'commissioner-settings': ['League Settings'], 'notification-settings': ['Notifications'], 'change-password': ['Change Password'], 'create-league': ['Create League', 'League created'], 'join-league': ['Join League'] }
    const mains = Array.from(root.querySelectorAll('[role="dialog"],[role="main"]'))
    const main = mains.reverse().find((element) => visible(element))
    if (!main) return null
    if (titles[screen] && !Array.from(main.querySelectorAll('[role="heading"][aria-level="1"],h1')).some((element) => titles[screen].includes(element.textContent?.trim() ?? ''))) return null
    const excluded = 'nav,[role="navigation"],[role="tablist"],[role="heading"],h1,h2,h3,[role="progressbar"],[role="status"],[aria-busy="true"],[aria-hidden="true"],[inert],#pancake-boot-shell'
    if (screen === 'players') {
        const section = main.querySelector('[id^="players-section-"][aria-selected="true"]')?.id ?? 'players-section-players'
        if (section === 'players-section-players' && (!main.querySelector('input[placeholder="Search players..."]') || !/\d+(?: filtered)? players?/.test(main.textContent ?? ''))) return null
        if (section === 'players-section-rankings' && (!main.querySelector('[aria-label="Search dynasty rankings"]') || !/Updated |Not synced yet/.test(main.textContent ?? ''))) return null
    }
    if (screen === 'player' && !/averages|game log/i.test(main.textContent ?? '')) return null
    if (screen === 'rookie-draft-room' && /Loading prospects/i.test(main.textContent ?? '')) return null
    if (screen === 'draft') {
        const empty = Array.from(main.querySelectorAll('*')).find(element => !element.children.length && element.textContent?.trim() === 'No active draft' && visible(element))
        if (empty) return empty
    }
    const forms = new Set(['claim-player', 'propose-trade', 'commissioner-settings', 'notification-settings', 'change-password', 'create-league', 'join-league'])
    const selectors = '[aria-busy="false"],[aria-busy="false"] *,[data-testid="player-detail-scroll"] *,[role="listitem"],[role="row"]'
        + (forms.has(screen) ? ',input,textarea,[aria-label="Submit waiver claim"],[aria-label="Review trade proposal"]' : '')
        + (screen === 'notification-settings' ? ',[role="switch"]' : '')
        + (screen === 'draft' || screen === 'draft-room' ? ',[aria-label="Increase bid"],[aria-label="Search and nominate a player"],[aria-label="Pause draft"],[aria-label="Resume draft"]' : '')
        + (screen === 'rookie-draft-room' ? ',[aria-label="Show prospects"],[aria-label="Show pick board"]' : '')
    return Array.from(main.querySelectorAll(selectors))
        .find((element) => !element.closest(excluded) && visible(element)
            && (element.matches('input,textarea,[role="switch"],[aria-label="Increase bid"],[aria-label="Search and nominate a player"],[aria-label="Pause draft"],[aria-label="Resume draft"],[aria-label="Show prospects"],[aria-label="Show pick board"]') || (!element.children.length && !!element.textContent?.trim()
                && /[\p{L}\p{N}]/u.test(element.textContent)
                && !/^(loading|checking|calculating)(\b|…)/i.test(element.textContent.trim())))) ?? null
}

export function observeUsefulContent(screen: string, start: number, painted: () => void, cancelled: () => void) {
    let stopped = false
    let frame = 0
    let candidate: Element | null = null
    let candidateText = ''
    const visible = (element: Element) => {
        for (let node: Element | null = element; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        }
        const box = element.getBoundingClientRect()
        return box.width > 1 && box.height > 1 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
    }
    const check = () => {
        frame = 0
        if (stopped) return
        try {
            if (performance.now() - start > 120_000 || !navigator.onLine) { finish(); return }
            const content = document.visibilityState === 'visible' && !document.querySelector('#pancake-boot-shell[data-visible="1"]')
                ? usefulContent(document, screen, visible) : null
            if (candidate && content === candidate && content.textContent === candidateText) {
                painted()
                finish()
                return
            }
            candidate = content
            candidateText = content?.textContent ?? ''
            if (candidate) frame = requestAnimationFrame(check)
        } catch { finish() }
    }
    const observer = new MutationObserver(() => {
        if (!stopped && !frame) frame = requestAnimationFrame(check)
    })
    const finish = () => {
        if (stopped) return
        stopped = true
        cancelAnimationFrame(frame)
        clearTimeout(timeout)
        observer.disconnect()
        document.removeEventListener('visibilitychange', resume)
        cancelled()
    }
    const resume = () => { if (!stopped && !frame) frame = requestAnimationFrame(check) }
    const timeout = setTimeout(finish, Math.max(0, 120_000 - (performance.now() - start)))
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    document.addEventListener('visibilitychange', resume)
    frame = requestAnimationFrame(check)
    return finish
}
