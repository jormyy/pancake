import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { functionLifecycleEventsInSource, latestFunctionDefinitionsInSource, maskSqlNonCode } from '../scripts/check-db-function-sources.mjs'

const available = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { encoding: 'utf8' }).status === 0
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()

function releaseMigrations() {
    const deployed = new Set(git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations').split('\n'))
    const changed = new Set(git('diff', '--name-only', '--no-renames', 'origin/main', '--', 'supabase/migrations').split('\n'))
    return readdirSync('supabase/migrations').filter(file => file.endsWith('.sql'))
        .map(file => `supabase/migrations/${file}`).filter(file => !deployed.has(file) || changed.has(file))
        .sort().map(file => readFileSync(file, 'utf8'))
}

function sqlArguments(source: string, start: number) {
    const args: string[] = []
    let depth = 1, quoted = false, from = start
    for (let index = start; index < source.length; index++) {
        const char = source[index]
        if (char === "'") {
            if (quoted && source[index + 1] === "'") { index++; continue }
            quoted = !quoted
        }
        if (quoted) continue
        if (char === '(') depth++
        if (char === ')') depth--
        if (!depth || char === ',' && depth === 1) {
            args.push(source.slice(from, index).trim())
            from = index + 1
            if (!depth) return args
        }
    }
    throw new Error('Unclosed Edge dispatch arguments')
}

function dispatchedBodies(source: string) {
    return [...source.matchAll(/\b(public\.invoke_edge_function|private\.invoke_claimed_edge_function)\s*\(/g)].flatMap(match => {
        const args = sqlArguments(source, match.index + match[0].length)
        const offset = match[1].startsWith('private.') ? 1 : 0
        const name = args[offset]?.match(/^'([a-z][a-z0-9-]*)'$/)?.[1]
        if (!name) return []
        const expression = args[offset + 1]
        if (!expression) return [{ name, body: {} }]
        const literal = expression.match(/^'([^']*)'\s*::jsonb$/)?.[1]
        if (literal) return [{ name, body: JSON.parse(literal) as Record<string, unknown> }]
        const builder = expression.match(/^jsonb_build_object\s*\(/i)
        if (!builder) throw new Error(`Unknown Edge body for ${name}: ${expression}`)
        const fields = sqlArguments(expression, builder[0].length)
        const body: Record<string, unknown> = {}
        for (let index = 0; index < fields.length; index += 2) {
            const key = fields[index].match(/^'([^']*)'$/)?.[1]
            if (!key) throw new Error(`Unknown Edge body field for ${name}: ${fields[index]}`)
            body[key] = fields[index + 1]?.match(/^'([^']*)'$/)?.[1] ?? null
        }
        return [{ name, body }]
    })
}

function ignoredBodyFields(source: string, body: Record<string, unknown>) {
    return Object.entries(body).filter(([key, value]) => {
        const reads = new RegExp(`\\.${key}\\b|["']${key}["']\\s*\\]|\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=`).test(source)
        const selector = !['mode', 'view'].includes(key) || typeof value !== 'string' || source.includes(`'${value}'`) || source.includes(`"${value}"`)
        return !/\.json\s*\(/.test(source) || !reads || !selector
    }).map(([key]) => key)
}

it.skipIf(!available)('dispatches bodies supported by the deployed Edge handlers during database-first rollout', () => {
    const paths = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/functions').split('\n')
    const handlers = new Map<string, string>()
    const sql = [...releaseMigrations(), ...canonicalDefinitions().values()].join('\n')
    const incompatible = dispatchedBodies(sql).flatMap(({ name, body }) => {
        const path = `supabase/functions/${name}/index.ts`
        if (!paths.includes(path) || !Object.keys(body).length) return []
        if (!handlers.has(name)) handlers.set(name, git('show', ...paths.filter(file =>
            file.startsWith(`supabase/functions/${name}/`) && file.endsWith('.ts') && !file.endsWith('.test.ts')).map(file => `origin/main:${file}`)))
        return ignoredBodyFields(handlers.get(name)!, body).map(key => `${name}: ${key}`)
    })
    expect([...new Set(incompatible)]).toEqual([])
})

it('rejects a body selector ignored by a deployed Edge handler', () => {
    const sql = `SELECT private.invoke_claimed_edge_function('et:injuries','sync-players','{"mode":"injuries"}'::jsonb);`
    expect(dispatchedBodies(sql)).toEqual([{ name: 'sync-players', body: { mode: 'injuries' } }])
    expect(ignoredBodyFields('serveInternal(async () => syncAll())', { mode: 'injuries' })).toEqual(['mode'])
    expect(ignoredBodyFields('const body = await request.json(); if (body.mode === "injuries") syncInjuries()', { mode: 'injuries' })).toEqual([])
    expect(ignoredBodyFields('const body = await request.json(); if (body.mode === "other") syncOther()', { mode: 'injuries' })).toEqual(['mode'])
    expect(dispatchedBodies("SELECT public.invoke_edge_function('sync-stats', jsonb_build_object('mode','dispatcher'));")).toEqual([{ name: 'sync-stats', body: { mode: 'dispatcher' } }])
})

it.skipIf(!available)('keeps deployed Edge profile and receipt columns through the database phase', () => {
    const changes = releaseMigrations().map(source => maskSqlNonCode(source)).join('\n')
    const used = new Set(['profiles.push_token', 'profiles.push_token_revocation_hash',
        'notification_outbox.expo_ticket_id', 'notification_outbox.push_token',
        'notification_outbox.ticketed_at', 'notification_outbox.receipt_attempt_count'])
    const dropped = [...changes.matchAll(/ALTER\s+TABLE\s+(?:public\.)?(profiles|notification_outbox)\s+([^;]+);/gi)]
        .flatMap(statement => [...statement[2].matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_]+)/gi)]
            .map(column => `${statement[1]}.${column[1]}`)).filter(column => used.has(column))
    expect(dropped).toEqual([])
})

function duplicateVersions(files: string[]) {
    const byVersion = new Map<string, string[]>()
    for (const file of files.filter(file => file.endsWith('.sql'))) {
        const version = file.split('_')[0]
        byVersion.set(version, [...byVersion.get(version) ?? [], file])
    }
    return [...byVersion.values()].filter(files => files.length > 1)
}

function revertedDefinitions(migrations: string[], deployed: Map<string, string>, merged: Map<string, string>) {
    const release = latestFunctionDefinitionsInSource(migrations.join('\n'))
    return [...release].filter(([key, definition]) => deployed.has(key) && definition !== merged.get(key))
        .map(([key]) => key)
}

function canonicalDefinitions(revision?: string) {
    const files = revision
        ? git('ls-tree', '-r', '--name-only', revision, '--', 'supabase/sql/functions').split('\n')
        : readdirSync('supabase/sql/functions/by-name', { recursive: true })
            .map(file => `supabase/sql/functions/by-name/${file}`)
    const sqlFiles = files.filter(file => file.endsWith('.sql'))
    return latestFunctionDefinitionsInSource(revision
        ? git('show', ...sqlFiles.map(file => `${revision}:${file}`))
        : sqlFiles.map(file => readFileSync(file, 'utf8')).join('\n'))
}

it('requires origin/main when CI runs release compatibility checks', () => {
    expect(!process.env.CI || available, 'CI must fetch origin/main before checking deployed Edge compatibility').toBe(true)
})

it('rejects duplicate migration versions', () => {
    expect(duplicateVersions(readdirSync('supabase/migrations'))).toEqual([])
    expect(duplicateVersions(['20261024000001_main.sql', '20261024000001_release.sql']))
        .toEqual([['20261024000001_main.sql', '20261024000001_release.sql']])
})

it.skipIf(!available)('keeps merged bodies when release migrations redefine deployed functions', () => {
    expect(revertedDefinitions(releaseMigrations(), canonicalDefinitions('origin/main'), canonicalDefinitions()),
        'A release migration replaces a deployed function without the merged canonical body').toEqual([])
})

it('detects a release definition that would revert main', () => {
    const statement = (value: number) => `CREATE OR REPLACE FUNCTION public.shared_release_function() RETURNS integer LANGUAGE sql AS $$ SELECT ${value}; $$;`
    const deployed = latestFunctionDefinitionsInSource(statement(2))
    const merged = latestFunctionDefinitionsInSource(statement(3))
    expect(revertedDefinitions([statement(1)], deployed, merged)).toEqual(['public.shared_release_function'])
    expect(revertedDefinitions([statement(1), statement(3)], deployed, merged)).toEqual([])
})

function subscribedTables(source: string) {
    const direct = [...source.matchAll(/\.on\(\s*['"]postgres_changes['"]\s*,\s*\{[^}]*?\btable\s*:\s*['"]([a-z_]+)['"]/g)]
        .map(match => match[1])
    const watches = [...source.matchAll(/\bwatches\s*:\s*\[([\s\S]*?)\]/g)]
        .flatMap(match => [...match[1].matchAll(/\btable\s*:\s*['"]([a-z_]+)['"]/g)].map(table => table[1]))
    return new Set([...direct, ...watches])
}

function droppedSubscribedTables(migrations: string[], subscribed: Set<string>) {
    return migrations.flatMap(source => [...maskSqlNonCode(source).matchAll(/ALTER\s+PUBLICATION\s+supabase_realtime\s+DROP\s+TABLE\s+([^;]+);/gi)]
        .flatMap(statement => statement[1].split(',').map(table => table.trim().replace(/^public\./, '')))
        .filter(table => subscribed.has(table)))
}

it.skipIf(!available)('keeps deployed client subscriptions in the Realtime publication', () => {
    const files = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'app', 'components', 'contexts', 'hooks', 'lib').split('\n')
        .filter(file => /\.tsx?$/.test(file))
    const subscribed = subscribedTables(git('show', ...files.map(file => `origin/main:${file}`)))
    expect(droppedSubscribedTables(releaseMigrations(), subscribed)).toEqual([])
})

it('detects publication drops used by the deployed client', () => {
    const subscribed = subscribedTables(`channel.on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_lineups' }, refresh)`)
    expect([...subscribedTables(`subscribeToTableChanges('roster', { watches: [{ table: 'waiver_claims' }] })`)]).toEqual(['waiver_claims'])
    expect(droppedSubscribedTables(['ALTER PUBLICATION supabase_realtime DROP TABLE public.weekly_lineups, public.bids;'], subscribed))
        .toEqual(['weekly_lineups'])
    expect(droppedSubscribedTables(['ALTER PUBLICATION supabase_realtime DROP TABLE public.bids;'], subscribed)).toEqual([])
})

const rpcNameCache = new Map<string, Set<string>>()

function rpcNames(source: string) {
    const cached = rpcNameCache.get(source)
    if (cached) return cached
    const file = ts.createSourceFile('consumer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const program = ts.createProgram(['consumer.tsx'], { noLib: true, noResolve: true }, {
        getSourceFile: name => name === file.fileName ? file : undefined,
        getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
        getDirectories: () => [], fileExists: name => name === file.fileName,
        readFile: name => name === file.fileName ? source : undefined,
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    })
    const checker = program.getTypeChecker()
    const names = new Set<string>()
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rpc') {
            const argument = node.arguments[0]
            const type = argument && checker.getTypeAtLocation(argument)
            const values = type?.isUnion() ? type.types : type ? [type] : []
            if (!values.length || values.some(value => !value.isStringLiteral())) {
                throw new Error(`Unknown non-literal RPC: ${argument?.getText(file) ?? '<missing>'}`)
            }
            for (const value of values) if (value.isStringLiteral()) names.add(`public.${value.value}`)
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    rpcNameCache.set(source, names)
    return names
}

function parameters(definition: string) {
    const source = maskSqlNonCode(definition)
    const open = source.indexOf('(')
    const segments: string[] = []
    let depth = 1, start = open + 1
    for (let index = start; index < source.length; index++) {
        if (source[index] === '(') depth++
        if (source[index] === ')') depth--
        if (depth === 0 || source[index] === ',' && depth === 1) {
            segments.push(definition.slice(start, index).trim())
            start = index + 1
            if (depth === 0) break
        }
    }
    return segments.filter(Boolean).filter(segment => !/^OUT\b/i.test(segment)).map(segment => {
        const declaration = segment.replace(/^(?:IN|INOUT|VARIADIC)\s+/i, '')
        const [name, ...type] = declaration.split(/\s+/)
        return { name, type: type.join(' ').replace(/\s+(?:DEFAULT|=)[\s\S]*$/i, '').toLowerCase()
            .replace(/\bint\b/g, 'integer').replace(/\bbool\b/g, 'boolean'), optional: /\s(?:DEFAULT\s|=)/i.test(declaration) }
    })
}

function returns(definition: string) {
    return definition.match(/\bRETURNS\s+([\s\S]*?)(?=\b(?:LANGUAGE|AS|SECURITY|STABLE|IMMUTABLE|VOLATILE|PARALLEL|COST|ROWS|SET)\b)/i)?.[1]
        .toLowerCase().replace(/\bint\b/g, 'integer').replace(/\bbool\b/g, 'boolean').replace(/\s+/g, '')
}

function brokenRpcContracts(sources: string[], deployed: Map<string, string>, merged: Map<string, string>) {
    const called = new Set(sources.flatMap(source => [...rpcNames(source)]))
    return [...deployed].filter(([key]) => called.has(key.split('(')[0])).filter(([key, definition]) => {
        const oldParameters = parameters(definition)
        const replacements = [...merged].filter(([nextKey]) => nextKey.split('(')[0] === key.split('(')[0])
        const candidates = replacements.filter(([, nextDefinition]) => parameters(nextDefinition)
            .every(next => next.optional || oldParameters.some(old => !old.optional && old.name === next.name && old.type === next.type)))
        if (candidates.length > 1 && candidates.some(([, candidate]) => ![...deployed].some(([oldKey, oldDefinition]) =>
            oldKey.split('(')[0] === key.split('(')[0] && JSON.stringify(parameters(oldDefinition)) === JSON.stringify(parameters(candidate))))) return true
        return !replacements.some(([, nextDefinition]) => {
            const nextParameters = parameters(nextDefinition)
            const oldReturn = returns(definition)
            const nextReturn = returns(nextDefinition)
            const compatibleReturn = oldReturn === nextReturn || oldReturn?.startsWith('table(') && nextReturn?.startsWith(`${oldReturn.slice(0, -1)},`)
            return compatibleReturn
                && oldParameters.every((old, index) => nextParameters[index]?.name === old.name && nextParameters[index]?.type === old.type)
                && nextParameters.every(next => next.optional || oldParameters.some(old => old.name === next.name && !old.optional))
        })
    }).map(([key]) => key)
}

it.skipIf(!available)('preserves deployed Edge and client RPC argument contracts', () => {
    const files = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/functions', 'app', 'components', 'contexts', 'hooks', 'lib')
        .split('\n').filter(file => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
    const deployed = canonicalDefinitions('origin/main')
    const merged = canonicalDefinitions()
    for (const group of ['supabase/functions/', 'client']) {
        const selected = files.filter(file => group === 'client' ? !file.startsWith('supabase/') : file.startsWith(group))
        const sources = [git('show', ...selected.map(file => `origin/main:${file}`))]
        expect(brokenRpcContracts(sources, deployed, merged), `${group} RPC contracts`).toEqual([])
    }
})

it('rejects a replacement RPC with a new required argument', () => {
    const deployed = latestFunctionDefinitionsInSource('CREATE FUNCTION public.offer(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    const broken = latestFunctionDefinitionsInSource('CREATE FUNCTION public.offer(p_id uuid, p_required text) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    expect(brokenRpcContracts(["db.rpc('offer', { p_id: id })"], deployed, broken)).toEqual(['public.offer'])
    const compatible = latestFunctionDefinitionsInSource("CREATE FUNCTION public.offer(p_id uuid, p_required text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$ SELECT; $$;")
    expect(brokenRpcContracts(["db.rpc('offer', { p_id: id })"], deployed, compatible)).toEqual([])
})

it('checks client-only RPC calls as well as Edge calls', () => {
    const deployed = latestFunctionDefinitionsInSource('CREATE FUNCTION public.client_only(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    expect(brokenRpcContracts(["db.rpc('edge_only')"], deployed, new Map())).toEqual([])
    expect(brokenRpcContracts(["db.rpc('client_only', { p_id: id })"], deployed, new Map())).toEqual(['public.client_only'])
})

it('collects dynamic RPC string unions', () => {
    expect([...rpcNames("function toggle(name: 'toggle_ir_atomic' | 'toggle_taxi_atomic') { return db.rpc(name) }")].sort())
        .toEqual(['public.toggle_ir_atomic', 'public.toggle_taxi_atomic'])
})

it('rejects an unknown dynamic RPC name', () => {
    expect(() => rpcNames('function unknown(name: string) { return db.rpc(name) }')).toThrow(/Unknown non-literal RPC/)
})

it('rejects a new overload that accepts deployed required arguments', () => {
    const deployed = latestFunctionDefinitionsInSource('CREATE FUNCTION public.offer(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;')
    const ambiguous = latestFunctionDefinitionsInSource(`CREATE FUNCTION public.offer(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT; $$;
        CREATE FUNCTION public.offer(p_id uuid,p_optional text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$ SELECT; $$;`)
    expect(brokenRpcContracts(["db.rpc('offer', { p_id: id })"], deployed, ambiguous)).toEqual(['public.offer'])
})

it('rejects a changed return contract and accepts normalized return types', () => {
    const definition = (returns: string) => latestFunctionDefinitionsInSource(`CREATE FUNCTION public.offer(p_id uuid) RETURNS ${returns} LANGUAGE sql AS $$ SELECT; $$;`)
    expect(brokenRpcContracts(["db.rpc('offer')"], definition('TABLE (id uuid, count integer)'), definition('TABLE (id uuid, count text)')))
        .toEqual(['public.offer'])
    expect(brokenRpcContracts(["db.rpc('offer')"], definition('TABLE (id uuid, count integer)'), definition('table(id uuid,count int)'))).toEqual([])
})

function deployedHintReceiver() {
    const source = 'const onSessionCachesCleared = () => {};\n' + git('show', 'origin/main:lib/league-changes.ts').replace(/^import .*$/gm, '')
    const exports: Record<string, unknown> = {}
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, onSessionCachesCleared: () => {} })
    return exports.leagueChangeReceiver as (league: string, receive: (change: Record<string, unknown>) => void) => (row: Record<string, unknown>) => boolean
}

it.skipIf(!available)('emits only hint topics and inventory resources accepted by the deployed client', () => {
    const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()
        .map(file => readFileSync(`supabase/migrations/${file}`, 'utf8')).join('\n')
    const check = [...migrations.matchAll(/ADD\s+CONSTRAINT\s+league_change_hints_topic_check\s+CHECK\s*\(topic\s+IN\s*\(([^)]+)\)/gi)].at(-1)!
    const topics = [...check[1].matchAll(/'([^']+)'/g)].map(match => match[1])
    const emitter = readFileSync('supabase/sql/functions/by-name/private/emit_league_inventory_change.sql', 'utf8')
    const resources = [...new Set([...emitter.matchAll(/'resource'\s*,\s*'([^']+)'/g)].map(match => match[1]))]
    const league = '11111111-1111-4111-8111-111111111111'
    const season = '22222222-2222-4222-8222-222222222222'
    const receiver = deployedHintReceiver()
    for (const topic of topics) {
        const fixtures = topic === 'version' ? [
            [{ version: '1', topic: 'roster', scope: { league_id: league }, created_at: '2026-10-27T00:00:00Z' }],
            [{ version: '1', topic: 'roster', scope: {}, created_at: '2026-10-27T12:00:00Z' }],
            [{ version: '1', topic: 'roster', scope: { season_id: season }, created_at: '2026-10-27T12:00:00Z' }],
        ] : [null]
        for (const details of fixtures) {
            const consume = receiver(league, () => {})
            expect.soft(consume({ league_id: league, topic, revision: 1, scopes: null, details }), topic).toBe(true)
        }
    }
    for (const resource of resources) {
        const changes: Record<string, unknown>[] = []
        const consume = receiver(league, change => changes.push(change))
        const details = [{ resource, season_id: season, ...(['picks', 'priority', 'faab'].includes(resource) ? { member_id: season } : {}) }]
        for (const revision of [1, 2]) consume({ league_id: league, topic: 'inventory', revision, scopes: null, details })
        expect.soft(changes.at(-1)?.details, resource).toEqual(details)
    }
})

function documentedProductionHead(notes: string) {
    return notes.match(/(?:Production currently stops at migration|The supplied production head is) `([0-9]+)`/)?.[1]
}

function requiresDatabaseFirst(mainMigrations: string, clientSource: string, notes: string, newestMigration: string) {
    const section = notes.match(/^## Release order for this release\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
    const productionHead = section ? documentedProductionHead(section) : undefined
    if (!section || !productionHead || newestMigration > productionHead && !section.includes(newestMigration)) return true
    const functions = latestFunctionDefinitionsInSource(mainMigrations)
    const newRpc = [...rpcNames(clientSource)].some(name => !functions.has(name))
    const newColumns = ['waiver_claims.to_ir', 'waiver_claims.to_taxi', 'player_game_stats.is_home'].some(column => {
        const [table, name] = column.split('.')
        return clientSource.includes(name) && !new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${table}[\\s\\S]*?ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'i').test(mainMigrations)
    })
    const irArgument = clientSource.includes('p_to_ir') && !parameters(functions.get('public.add_free_agent_atomic') ?? '()').some(parameter => parameter.name === 'p_to_ir')
    return (newRpc || newColumns || irArgument) && !section.includes('Database, then Edge, then merge the frontend.')
}

it.skipIf(!available)('documents database-first release order for new client dependencies', () => {
    const baseNotes = readFileSync('supabase/RELEASE-DB.md', 'utf8')
    const publicNotes = readFileSync('docs/public-cli.md', 'utf8')
        .match(/^## Public CLI release order\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const playerReadNotes = readFileSync('docs/db-health.md', 'utf8')
        .match(/^## Player read release order\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const tradeReceiptNotes = readFileSync('docs/trade-receipts.md', 'utf8')
        .match(/^## Trade receipt release order\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const statsCertificationNotes = readFileSync('docs/live-scoring-inactive-certification.md', 'utf8')
        .match(/^## Stats certification release order\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const notes = baseNotes.replace(/^## Release order for this release\n/m, `## Release order for this release\n${publicNotes}\n${playerReadNotes}\n${tradeReceiptNotes}\n${statsCertificationNotes}\n`)
    const productionHead = documentedProductionHead(notes) ?? ''
    const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()
    const newest = migrations.at(-1)!.split('_')[0]
    const main = migrations.filter(file => file.split('_')[0] <= productionHead)
        .map(file => readFileSync(`supabase/migrations/${file}`, 'utf8')).join('\n')
    const files = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'app', 'components', 'contexts', 'hooks', 'lib').split('\n').filter(file => /\.tsx?$/.test(file))
    const source = files.filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8')).join('\n')
    expect(requiresDatabaseFirst(main, source, notes, newest)).toBe(false)
    expect(requiresDatabaseFirst(main, source, notes.replace(/^## Release order for this release$/m, '## Removed'), newest)).toBe(true)
    expect(requiresDatabaseFirst(main, source, notes.replaceAll(newest, 'removed'), newest)).toBe(true)
    expect(requiresDatabaseFirst(main, source, notes.replaceAll(productionHead, 'missing'), newest)).toBe(true)
})

function droppedObjectCalls(migration: string, consumers: { file: string; source: string; quotedNames?: boolean }[]) {
    const replaced = new Set([...latestFunctionDefinitionsInSource(migration).keys()].map(key => key.split('(')[0]))
    const functions = functionLifecycleEventsInSource(migration).filter(event => event.type === 'drop' && !replaced.has(event.key.split('(')[0])).map(event => event.key.split('.')[1])
    const tables = [...maskSqlNonCode(migration).matchAll(/(?:^|;)\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi)]
        .flatMap(match => match[1].replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '').split(','))
        .map(name => name.trim().split('.').at(-1)!)
    return consumers.flatMap(({ file, source, quotedNames }) => [
        ...functions.filter(name => quotedNames && source.match(new RegExp(`[\x27\x22\x60]${name}[\x27\x22\x60]`)) || !quotedNames && rpcNames(source).has(`public.${name}`) || new RegExp(`(?:\\.rpc\\(\\s*['"]${name}['"]|\\b(?:public\\.|private\\.)?${name}\\s*\\()`).test(source)).map(name => `${file}: function ${name}`),
        ...tables.filter(name => quotedNames && source.match(new RegExp(`[\x27\x22\x60]${name}[\x27\x22\x60]`)) || new RegExp(`(?:\\.from\\(\\s*['"]${name}['"]|\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:public\\.)?${name}\\b)`, 'i').test(source)).map(name => `${file}: table ${name}`),
    ])
}

function retainedCronCommands(deployed: string, upgrade: string) {
    const jobs = new Map<string, string>()
    for (const match of `${deployed}\n${upgrade}`.matchAll(/\bcron\.(?:schedule\s*\([\s\S]*?\);|unschedule\s*\([^;]+;)/gi)) {
        if (/^cron\.schedule/i.test(match[0])) {
            const name = match[0].match(/^cron\.schedule\s*\(\s*'([^']+)'/i)?.[1]
            if (name) jobs.set(name, match[0])
            continue
        }
        const names = match[0].match(/jobname\s+IN\s*\(([^)]+)\)/i)?.[1]
            ?? match[0].match(/jobname\s*=\s*('(?:''|[^'])*')/i)?.[1]
            ?? match[0].match(/^cron\.unschedule\(\s*('(?:''|[^'])*')/i)?.[1]
        for (const name of names?.matchAll(/'((?:''|[^'])*)'/g) ?? []) jobs.delete(name[1])
    }
    return [...jobs.values()].join('\n')
}

it('checks retained cron calls and permits jobs removed by the same upgrade', () => {
    const cron = "SELECT cron.schedule('old', '* * * * *', 'SELECT public.retired_call()');"
    const drop = 'DROP FUNCTION public.retired_call();'
    expect(droppedObjectCalls(drop, [{ file: 'cron', source: retainedCronCommands(cron, '') }])).toEqual(['cron: function retired_call'])
    const upgrade = "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('old');"
    expect(droppedObjectCalls(drop, [{ file: 'cron', source: retainedCronCommands(cron, upgrade) }])).toEqual([])
    expect(droppedObjectCalls(drop, [{ file: 'cron', source: retainedCronCommands(cron, upgrade.replace("'old'", "'other'")) }])).toEqual(['cron: function retired_call'])
    expect(droppedObjectCalls(drop, [{ file: 'cron', source: retainedCronCommands(`${cron}\n${upgrade}`, '') }])).toEqual([])
    expect(droppedObjectCalls(drop, [{ file: 'cron', source: retainedCronCommands(cron, `${upgrade}\n${cron}`) }])).toEqual(['cron: function retired_call'])
})

it('keeps historical benchmark callers tied to their historical migration fixtures', () => {
    const source = readFileSync('scripts/bench/pre-tipoff.ts', 'utf8')
    expect(source).toContain("side === 'old' ? '20260814000003_gate_lineup_optimizer_cron.sql' : '20261014000001_pre_tipoff_lineups.sql'")
    expect(readFileSync('scripts/bench/README.md', 'utf8')).toContain('-f supabase/migrations/20261014000001_pre_tipoff_lineups.sql')
    const report = readFileSync('scripts/bench/report-metrics.ts', 'utf8')
    expect(report).toContain('Deno.readTextFile')
    expect(report).not.toMatch(/\.unsafe\(|\.rpc\(|execFile|spawn|Deno\.Command/)
})

it.skipIf(!available)('keeps objects used by deployed consumers and release tooling through the server migration', () => {
    const paths = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/functions', 'app', 'components', 'contexts', 'hooks', 'lib').split('\n')
        .filter(file => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
    const consumers: { file: string; source: string; quotedNames?: boolean }[] = ['supabase/functions/', 'client'].map(group => ({ file: group,
        source: git('show', ...paths.filter(file => group === 'client' ? !file.startsWith('supabase/') : file.startsWith(group)).map(file => `origin/main:${file}`)),
    }))
    const migrations = git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations').split('\n').filter(file => file.endsWith('.sql'))
    const cron = retainedCronCommands(git('show', ...migrations.map(file => `origin/main:${file}`)), releaseMigrations().join('\n'))
    consumers.push({ file: 'cron', source: cron })
    for (const root of ['tests/e2e', 'scripts', '.github/workflows']) {
        for (const entry of readdirSync(root, { recursive: true })) {
            const file = `${root}/${entry}`
            if (/\.(?:[cm]?[jt]sx?|ya?ml|sh)$/.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file) && !['scripts/bench/pre-tipoff.ts', 'scripts/bench/report-metrics.ts'].includes(file)) consumers.push({ file, source: readFileSync(file, 'utf8'), quotedNames: true })
        }
    }
    expect(releaseMigrations().flatMap(migration => droppedObjectCalls(migration, consumers))).toEqual([])
})

it('detects removed functions and tables used by each deployed consumer', () => {
    const migration = 'DROP FUNCTION public.retired_call(); DROP TABLE public.retired_rows;'
    expect(droppedObjectCalls(migration, [
        { file: 'Edge', source: "db.rpc('retired_call')" },
        { file: 'client', source: "db.from('retired_rows').select('*')" },
        { file: 'cron', source: "SELECT cron.schedule('job','* * * * *','SELECT public.retired_call();');" },
    ])).toEqual(['Edge: function retired_call', 'client: table retired_rows', 'cron: function retired_call'])
})

it('keeps queued notification replacements equal to their current sources without Expo storage', () => {
    const notes = readFileSync('supabase/RELEASE-DB.md', 'utf8')
    const queued = latestFunctionDefinitionsInSource([...notes.slice(notes.indexOf('## Next release')).matchAll(/```sql\n([\s\S]*?)```/g)].map(match => match[1]).join('\n'))
    for (const name of ['public.claim_notification_outbox_atomic', 'private.enqueue_process_trades']) {
        const source = readFileSync(`supabase/sql/functions/by-name/${name.replace('.', '/')}.sql`, 'utf8')
        const expected = latestFunctionDefinitionsInSource(withoutExpoQueue(source)).get(name)
        expect(queued.get(name), name).toBe(expected)
    }
})

function withoutExpoQueue(source: string) {
    return source.replace(/ OR EXISTS \(\s*SELECT 1 FROM public\.notification_outbox queued\s*WHERE queued\.suppressed_at IS NULL\s*AND queued\.delivered_at IS NULL[\s\S]*?queued\.expo_ticket_id IS NOT NULL[\s\S]*?\n  \)(?= THEN)/, '')
        .replace(/^[ \t]*AND queued\.expo_ticket_id IS NULL\n/gm, '')
        .replace(/ AND queued\.expo_ticket_id IS NULL/g, '')
}


it('preserves positional arguments and permits appended search columns', () => {
    const definition = (args: string, result = 'void') => latestFunctionDefinitionsInSource(`CREATE FUNCTION public.offer(${args}) RETURNS ${result} LANGUAGE sql AS $$ SELECT; $$;`)
    const deployed = definition('p_id uuid, p_ir boolean DEFAULT false')
    expect(brokenRpcContracts(["db.rpc('offer')"], deployed, definition('p_id uuid, p_ir boolean DEFAULT false, p_taxi boolean DEFAULT false'))).toEqual([])
    expect(brokenRpcContracts(["db.rpc('offer')"], deployed, definition('p_id uuid, p_taxi boolean DEFAULT false, p_ir boolean DEFAULT false'))).toEqual(['public.offer'])
    expect(brokenRpcContracts(["db.rpc('offer')"], definition('p_id uuid', 'TABLE(id uuid)'), definition('p_id uuid', 'TABLE(id uuid, career_regular_season_games int)'))).toEqual([])
})

it('detects quoted dropped names in release scripts and workflows', () => {
    expect(droppedObjectCalls('DROP TABLE public.retired_rows, analytics.old_totals; DROP FUNCTION public.retired_call();', [
        { file: 'tests/e2e/health.mjs', source: "const tables = ['retired_rows']", quotedNames: true },
        { file: '.github/workflows/release.yml', source: "run: check 'retired_call'", quotedNames: true },
        { file: 'scripts/bench.mjs', source: "db.schema('analytics').from('old_totals')", quotedNames: true },
    ])).toEqual(['tests/e2e/health.mjs: table retired_rows', '.github/workflows/release.yml: function retired_call', 'scripts/bench.mjs: table old_totals'])
})
