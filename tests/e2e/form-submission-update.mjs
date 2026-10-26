import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink, rename, rm } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
const root = process.cwd(),
    base = path.resolve(root, '..'),
    require = createRequire(path.join(root, 'package.json'))
const cancelPendingCreation = process.env.FORM_CONFIRMATION_CANCEL_PENDING === '1'
const blockConfirmationStorage = process.env.FORM_CONFIRMATION_BLOCK_STORAGE === '1'
const legacyConfirmation = process.env.FORM_LEGACY_CONFIRMATION === '1'
if (legacyConfirmation) {
    assert.equal(process.env.SUBMISSIONS_ONLY, 'create-league', 'Legacy confirmation proof requires only create-league')
    assert.equal(blockConfirmationStorage || cancelPendingCreation, false, 'Legacy confirmation proof requires normal storage and completion')
}
const browserEngine = process.env.FORM_SUBMISSIONS_ENGINE ?? 'chromium'
assert.ok(['chromium', 'webkit'].includes(browserEngine))
const engine = require(process.env.FORM_SUBMISSIONS_PLAYWRIGHT ?? 'playwright')[browserEngine]
const { createClient } = require('@supabase/supabase-js')
const { readPwaRelease } = await import(path.join(root, 'tests/e2e/pwa-update-release.mjs'))
assert.equal(process.env.E2E_SUPABASE_URL, 'http://127.0.0.1:57121')
const databaseTarget = new URL(process.env.SUPABASE_DB_URL)
assert.ok(['postgres:', 'postgresql:'].includes(databaseTarget.protocol))
assert.equal(databaseTarget.hostname, '127.0.0.1')
assert.equal(databaseTarget.port, '57122')
assert.equal(databaseTarget.pathname, '/postgres')
assert.equal(databaseTarget.search, '')
assert.equal(databaseTarget.hash, '')
const databaseEnvironment = {
    ...process.env,
    PGHOST: databaseTarget.hostname,
    PGHOSTADDR: databaseTarget.hostname,
    PGPORT: databaseTarget.port,
    PGDATABASE: databaseTarget.pathname.slice(1),
    PGUSER: decodeURIComponent(databaseTarget.username),
    PGPASSWORD: decodeURIComponent(databaseTarget.password),
}
delete databaseEnvironment.PGSERVICE
delete databaseEnvironment.PGSERVICEFILE
const sql = (q) => {
    const result = spawnSync('psql', ['-XAt', '-v', 'ON_ERROR_STOP=1', '-c', q], {
        encoding: 'utf8',
        env: databaseEnvironment,
    })
    if (result.error || result.status !== 0) {
        throw new Error(
            'Local database query failed: ' + (result.stderr?.trim() || 'psql unavailable'),
        )
    }
    return result.stdout.trim()
}
if (process.argv.includes('--check-sql-errors')) {
    assert.equal(sql('select 42'), '42')
    assert.throws(
        () => sql('select 1/0'),
        (error) =>
            String(error).includes('division by zero') &&
            !String(error).includes(process.env.SUPABASE_DB_URL),
    )
    console.log('Local SQL success and failure checks pass without connection details')
    process.exit(0)
}
assert.ok(process.env.FORM_SUBMISSIONS_BEFORE, 'A complete baseline export is required')
assert.ok(process.env.FORM_SUBMISSIONS_AFTER, 'A complete candidate export is required')
assert.ok(process.env.FORM_SUBMISSIONS_OUTPUT, 'An evidence directory is required')
const before = await readPwaRelease(path.resolve(process.env.FORM_SUBMISSIONS_BEFORE))
const after = await readPwaRelease(path.resolve(process.env.FORM_SUBMISSIONS_AFTER))
assert.notEqual(before.bundleDigest, after.bundleDigest)
const applicationHashes = async (release) => {
    const marker = JSON.parse(
        await readFile(path.join(release.root, 'release-provenance.json'), 'utf8'),
    )
    return marker.artifact.files
        .filter((file) => file.path.startsWith('_expo/static/js/web/') && file.path.endsWith('.js'))
        .map((file) => file.sha256)
        .sort()
}
const applicationPayloads = {
    baseline: await applicationHashes(before),
    candidate: await applicationHashes(after),
}
assert.ok(applicationPayloads.baseline.length && applicationPayloads.candidate.length)
assert.notDeepEqual(
    applicationPayloads.baseline,
    applicationPayloads.candidate,
    'Application JavaScript must differ beyond release labels',
)
const liveName = process.env.FORM_SUBMISSIONS_LIVE ?? 'submissions-live'
assert.match(liveName, /^[a-z0-9-]+$/)
const origin = 'http://127.0.0.1:57198',
    live = path.join(base, 'releases/' + liveName)
const output = path.resolve(process.env.FORM_SUBMISSIONS_OUTPUT)
const admin = createClient(
    process.env.E2E_SUPABASE_URL,
    process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
)
const client = () =>
    createClient(process.env.E2E_SUPABASE_URL, process.env.E2E_SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
const db = async (query) => {
    const { data, error } = await query
    assert.ifError(error)
    return data
}
const users = [],
    leagues = [],
    contexts = [],
    secrets = [],
    signupEmails = [],
    createdLeagueNames = []
const report = {
    passed: false,
    browserEngine,
    blockConfirmationStorage,
    legacyConfirmation,
    cancelPendingCreation,
    before,
    after,
    applicationPayloads,
    cases: [],
    credentialSources: [
        'Local fixture credentials arrive through E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY, E2E_PANCAKE_SUPABASE_SECRET_KEY and SUPABASE_DB_URL.',
        'Synthetic account passwords generated in process memory; never written to evidence.',
    ],
    limits: [
        'Local ' +
            browserEngine +
            ' with real service worker; no physical iPhone, Safari or installed PWA claim.',
        'Successful upstream response is held at the browser network boundary; no fabricated responses.',
        'All public/private application tables fingerprinted separately from safe auth state.',
        'Existing broad-suite failures remain outside this bounded check; no broad suite rerun.',
        'No production, publishing, CI, historical replay, performance comparison or whole-app review.',
    ],
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fingerprints = () =>
    Object.fromEntries(
        sql(
            "select schemaname||'.'||tablename from pg_tables where schemaname in ('public','private') order by 1",
        )
            .split('\n')
            .map((t) => [
                t,
                sql(
                    `select count(*)||':'||coalesce(md5(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text)),'empty') from ${t
                        .split('.')
                        .map((s) => '"' + s + '"')
                        .join('.')} t`,
                ),
            ]),
    )
const authState = () =>
    JSON.parse(
        sql(
            `select json_build_object('users',(select coalesce(json_agg(x order by x.id),'[]') from (select id,email,created_at,updated_at,last_sign_in_at,email_confirmed_at from auth.users) x),'sessions',(select coalesce(json_agg(x order by x.id),'[]') from (select id,user_id,created_at,updated_at,aal from auth.sessions) x),'identities',(select coalesce(json_agg(x order by x.id),'[]') from (select id,user_id,provider,created_at,updated_at,last_sign_in_at from auth.identities) x))`,
        ),
    )
const state = () => ({ business: fingerprints(), auth: authState() })
const changed = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k])
const inspect = (p) =>
    p.evaluate(() => ({
        version: document.querySelector('meta[name="pancake-release"]')?.content,
        timeOrigin: performance.timeOrigin,
        path: location.pathname,
        holds: [...(window.__pancakePwaHolds?.values() ?? [])].map((h) => h.reason),
        fields: [...document.querySelectorAll('input,textarea')].map((i) => ({
            label: i.getAttribute('aria-label') ?? i.placeholder,
            value: i.type === 'password' ? (i.value ? '<nonempty>' : '') : i.value,
        })),
    }))
const swap = async (r) => {
    await symlink(r.root, live + '.next')
    await rename(live + '.next', live)
}
const secret = () => {
    const value = randomBytes(24).toString('base64url') + 'aA1!'
    secrets.push(value)
    return value
}
const makeUser = async (label) => {
    const suffix = randomBytes(6).toString('hex'),
        email = `forms_${label}_${suffix}@example.test`,
        password = secret(),
        username = `forms_${label}_${suffix}`
    const result = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, display_name: 'Forms ' + label },
    })
    assert.ifError(result.error)
    users.push(result.data.user.id)
    return { id: result.data.user.id, email, password, username }
}
const sign = async (u) => {
    const c = client(),
        r = await c.auth.signInWithPassword({ email: u.email, password: u.password })
    assert.ifError(r.error)
    return { client: c, session: r.data.session }
}
const createFixtureLeague = async (u, label) => {
    const c = await sign(u)
    const league = await db(
        c.client.rpc('create_league', {
            p_name: 'Forms fixture ' + label,
            p_team_name: 'Fixture ' + label,
            p_auction_budget: 200,
        }),
    )
    leagues.push(league.id)
    await db(
        admin
            .from('leagues')
            .update({ waiver_mode: 'faab', faab_starting_budget: 100 })
            .eq('id', league.id),
    )
    const member = await db(
        admin
            .from('league_members')
            .select('*')
            .eq('league_id', league.id)
            .eq('user_id', u.id)
            .single(),
    )
    return { league, member }
}
let browser, server, page
await mkdir(output, { recursive: true })
const record = async () => {
    let body = JSON.stringify(report, null, 2)
    for (const value of secrets)
        assert.ok(!body.includes(value), 'Evidence excludes all generated passwords')
    await writeFile(path.join(output, 'summary.json'), body + '\n')
}
try {
    report.businessBeforeFixtures = fingerprints()
    await rm(live, { force: true })
    await rm(live + '.next', { force: true })
    await swap(before)
    server = spawn(
        'node',
        ['tests/e2e/static-web-server.mjs', '--root=' + live, '--port=57198', '--host=127.0.0.1'],
        { cwd: root, stdio: 'ignore' },
    )
    for (let i = 0; i < 100; i++) {
        if (
            await fetch(origin)
                .then((r) => r.ok)
                .catch(() => false)
        )
            break
        await wait(100)
    }
    browser = await engine.launch({ headless: true })
    const owner = await makeUser('owner'),
        joiner = await makeUser('joiner')
    const fixture = await createFixtureLeague(owner, 'main'),
        target = await createFixtureLeague(owner, 'join')
    report.fixture = {
        users,
        leagues,
        main: fixture.league.id,
        member: fixture.member.id,
        joinTarget: target.league.id,
    }
    const definitions = [
        {
            name: 'sign-in',
            route: '/sign-in',
            anonymous: true,
            match: '/auth/v1/token',
            method: 'POST',
            submit: 'Sign In',
            reason: 'signIn',
        },
        {
            name: 'sign-up',
            route: '/sign-up',
            anonymous: true,
            match: '/auth/v1/signup',
            method: 'POST',
            submit: 'Create Account',
            reason: 'signUp',
        },
        {
            name: 'change-password',
            route: '/change-password',
            match: '/auth/v1/user',
            method: 'PUT',
            submit: 'Update password',
            reason: 'changePassword',
        },
        {
            name: 'create-league',
            route: '/create-league',
            match: '/rest/v1/rpc/create_league',
            method: 'POST',
            submit: 'Create league',
            reason: 'createLeague',
        },
        {
            name: 'join-league',
            route: '/join-league',
            actor: joiner,
            match: '/rest/v1/rpc/join_league_by_invite_code',
            method: 'POST',
            submit: 'Join league',
            reason: 'joinLeague',
        },
        {
            name: 'commissioner-settings',
            route: '/commissioner-settings',
            match: '/rest/v1/rpc/update_league_configuration_atomic',
            method: 'POST',
            submit: 'Save league settings',
            reason: 'updateLeagueConfiguration',
        },
        {
            name: 'commissioner-faab',
            route: '/commissioner-settings',
            match: '/rest/v1/rpc/commissioner_adjust_faab_balance_atomic',
            method: 'POST',
            submit: 'Set FAAB',
            reason: 'adjustFaabBalance',
        },
        {
            name: 'commissioner-adds',
            route: '/commissioner-settings',
            match: '/rest/v1/rpc/commissioner_override_weekly_add_count_atomic',
            method: 'POST',
            submit: 'Set Adds',
            reason: 'overrideWeeklyAddCount',
        },
        {
            name: 'profile-team-name',
            route: '/profile',
            match: '/rest/v1/league_members',
            method: 'PATCH',
            submit: 'Save',
            reason: 'updateTeamName',
        },
    ]
    for (const def of definitions) {
        if (
            process.env.SUBMISSIONS_ONLY &&
            !process.env.SUBMISSIONS_ONLY.split(',').includes(def.name)
        )
            continue
        console.log('Starting ' + def.name)
        await swap(before)
        const row = { name: def.name, samples: [], mutations: [] }
        report.cases.push(row)
        const actor = def.actor ?? owner
        let legacyObserver = null
        let session = null
        if (!def.anonymous) session = (await sign(actor)).session
        const storage = session
            ? {
                  cookies: [],
                  origins: [
                      {
                          origin,
                          localStorage: [
                              { name: 'sb-127-auth-token', value: JSON.stringify(session) },
                              {
                                  name: `pancake:selected-league:v1:${actor.id}`,
                                  value: JSON.stringify({
                                      version: 1,
                                      savedAt: Date.now(),
                                      value: fixture.member.id,
                                  }),
                              },
                          ],
                      },
                  ],
              }
            : undefined
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            storageState: storage,
        })
        contexts.push(context)
        page = await context.newPage()
        if (def.name === 'create-league') {
            await page.addInitScript(
                ({ blockStorage, holdFetch, apiOrigin }) => {
                    if (holdFetch) {
                        const originalFetch = window.fetch.bind(window)
                        window.fetch = async (input, options) => {
                            const target = new URL(
                                input instanceof Request ? input.url : String(input),
                                location.href,
                            )
                            const response = await originalFetch(input, options)
                            if (
                                window.__holdCreateResponse &&
                                target.origin === apiOrigin &&
                                target.pathname === '/rest/v1/rpc/create_league'
                            ) {
                                window.__heldCreateResponse = {
                                    status: response.status,
                                    path: target.pathname,
                                }
                                await new Promise((resolve) => {
                                    window.__releaseCreateResponse = resolve
                                })
                                window.__holdCreateResponse = false
                            }
                            return response
                        }
                    }
                    window.__confirmationShares = []
                    Object.defineProperty(navigator, 'share', {
                        configurable: true,
                        value: async (data) => {
                            window.__confirmationShares.push(data)
                            if (window.__confirmationShares.length === 1)
                                throw new DOMException('Cancelled', 'AbortError')
                        },
                    })
                    if (blockStorage) {
                        const original = Storage.prototype.setItem
                        Storage.prototype.setItem = function (key, value) {
                            if (
                                this === sessionStorage &&
                                key === 'pancake:editor-draft:created-league'
                            )
                                throw new DOMException('Full', 'QuotaExceededError')
                            return original.call(this, key, value)
                        }
                    }
                },
                {
                    blockStorage: blockConfirmationStorage,
                    holdFetch: browserEngine === 'webkit',
                    apiOrigin: process.env.E2E_SUPABASE_URL,
                },
            )
        }
        page.setDefaultTimeout(20000)
        page.on('pageerror', (e) => (row.errors ??= []).push(e.message))
        context.on('request', (request) => {
            const url = new URL(request.url())
            if (
                url.origin === process.env.E2E_SUPABASE_URL &&
                !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
            )
                row.mutations.push({ method: request.method(), path: url.pathname })
        })
        page.on('dialog', (dialog) => dialog.accept())
        await page.goto(origin + (legacyConfirmation ? '/profile' : def.route))
        if (legacyConfirmation) {
            await page.getByRole('button', { name: 'Create a league', exact: true }).click()
            await page.waitForURL(url => url.pathname === '/create-league')
        }
        if (def.anonymous)
            await page.waitForFunction(() => !document.getElementById('pancake-auth-document'))
        if (def.name === 'create-league') {
            await page.waitForFunction(() =>
                Object.keys(document.querySelector('input[aria-label="League name"]') ?? {}).some(
                    (key) => key.startsWith('__reactFiber'),
                ),
            )
        }
        const inputs = []
        const fill = async (label, value, placeholder = false) => {
            const input = placeholder
                ? page.getByPlaceholder(label, { exact: true })
                : page.getByLabel(label, { exact: true })
            await input.fill(value)
            inputs.push({
                input,
                value,
                password: (await input.getAttribute('type')) === 'password',
            })
            return input
        }
        const signup = {
            email: `forms_signup_${randomBytes(6).toString('hex')}@example.test`,
            username: 'forms_' + randomBytes(6).toString('hex'),
            password: secret(),
            display: '  Signup Ω  ',
        }
        let nextPassword
        if (def.name === 'sign-in') {
            await fill('Email', owner.email)
            await fill('Password', secret())
        }
        if (def.name === 'sign-up') {
            signupEmails.push(signup.email)
            await fill('Display name', signup.display)
            await fill('Username', signup.username)
            await fill('Email', signup.email)
            await fill('Password', signup.password)
        }
        if (def.name === 'change-password') {
            nextPassword = secret()
            await fill('Current password', owner.password)
            await fill('New password', nextPassword)
            await fill('Confirm new password', nextPassword)
        }
        if (def.name === 'create-league') {
            row.leagueName = 'Forms submitted ' + randomBytes(4).toString('hex')
            createdLeagueNames.push(row.leagueName)
            await fill('League name', '  ' + row.leagueName + '  ')
            await fill('Your team name', '  Created Ω  ')
            await fill('Auction budget per team', '0321')
        }
        if (def.name === 'join-league') {
            await fill('Invite code', '  ' + target.league.invite_code + '  ')
            await fill('Your team name', '  Joined Ω  ')
        }
        if (def.name === 'commissioner-settings') await fill('Auction Budget ($)', '0321')
        if (def.name === 'commissioner-faab') await fill('FAAB balance', '0083', true)
        if (def.name === 'commissioner-adds') await fill('Weekly adds used', '02', true)
        if (def.name === 'profile-team-name') {
            await page.getByRole('button', { name: 'Edit', exact: true }).click()
            await fill('Team name', '  Saved team Ω  ')
        }
        await page.waitForFunction(
            () => !!navigator.serviceWorker.controller && !!window.__pancakePwaHolds?.size,
        )
        const exact = async () => {
            for (const { input, value, password } of inputs) {
                const actual = await input.inputValue()
                assert.ok(
                    actual === value,
                    password
                        ? 'Exact password retained in memory'
                        : 'Exact ' + (await input.getAttribute('aria-label')) + ' retained',
                )
            }
        }
        row.filled = await inspect(page)
        await exact()
        row.initial = await inspect(page)
        if (legacyConfirmation) {
            legacyObserver = await context.newPage()
            await legacyObserver.goto(origin + '/profile')
            await legacyObserver.getByRole('button', { name: 'Edit', exact: true }).waitFor()
            await legacyObserver.waitForFunction(() => !!navigator.serviceWorker.controller)
            row.legacyObserverInitial = await inspect(legacyObserver)
        }
        row.before = state()
        if (def.name !== 'create-league') await swap(after)
        await page.evaluate(() => dispatchEvent(new Event('online')))
        if (def.name !== 'create-league') {
            await page.waitForFunction(
                async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
                undefined,
                { timeout: 45000 },
            )
        }
        if (browserEngine === 'chromium') {
            const worker = await browser.newBrowserCDPSession()
            row.workers = (await worker.send('Target.getTargets')).targetInfos
                .filter((t) => t.type === 'service_worker')
                .map((t) => ({ url: t.url, attached: t.attached }))
            assert.ok(row.workers.length && row.workers.every((t) => !t.attached))
            await worker.detach()
        }
        for (let i = 0; i < 5; i++) {
            await wait(1000)
            await exact()
            const s = await inspect(page)
            assert.equal(s.timeOrigin, row.initial.timeOrigin)
            assert.equal(s.version, before.version)
            row.samples.push(s)
        }
        row.afterWaiting = state()
        assert.deepEqual(row.afterWaiting, row.before)
        row.exactUnsentRetained = true
        row.waitingCandidate = def.name !== 'create-league'
        let gate = null,
            arrived = null,
            held = null
        if (browserEngine !== 'webkit' || def.name !== 'create-league')
            await context.route(
                (url) => url.origin === process.env.E2E_SUPABASE_URL && url.pathname === def.match,
                async (route) => {
                    if (route.request().method() !== def.method || !gate) return route.continue()
                    const release = gate
                    gate = null
                    try {
                        const response = await route.fetch({ maxRetries: 0 })
                        held = {
                            status: response.status(),
                            path: new URL(route.request().url()).pathname,
                        }
                        arrived.resolve()
                        await release.promise
                        await route.fulfill({ response })
                    } catch (e) {
                        arrived.reject(e)
                        throw e
                    }
                },
            )
        const deferred = () => {
            let resolve, reject
            const promise = new Promise((a, b) => {
                resolve = a
                reject = b
            })
            return { promise, resolve, reject }
        }
        const heldSubmit = async (reject) => {
            gate = deferred()
            const pending = gate
            arrived = deferred()
            const fetchBoundary = browserEngine === 'webkit' && def.name === 'create-league'
            if (fetchBoundary)
                await page.evaluate(() => {
                    window.__holdCreateResponse = true
                })
            const received = fetchBoundary
                ? page
                      .waitForFunction(() => window.__heldCreateResponse, undefined, {
                          timeout: 25000,
                      })
                      .then(async (handle) => {
                          held = await handle.jsonValue()
                      })
                : arrived.promise
            const submit =
                def.name.startsWith('commissioner-') && def.name !== 'commissioner-settings'
                    ? page.getByText(def.submit, { exact: true })
                    : page.getByRole('button', { name: def.submit, exact: true })
            await submit.click()
            await Promise.race([
                received,
                wait(25000).then(() => {
                    throw new Error('Actual server response not intercepted')
                }),
            ])
            assert.ok(
                reject ? held.status >= 400 : held.status >= 200 && held.status < 300,
                'Expected real upstream response status',
            )
            if (def.name === 'create-league') {
                row.chronology = [{ event: 'real-response-held', at: new Date().toISOString() }]
                await swap(after)
                row.chronology.push({
                    event: 'complete-update-published',
                    at: new Date().toISOString(),
                })
                await page.evaluate(() => dispatchEvent(new Event('online')))
                await page.waitForFunction(
                    async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
                    undefined,
                    { timeout: 45000 },
                )
                row.waitingCandidate = true
                row.chronology.push({
                    event: 'update-waiting-during-request',
                    at: new Date().toISOString(),
                })
                await page.screenshot({ path: path.join(output, 'create-league-held.png') })
            }
            const samples = []
            for (let i = 0; i < 4; i++) {
                await wait(1000)
                if (reject) await exact()
                const s = await inspect(page)
                assert.equal(s.timeOrigin, row.initial.timeOrigin)
                assert.equal(s.version, before.version)
                assert.ok(s.holds.includes(def.reason))
                samples.push(s)
            }
            const committed = state()
            row[reject ? 'rejectedRequest' : 'successfulRequest'] = {
                ...held,
                responseHeld: true,
                holdBoundary: fetchBoundary
                    ? 'real browser fetch response before application consumption'
                    : 'browser network route',
                samples,
                upstreamCompleted: committed,
            }
            if (def.name === 'create-league' && cancelPendingCreation) {
                await page.getByRole('button', { name: 'Back', exact: true }).click()
                await page.getByRole('button', { name: 'Edit', exact: true }).waitFor()
                row.pendingCreationDismissed = true
            }
            row.chronology?.push({ event: 'response-released', at: new Date().toISOString() })
            if (fetchBoundary) await page.evaluate(() => window.__releaseCreateResponse())
            pending.resolve()
            return committed
        }
        if (def.name === 'sign-in') {
            await heldSubmit(true)
            await page.getByText('Invalid login credentials', { exact: true }).waitFor()
            await exact()
            assert.equal((await inspect(page)).timeOrigin, row.initial.timeOrigin)
            assert.deepEqual(fingerprints(), row.before.business)
            row.rejection = { retained: true, correctable: true, documentSurvives: true }
            inputs[1].value = owner.password
            await inputs[1].input.fill(owner.password)
        }
        const committed = await heldSubmit(false)
        if (def.name === 'create-league') {
            const saved = await db(
                admin.from('leagues').select('*').eq('name', row.leagueName).single(),
            )
            leagues.push(saved.id)
            row.saved = {
                league: saved.id,
                auctionBudget: saved.auction_budget,
                inviteCode: saved.invite_code,
            }
            row.independentReceipt = JSON.parse(
                sql(
                    `select json_agg(x) from (select id, name, invite_code, auction_budget from leagues where name='${row.leagueName}') x`,
                ),
            )
            assert.equal(row.independentReceipt.length, 1)
            assert.equal(row.independentReceipt[0].invite_code, saved.invite_code)
            assert.equal(saved.auction_budget, 321)
            const member = await db(
                admin
                    .from('league_members')
                    .select('id,team_name,user_id')
                    .eq('league_id', saved.id)
                    .single(),
            )
            assert.equal(member.team_name, 'Created Ω')
            assert.equal(member.user_id, owner.id)
            row.saved.member = member.id
            row.createdLeagueConfirmed = true
        }
        if (def.name === 'sign-up') {
            const saved = await db(
                admin
                    .from('profiles')
                    .select('id,username,display_name')
                    .eq('username', signup.username)
                    .single(),
            )
            users.push(saved.id)
            row.saved = saved
            assert.equal(saved.display_name, 'Signup Ω')
            row.expectedAccount = saved.id
        }
        if (def.name === 'change-password') owner.password = nextPassword
        if (def.name === 'create-league' && (blockConfirmationStorage || legacyConfirmation)) {
            await page.getByRole('button', { name: 'Share invite code', exact: true }).waitFor()
            await wait(5000)
            row.storageFailureHeld = await inspect(page)
            assert.equal(row.storageFailureHeld.timeOrigin, row.initial.timeOrigin)
            if (blockConfirmationStorage) assert.ok(row.storageFailureHeld.holds.includes('create league form'))
            if (legacyConfirmation) assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), true)
            assert.ok((await page.locator('body').innerText()).includes(row.saved.inviteCode))
            await page.screenshot({ path: path.join(output, 'create-league-storage-held.png') })
            await page.getByRole('button', { name: 'Done', exact: true }).click()
            row.chronology.push({
                event: legacyConfirmation ? 'legacy-confirmation-dismissed' : 'storage-failure-confirmation-dismissed',
                at: new Date().toISOString(),
            })
        }
        if (legacyConfirmation) {
            await page.waitForURL(url => url.pathname !== '/create-league')
            row.legacyDonePath = new URL(page.url()).pathname
            await context.setOffline(true)
            await page.waitForFunction(() => navigator.onLine === false)
            await wait(250)
            await context.setOffline(false)
            await page.waitForFunction(() => navigator.onLine === true)
            await wait(1000)
            row.legacyAfterReconnect = await inspect(page)
            assert.equal(row.legacyAfterReconnect.timeOrigin, row.initial.timeOrigin)
            assert.equal(row.legacyAfterReconnect.version, before.version)
            assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), true)
            await page.close()
            await wait(1000)
            row.legacyRemainingTab = await inspect(legacyObserver)
            assert.equal(row.legacyRemainingTab.version, before.version)
            assert.equal(row.legacyRemainingTab.timeOrigin, row.legacyObserverInitial.timeOrigin)
            assert.equal(await legacyObserver.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), true)
            await legacyObserver.close()
            await wait(1000)
            page = await context.newPage()
            page.setDefaultTimeout(20000)
            page.on('pageerror', error => (row.errors ??= []).push(error.message))
            await page.goto(origin + row.legacyDonePath)
            row.chronology.push({ event: 'all-legacy-tabs-closed-and-app-reopened', at: new Date().toISOString() })
        }
        await page.waitForFunction(
            (expected) =>
                document.querySelector('meta[name="pancake-release"]')?.content === expected,
            after.version,
            { timeout: 60000 },
        )
        row.updated = await inspect(page)
        if (def.name === 'create-league' && !blockConfirmationStorage && !cancelPendingCreation && !legacyConfirmation) {
            row.chronology.push({
                event: 'automatic-reload-observed',
                at: new Date().toISOString(),
            })
            await page
                .getByRole('button', { name: /Create league|Share invite code/i })
                .first()
                .waitFor()
            row.updated = await inspect(page)
            row.immediateBody = await page.locator('body').innerText()
            await page.screenshot({ path: path.join(output, 'create-league-immediate.png') })
            await record()
            assert.ok(
                row.immediateBody.includes('League created'),
                'Immediate confirmation survives automatic reload',
            )
            assert.ok(
                row.immediateBody.includes(row.saved.inviteCode),
                'Immediate confirmation shows the independently saved invite code',
            )
            await page.getByRole('button', { name: 'Share invite code', exact: true }).waitFor()
            row.immediateConfirmation = true
        }
        assert.notEqual(row.updated.timeOrigin, row.initial.timeOrigin)
        assert.equal(row.updated.holds.length, 0)
        row.afterUpdate = state()
        assert.deepEqual(
            row.afterUpdate.business,
            committed.business,
            'Automatic update repeats no business mutation',
        )
        row.businessChanges = changed(row.before.business, committed.business)
        row.authChangedDuringSubmit =
            JSON.stringify(row.before.auth) !== JSON.stringify(committed.auth)
        row.authChangedDuringUpdate =
            JSON.stringify(committed.auth) !== JSON.stringify(row.afterUpdate.auth)
        assert.equal(
            row.authChangedDuringUpdate,
            false,
            'Automatic update repeats no authentication change',
        )
        const expectedAccount = row.expectedAccount ?? actor.id
        const storedUser = await page.evaluate(
            () => JSON.parse(localStorage.getItem('sb-127-auth-token') ?? 'null')?.user?.id,
        )
        assert.equal(storedUser, expectedAccount)
        row.correctAccount = storedUser
        const identity = await page.evaluate(
            async ({ url, key }) => {
                const stored = JSON.parse(localStorage.getItem('sb-127-auth-token'))
                const response = await fetch(url + '/auth/v1/user', {
                    headers: { apikey: key, Authorization: 'Bearer ' + stored.access_token },
                })
                const user = await response.json()
                return { status: response.status, id: user.id }
            },
            { url: process.env.E2E_SUPABASE_URL, key: process.env.E2E_SUPABASE_PUBLISHABLE_KEY },
        )
        assert.equal(identity.status, 200)
        assert.equal(identity.id, expectedAccount)
        row.serverVerifiedAccount = identity.id
        if (def.name === 'create-league' && !blockConfirmationStorage && !cancelPendingCreation && !legacyConfirmation) {
            await page.getByRole('button', { name: 'Share invite code', exact: true }).click()
            await page.getByRole('button', { name: 'Share invite code', exact: true }).click()
            row.shareCalls = await page.evaluate(() => window.__confirmationShares)
            assert.equal(row.shareCalls.length, 2)
            assert.ok(row.shareCalls.every((call) => call.text.includes(row.saved.inviteCode)))
            assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).count(), 1)
            row.shareCancellationAndRetry = true
            const ownedConfirmation = await page.evaluate(() =>
                sessionStorage.getItem('pancake:editor-draft:created-league'),
            )
            await page.reload()
            await page.getByRole('button', { name: 'Share invite code', exact: true }).waitFor()
            assert.ok((await page.locator('body').innerText()).includes(row.saved.inviteCode))
            row.manualReloadRetainsConfirmation = true
            const otherSession = (await sign(joiner)).session
            const otherContext = await browser.newContext({
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
                storageState: {
                    cookies: [],
                    origins: [
                        {
                            origin,
                            localStorage: [
                                { name: 'sb-127-auth-token', value: JSON.stringify(otherSession) },
                            ],
                        },
                    ],
                },
            })
            contexts.push(otherContext)
            const otherPage = await otherContext.newPage()
            await otherPage.addInitScript(
                (value) => sessionStorage.setItem('pancake:editor-draft:created-league', value),
                ownedConfirmation,
            )
            await otherPage.goto(origin + '/create-league')
            await otherPage.getByLabel('League name', { exact: true }).waitFor()
            await otherPage.waitForFunction(
                () => sessionStorage.getItem('pancake:editor-draft:created-league') === null,
            )
            assert.ok(!(await otherPage.locator('body').innerText()).includes(row.saved.inviteCode))
            assert.equal(
                await otherPage.evaluate(() =>
                    sessionStorage.getItem('pancake:editor-draft:created-league'),
                ),
                null,
            )
            row.otherAccountRejectsConfirmation = true
            await otherPage.screenshot({
                path: path.join(output, 'create-league-other-account.png'),
            })
            await otherContext.close()
            await page.getByRole('button', { name: 'Done', exact: true }).click()
            await page.getByRole('button', { name: 'Edit', exact: true }).waitFor()
            await page.goto(origin + '/create-league')
            await page.getByLabel('League name', { exact: true }).waitFor()
            assert.equal(await page.getByLabel('League name', { exact: true }).inputValue(), '')
            assert.equal(
                await page.getByRole('button', { name: 'Share invite code', exact: true }).count(),
                0,
            )
            await page.getByLabel('League name', { exact: true }).fill('Cancelled owned draft')
            await page.getByRole('button', { name: 'Back', exact: true }).click()
            await page.getByRole('button', { name: 'Edit', exact: true }).waitFor()
            row.dismissalAndCancellation = true
        }
        if (def.name === 'join-league') {
            const saved = await db(
                admin
                    .from('league_members')
                    .select('id,team_name,league_id,user_id')
                    .eq('league_id', target.league.id)
                    .eq('user_id', joiner.id)
                    .single(),
            )
            assert.equal(saved.team_name, 'Joined Ω')
            row.saved = saved
        }
        if (def.name === 'commissioner-settings') {
            const saved = await db(
                admin
                    .from('leagues')
                    .select('id,auction_budget')
                    .eq('id', fixture.league.id)
                    .single(),
            )
            assert.equal(saved.auction_budget, 321)
            row.saved = saved
        }
        if (def.name === 'commissioner-faab') {
            row.saved = await db(
                admin
                    .from('faab_balances')
                    .select('league_id,member_id,balance')
                    .eq('league_id', fixture.league.id)
                    .eq('member_id', fixture.member.id)
                    .single(),
            )
            assert.equal(row.saved.balance, 83)
        }
        if (def.name === 'commissioner-adds') {
            row.saved = await db(
                admin
                    .from('weekly_add_counts')
                    .select('league_id,member_id,add_count,week_number')
                    .eq('league_id', fixture.league.id)
                    .eq('member_id', fixture.member.id)
                    .single(),
            )
            assert.equal(row.saved.add_count, 2)
        }
        if (def.name === 'profile-team-name') {
            row.saved = await db(
                admin
                    .from('league_members')
                    .select('league_id,user_id,team_name')
                    .eq('id', fixture.member.id)
                    .single(),
            )
            assert.equal(row.saved.team_name, 'Saved team Ω')
        }
        if (def.name === 'change-password') {
            const reauth = await client().auth.signInWithPassword({
                email: owner.email,
                password: nextPassword,
            })
            assert.ifError(reauth.error)
            assert.equal(reauth.data.user.id, owner.id)
            const verified = await client().auth.getUser(reauth.data.session.access_token)
            assert.ifError(verified.error)
            assert.equal(verified.data.user.id, owner.id)
            const old = await client().auth.signInWithPassword({
                email: owner.email,
                password: inputs[0].value,
            })
            assert.ok(old.error)
            row.reauthentication = {
                newPasswordAccepted: true,
                serverUserVerified: true,
                previousPasswordRejected: true,
                account: owner.id,
            }
        }
        const expectedCount = def.name === 'sign-in' ? 2 : 1
        assert.equal(
            row.mutations.filter((x) => x.path === def.match && x.method === def.method).length,
            expectedCount,
            'Action under test submits exactly once per deliberate attempt',
        )
        await page.goto(origin + '/profile')
        await page.getByRole('button', { name: 'Edit', exact: true }).waitFor()
        row.visibleProfile = await page.locator('body').innerText()
        const selected = await page.evaluate(
            (user) =>
                JSON.parse(localStorage.getItem('pancake:selected-league:v1:' + user) ?? 'null')
                    ?.value,
            expectedAccount,
        )
        if (def.name === 'sign-up') {
            assert.ok(row.visibleProfile.includes('Signup Ω'))
            assert.ok(!selected)
            row.correctLeague = null
        } else {
            const member = await db(
                admin
                    .from('league_members')
                    .select('id,user_id,league_id,team_name')
                    .eq('id', selected)
                    .single(),
            )
            assert.equal(member.user_id, expectedAccount)
            assert.equal(
                member.league_id,
                def.name === 'join-league' ? target.league.id : fixture.league.id,
            )
            assert.ok(row.visibleProfile.includes(member.team_name))
            row.correctLeague = member.league_id
            row.selectedMember = member.id
        }
        if (def.name === 'profile-team-name') assert.ok(row.visibleProfile.includes('Saved team Ω'))
        assert.deepEqual(
            fingerprints(),
            committed.business,
            'Post-update navigation repeats no business mutation',
        )
        const storageText = await page.evaluate(() =>
            JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
        )
        for (const password of secrets)
            assert.ok(!storageText.includes(password), 'No password persisted in browser storage')
        row.passwordsAbsentFromStorage = true
        if (def.name === 'create-league' && cancelPendingCreation) {
            assert.equal(
                await page.evaluate(() =>
                    sessionStorage.getItem('pancake:editor-draft:created-league'),
                ),
                null,
                'Dismissed pending creation leaves no stale confirmation',
            )
            await page.goto(origin + '/create-league')
            await page.waitForFunction(() =>
                Object.keys(document.querySelector('input[aria-label="League name"]') ?? {}).some(
                    (key) => key.startsWith('__reactFiber'),
                ),
            )
            assert.equal(
                await page.getByRole('button', { name: 'Share invite code', exact: true }).count(),
                0,
                'Dismissed pending creation leaves no stale confirmation',
            )
            assert.equal(await page.getByLabel('League name', { exact: true }).inputValue(), '')
            row.pendingCancellationLeavesFreshForm = true
        }
        row.released = true
        row.passed = true
        await page.screenshot({ path: path.join(output, def.name + '-after.png') })
        await context.close()
        console.log('Passed ' + def.name)
        await record()
    }
    report.expectedCases = definitions.filter(
        (d) =>
            !process.env.SUBMISSIONS_ONLY ||
            process.env.SUBMISSIONS_ONLY.split(',').includes(d.name),
    ).length
    assert.ok(
        report.expectedCases > 0 &&
            report.cases.length === report.expectedCases &&
            report.cases.every((c) => c.passed),
    )
    report.passed = true
} catch (e) {
    report.failure = String(e.stack ?? e)
    process.exitCode = 1
    if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
        await writeFile(
            path.join(output, 'failure-body.txt'),
            await page
                .locator('body')
                .innerText()
                .catch(() => ''),
        )
    }
} finally {
    for (const c of contexts) await c.close().catch(() => {})
    await browser?.close()
    const errors = []
    for (const email of signupEmails) {
        const ids = sql(`select id from auth.users where email='${email}'`)
            .split('\n')
            .filter(Boolean)
        users.push(...ids)
    }
    for (const name of createdLeagueNames) {
        const found = await db(admin.from('leagues').select('id').eq('name', name))
        leagues.push(...found.map((x) => x.id))
    }
    const dependentIds = leagues.length
        ? sql(
              `select id from league_members where league_id in (${[...new Set(leagues)].map((id) => "'" + id + "'").join(',')}) union select id from league_seasons where league_id in (${[...new Set(leagues)].map((id) => "'" + id + "'").join(',')})`,
          )
              .split('\n')
              .filter(Boolean)
        : []
    report.revisionsBeforeFixtureCleanup = JSON.parse(
        sql("select coalesce(json_agg(t),'[]') from private.score_input_revisions t"),
    )
    for (const id of [...new Set(leagues)].reverse()) {
        try {
            await db(admin.from('leagues').delete().eq('id', id))
        } catch (e) {
            errors.push(String(e))
        }
    }
    for (const id of [...new Set(users)].reverse()) {
        const r = await admin.auth.admin.deleteUser(id)
        if (r.error) errors.push(r.error.message)
    }
    const ownedIds = new Set([...users, ...leagues, ...dependentIds])
    const collectOwnedIds = (value) => {
        if (typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value))
            ownedIds.add(value)
        else if (Array.isArray(value)) value.forEach(collectOwnedIds)
        else if (value && typeof value === 'object') Object.values(value).forEach(collectOwnedIds)
    }
    collectOwnedIds(report.fixture)
    for (const row of report.cases) collectOwnedIds(row.saved)
    let cleanupTables = []
    const remainingReferences = {}
    const removedReferences = {}
    try {
        cleanupTables = sql(
            "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') and schemaname not like 'pg_%' order by 1",
        )
            .split('\n')
            .filter(Boolean)
        if (ownedIds.size) {
            const pattern = [...ownedIds].join('|')
            for (const table of cleanupTables) {
                const quoted = table
                    .split('.')
                    .map((part) => '"' + part.replaceAll('"', '""') + '"')
                    .join('.')
                const predicate = `to_jsonb(t)::text ~ '${pattern}'`
                const count = Number(sql(`select count(*) from ${quoted} t where ${predicate}`))
                if (count) {
                    removedReferences[table] = Number(
                        sql(
                            `with removed as (delete from ${quoted} t where ${predicate} returning 1) select count(*) from removed`,
                        ),
                    )
                }
            }
            for (const table of cleanupTables) {
                const quoted = table
                    .split('.')
                    .map((part) => '"' + part.replaceAll('"', '""') + '"')
                    .join('.')
                const count = Number(
                    sql(`select count(*) from ${quoted} t where to_jsonb(t)::text ~ '${pattern}'`),
                )
                if (count) remainingReferences[table] = count
            }
            assert.deepEqual(remainingReferences, {}, 'No owned references remain across any table')
        }
        report.businessAfterCleanup = fingerprints()
        assert.deepEqual(
            report.businessAfterCleanup,
            report.businessBeforeFixtures,
            'Cleanup preserves unrelated business and revision state',
        )
    } catch (error) {
        errors.push(String(error))
    }
    report.cleanup = {
        ownedIds: [...ownedIds],
        tablesScanned: cleanupTables,
        removedReferences,
        remainingReferences,
        errors,
        usersRemaining: users.length
            ? Number(
                  sql(
                      `select count(*) from auth.users where id in (${users.map((id) => "'" + id + "'").join(',')})`,
                  ),
              )
            : 0,
        leaguesRemaining: leagues.length
            ? Number(
                  sql(
                      `select count(*) from leagues where id in (${leagues.map((id) => "'" + id + "'").join(',')})`,
                  ),
              )
            : 0,
    }
    if (errors.length || report.cleanup.usersRemaining || report.cleanup.leaguesRemaining) {
        report.passed = false
        process.exitCode = 1
    }
    if (server && server.exitCode === null) {
        const done = new Promise((r) => server.once('exit', r))
        server.kill('SIGTERM')
        await done
    }
    await rm(live, { force: true })
    await rm(live + '.next', { force: true })
    report.ended = new Date().toISOString()
    await record()
    console.log(
        JSON.stringify({
            passed: report.passed,
            cases: report.cases.map((x) => ({ name: x.name, passed: x.passed })),
            failure: report.failure,
            cleanup: report.cleanup,
        }),
    )
}
