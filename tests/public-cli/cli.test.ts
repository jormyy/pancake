import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { run } from '../../packages/pancake-cli/bin/pancake.mjs'
import contract from '../../packages/pancake-cli/schemas/v1.json'
import fixture from '../fixtures/public-cli/league.json'
import { backupStatements } from '../e2e/public-cli.mjs'

const fixturePath = path.resolve('tests/fixtures/public-cli/league.json')
const token = 'a'.repeat(64)
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function invoke(args: string[], options: Record<string, unknown> = {}) {
  let stdout = '', stderr = ''
  const code = await run(args, { stdout: { isTTY: false, write: (value: string) => { stdout += value } },
    stderr: { write: (value: string) => { stderr += value } }, env: {}, ...options })
  return { code, stdout, stderr }
}
const body = { $schema: 'urn:pancake:public:v1:standings', version: 1, resource: 'standings', items: fixture.resources.standings.items, nextCursor: null }
describe('pancake CLI', () => {
  it.each(Object.keys(contract.resources))('reads %s from offline fixtures without a network request', async resource => {
    const result = await invoke([resource, '--fixture', fixturePath, ...(resource === 'rosters' ? ['--team', '11111111-1111-4111-8111-111111111111'] : [])], { fetch: () => { throw new Error('network forbidden') } })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).resource).toBe(resource)
    expect(result.stderr).toBe('')
  })
  it('runs the packaged entry without prompts', () => {
    const output = execFileSync(process.execPath, ['packages/pancake-cli/bin/pancake.mjs', 'standings', '--fixture', fixturePath], { encoding: 'utf8', timeout: 5000 })
    expect(JSON.parse(output).items).toHaveLength(2)
  })
  it('describes fields and explains nested fields offline', async () => {
    const described = await invoke(['describe', 'standings'])
    expect(JSON.parse(described.stdout).schemas.standings).toEqual(contract.resources.standings)
    const explained = await invoke(['explain', 'rosters.player.name'])
    expect(JSON.parse(explained.stdout).definition.description).toBe('Player display name.')
    expect((await invoke(['explain', 'standings.userId'])).code).toBe(2)
  })
  it('paginates and filters deterministic fixture output', async () => {
    const first = JSON.parse((await invoke(['standings', '--fixture', fixturePath, '--limit', '1'])).stdout)
    const second = JSON.parse((await invoke(['standings', '--fixture', fixturePath, '--limit', '1', '--cursor', first.nextCursor])).stdout)
    expect(first.items[0].rank).toBe(1)
    expect(second.items[0].rank).toBe(2)
    expect(second.nextCursor).toBeNull()
    const team = JSON.parse((await invoke(['standings', '--fixture', fixturePath, '--team', second.items[0].teamId])).stdout)
    expect(team.items).toEqual(second.items)
  })
  it('revalidates a cached page and keeps credentials out of the cache', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pancake-cache-'))
    temporary.push(directory)
    let calls = 0
    const fetcher = async (_url: string, init: RequestInit) => {
      calls++
      if (calls === 1) return Response.json(body, { headers: { ETag: '"one"' } })
      expect(new Headers(init.headers).get('if-none-match')).toBe('"one"')
      if (calls === 3) return new Response(null, { status: 401 })
      return new Response(null, { status: 304 })
    }
    const args = ['standings', '--api-url', 'http://127.0.0.1:58921/functions/v1/api', '--token', token, '--cache-dir', directory]
    const first = await invoke(args, { fetch: fetcher })
    const second = await invoke(args, { fetch: fetcher })
    expect(second).toEqual(first)
    expect(first.code).toBe(0)
    const [file] = await readdir(directory)
    expect(await readFile(path.join(directory, file), 'utf8')).not.toContain(token)
    expect(calls).toBe(2)
    const revoked = await invoke(args, { fetch: fetcher })
    expect(revoked.code).toBe(3)
    expect(revoked.stdout).toBe('')
  })
  it.each([[400, 2], [401, 3], [403, 3], [404, 4], [429, 5], [500, 7]])('maps HTTP %i to exit %i', async (status, code) => {
    const result = await invoke(['standings', '--api-url', 'http://localhost:58921', '--token', token, '--no-cache'], { fetch: async () => new Response('private backend error', { status }) })
    expect(result.code).toBe(code)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('private backend error')
  })
  it('distinguishes network errors and malformed responses', async () => {
    const args = ['standings', '--api-url', 'http://localhost:58921', '--token', token, '--no-cache']
    expect((await invoke(args, { fetch: () => { throw new Error(token) } })).code).toBe(6)
    expect((await invoke(args, { fetch: async () => Response.json({ ...body, private: token }) })).code).toBe(7)
    expect((await invoke(args, { fetch: async () => Response.json({ ...body, version: 2 }) })).code).toBe(7)
    expect((await invoke(args, { fetch: async () => new Response('invalid JSON') })).code).toBe(7)
    expect((await invoke(args, { fetch: async () => ({ ok: true, json: async () => { throw new DOMException('aborted', 'AbortError') } }) })).code).toBe(6)
  })
  it.each([['standings', '--token'], ['standings', '--limit', '0'], ['standings', '--limit', '51'], ['standings', '--week', '1'], ['standings', '--json', '--text'], ['delete'], ['rosters'], ['standings', '--unknown'], ['explain']])('rejects usage %j', async (...args) => {
    expect((await invoke(args)).code).toBe(2)
  })
  it('keeps operator health private and requires a connection', async () => {
    const result = await invoke(['db-health'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('private')
  })
})

it('restores only existing public tables and approved player lookups', () => {
  const data = ['public.players','private.player_game_memberships','auth.users','private.web_push_controls','public.removed_table','analytics.player_season_totals','analytics.search_cache_refresh_state'].map(name => {
    const [schema, table] = name.split('.')
    return `INSERT INTO "${schema}"."${table}" (id) VALUES (1);\n\n`
  }).join('')
  const selected = backupStatements(data, ['public.players','private.player_game_memberships','auth.users','private.web_push_controls','analytics.player_season_totals','analytics.search_cache_refresh_state'])
  expect(selected.map(row => `${row[1]}.${row[2]}`)).toEqual(['public.players','private.player_game_memberships','analytics.player_season_totals'])
})

it('keeps semicolons and blank lines inside restored text', () => {
  const statement = `INSERT INTO "public"."players" (name) VALUES ('name;\n\nwith ''quotes''');`
  expect(backupStatements(statement, ['public.players'])[0][0]).toBe(statement)
})
